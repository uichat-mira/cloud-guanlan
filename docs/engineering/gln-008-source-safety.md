# GLN-008 · 新闻来源安全准入与受控采集边界

> 任务契约：[Issue #15](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/15)。
> 交付范围：GLN-008 通过 [PR #19](https://github.com/uichat-mira/cloud-mcp-guanlan/pull/19) 向 `dev` 交付代码、T1/T2/T3 测试及本文；**未部署、未开启生产或隔离 Canary Cron，也未以本卡执行真实公网源批量抓取**。本卡只建立 B1 的安全准入基础，不等于建成通用新闻源发现平台。

## 1. 决策摘要

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 纯 URL 策略 | `src/source-safety.ts` | 无 I/O 的 fail-closed 判定：scheme、userinfo、主机/IP 字面量、端口、特殊用途域名、精确白名单 |
| 批准清单 | `src/source-allowlist.ts` | 唯一可审查的公共 Feed URL 白名单；编译进 bundle，无运行时写入路径 |
| 执行层 | `src/ingest.ts:fetchLimited` | 先调用同一策略，再以 `redirect: "manual"`、流式大小限制和统一 wall deadline 抓取 |
| 登记合同 | `src/source-registry.ts` | 只登记白名单来源，复用 `poc_sources.url UNIQUE`，重复批准不产生第二个采集任务 |

**核心结论：** 由于无法在现有 Workers 运行时证明任意域名的最终出站 IP 不会被 DNS 重绑定，本阶段采用**维护者批准的公共 Feed URL 白名单**，未批准来源默认拒绝。URL 字符串校验只用于拒绝明显非法/歧义输入并收窄已批准目标，**不是完整 SSRF 防护**，也不宣称已经实现通用 SSRF 安全。

## 2. Cloudflare Workers 运行时能力与限制

本卡不允许部署生产，因此这一节区分「官方运行时文档明确支持/不支持的 API」与「本地 workerd 能证明的行为」；两者都不等于生产环境验收。

| 能力 | 结论 | 依据 |
| --- | --- | --- |
| 手动拒绝重定向 | `Request` 支持 `redirect: "manual"`；Workers **不实现** Fetch 标准的 `error` 模式，构造时即抛 `TypeError`。采集代码使用 `manual` 并自行拒绝 3xx | [Workers Request](https://developers.cloudflare.com/workers/runtime-apis/request/) |
| 观察或固定任意第三方域名的解析 IP | **没有公开 API**。`fetch()` 不暴露解析结果，也没有「先解析、再按 IP 连接」的入口 | [Workers Request](https://developers.cloudflare.com/workers/runtime-apis/request/)、[Fetch](https://developers.cloudflare.com/workers/runtime-apis/fetch/) |
| `cf.resolveOverride` 固定出站 IP | 仅当 URL host 与 override host **都在调用者自己的 Cloudflare zone 内**才生效；跨 zone 会被忽略。不能用于把任意公共 Feed 域名钉到已校验 IP | [Workers Request](https://developers.cloudflare.com/workers/runtime-apis/request/) |
| 私网/loopback/链路本地出站是否被平台阻断 | 没有可依赖的公开合同；本卡**不把**任何未文档化的网络行为当作安全保证 | 同上（未找到相关 API/保证） |
| 本地 workerd 证明 DNS/最终 IP | 不能。本地 workerd/Miniflare 的出站由测试 fixture 接管，不执行真实 DNS，也不代表生产出站路径 | 本卡 T3 设计 |
| 本地 workerd 证明 redirect/大小/超时 | 能，且已纳入 `npm run check` | 本卡 T3 |

**因此：** 不采用「先 DNS 查询一次再 `fetch`」的 TOCTOU 假防护，也不引入第三方 DNS 代理、安全服务或付费依赖。受控准入是当前唯一可诚实交付的闸门；批准域名的 DNS 被攻陷后解析到私网地址这一残余风险，只能由后续真实运行时能力（或平台合同）解决，见第 7 节。

## 3. 接受 / 拒绝矩阵

`evaluateSourceUrl` 的判定顺序与错误码（错误码是持久化到 `poc_sources.last_error` 的唯一内容，不包含原始 URL）：

| 类别 | 示例 | 结果 | 安全错误码 |
| --- | --- | --- | --- |
| 已批准公共 Feed | `https://developers.cloudflare.com/changelog/rss/index.xml` | 接受 | — |
| 大小写 / 默认端口 / fragment | `HTTPS://WWW.CloudflareStatus.COM:443/history.atom#top` | 接受并规范化 | — |
| 非 HTTPS | `http:`、`ftp:`、`file:`、`data:`、`javascript:`、`ws:`、`wss:` | 拒绝 | `source_scheme_rejected` |
| 相对/协议相对 URL | `/feed`、`//host/feed` | 拒绝 | `source_url_invalid` |
| 用户名/密码（含空 userinfo） | `https://user:pass@host/`、`https://@host/`、`https://user%40x@host/` | 拒绝 | `source_userinfo_rejected` |
| localhost / 单标签主机 | `https://localhost/`、`https://intranet/` | 拒绝 | `source_host_rejected` |
| 特殊用途/私有 DNS 后缀 | `.localhost`、`.local`、`.internal`、`.home.arpa`、`.lan`、`.corp`、`.test`、`.invalid`、`.example`、`.onion` | 拒绝 | `source_host_rejected` |
| 末尾点主机 | `https://developers.cloudflare.com./...` | 拒绝（不静默归一化） | `source_host_rejected` |
| 私有/保留/环回/链路本地 IPv4 | `127.0.0.1`、`10.0.0.1`、`172.16.0.1`、`192.168.0.1`、`169.254.169.254`、`100.64.0.1`、`198.51.100.1`、`203.0.113.1`、`0.0.0.0`、`224.0.0.1`、`255.255.255.255` | 拒绝 | `source_private_address` |
| 混淆 IPv4 写法 | `127.1`、`2130706433`、`0x7f000001`、`0177.0.0.1`（WHATWG 解析器先归一化为 `127.0.0.1`） | 拒绝 | `source_private_address` |
| 公网 IP 字面量 | `8.8.8.8`、`1.1.1.1`、`172.32.0.1` | 拒绝（白名单只接受域名 URL） | `source_ip_literal_rejected` |
| 非公网 IPv6 | `[::1]`、`[::]`、`[fe80::1]`、`[fc00::1]`、`[ff02::1]`、`[::ffff:127.0.0.1]`、`[2001:db8::1]`、`[2002::1]`、`[64:ff9b::1.1.1.1]` | 拒绝 | `source_private_address` |
| 公网 IPv6 字面量 | `[2606:4700::1111]`、`[::ffff:8.8.8.8]` | 拒绝 | `source_ip_literal_rejected` |
| 非 443 端口 | `https://host:8443/`、`:80`、`:3000` | 拒绝 | `source_port_rejected` |
| 未批准的 host / path / query | `https://example.com/rss.xml`、已批准 host 的其它路径、额外 query、尾斜杠 | 拒绝 | `source_not_approved` |
| IDN / 同形异义 | `https://bücher.de/feed`、西里尔字母 `exаmple.com`、`xn--...` | 拒绝（规范化后不在白名单） | `source_not_approved` |
| 非法/歧义输入 | 空串、首尾空白、控制字符、超长（>2048）、无法解析、非字符串 | 拒绝 | `source_url_invalid` |

执行层对**已批准 URL** 的响应约束：

| 上游行为 | 结果 | 安全错误码 |
| --- | --- | --- |
| 301/302/307/308 | 不跟随；`Location` 不会被请求 | `unsupported_redirect` |
| `Content-Length` 声明超过 128 KiB | 读取正文前拒绝 | `feed_too_large` |
| 无 `Content-Length` 但流式正文超过 128 KiB | 读取过程中拒绝并取消 reader | `feed_too_large` |
| 声明长度小于实际流式字节（伪造/截断之外的异常） | 以真实流式字节数为准 | `feed_too_large` |
| 慢响应头或慢正文超过 8s 总预算 | 中止并取消 reader | `fetch_timeout` |
| 非 2xx | 只记录状态码 | `feed_http_<status>` |
| 空正文 / 空 Feed / 解析失败 | 拒绝且不写新闻 | `empty_body` / `empty_feed` / `fetch_or_parse_error` |

> 说明：真实 HTTP 传输会按 `Content-Length` 截断/分帧，因此「声明很小、实际很大」在 T3 传输层不可复现；T1 用注入的 `Response` 覆盖了该情形，T3 覆盖「无长度超量」「声明超量」「超时」「重定向」。两端都只把安全枚举写入 D1。

## 4. 批准白名单与变更流程

- 清单在 `src/source-allowlist.ts`；当前三条由维护者在 [GLN-008 Issue #15 裁决](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/15#issuecomment-6557145596) 中明确批准为**公共测试来源**，并非全部已由 GLN-003 Canary 实际抓取验收。GLN-003 记录了 HNRSS 和 Cloudflare Status 的真实运行，Cloudflare Changelog URL 主要见于手册示例命令：
  - `https://developers.cloudflare.com/changelog/rss/index.xml`
  - `https://hnrss.org/newest?count=5`
  - `https://www.cloudflarestatus.com/history.atom`
- 匹配是**规范化后的精确 URL**，不是 host 前缀；已批准 host 的其它路径、query 变体默认拒绝。
- 新增/删除来源必须通过**代码评审**修改该文件并附批准依据；不存在数据库、环境变量、MCP 参数或 HTTP 接口写入白名单的路径。
- 不在本卡开放用户自定义 URL 的公网注册接口；个人订阅数据也不得写入公共源目录。

## 5. 受控来源登记合同

`src/source-registry.ts` 的 `createD1SourceRegistry(db).register({ url, intervalHours })`：

- 只接受通过同一 URL 策略（含白名单）的来源；非法输入返回安全枚举，不写库。
- `intervalHours` 必须是 1–24 的整数；重复登记**不重写**已存 interval 或调度状态。
- 复用共享 `poc_sources` 与 `url UNIQUE`：`INSERT ... ON CONFLICT DO NOTHING` 后读取既有行，重复/并发批准只产生一条采集任务。
- source id 由规范化 URL 的 SHA-256 前 16 位派生（`src_<hex>`），同一来源跨环境稳定；唯一性权威仍是 `url UNIQUE`。
- 不写 `guanlan_*` 账户/消费者订阅表；公共来源目录与私人订阅保持分离。
- 不新增迁移、不改变共享表身份或新闻 URL 去重。

## 6. 测试与证据

新增/更新的测试：

- T1 纯策略：`tests/source-safety.test.mjs`（15 个测试组，覆盖上表接受/拒绝矩阵、IDN、IPv4 混淆、IPv6、端口、末尾点、错误码不泄漏）。
- T1 执行层：`tests/ingest.test.mjs`（redirect 301/302/307/308、声明/缺失/伪造长度、流式超量、超时、reader 取消、空正文、URL 拒绝先于网络）。
- T3 真实 workerd/D1：`tests/source-safety-workerd.test.mjs`（批准源入库、未批准/私网/userinfo 在 fetch 前拒绝、重定向不跟随、无长度超量、声明超量、8s 超时、失败隔离与既有新闻保留、错误枚举不泄漏）。
- T3 登记：`tests/source-registry-workerd.test.mjs`（批准入库、重复/并发去重、非法拒绝、不写订阅表、登记后由真实 Cron 采集）。
- 既有 T3 fixture 更新为已批准 URL：`tests/workerd.test.mjs`、`tests/scheduler-workerd.test.mjs`；GLN-003 profiling 本来就用已批准源。

本地执行结果（2026-11-01，Windows，Node 24.9.0，Miniflare/workerd）：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test:unit` | 63 passed / 0 failed |
| `npm run test:integration` | 45 passed / 0 failed |
| `npm run check` | 通过（typecheck + unit + integration + dry-run + benchmark + canary + profile，exit 0） |
| `bash scripts/check.sh` | 本机 WSL bash 不可用，未运行；由精确 head 的 Ubuntu CI 验证 |
| Wrangler dry-run | 通过（wrangler 4.156.0，Total Upload 944.73 KiB / gzip 204.05 KiB） |

**T3 能证明：** 真实 workerd 中同一策略先于网络执行、redirect 不跟随、流式大小/超时预算、D1 失败状态与既有新闻/租约语义不被破坏、登记去重。
**T3 不能证明：** 真实生产 Worker 的 DNS 解析/最终出站 IP、Cloudflare 边缘对私网目标的实际过滤、真实公网 RSS 的可达性。CI 使用隔离 fixture，不依赖公网 RSS 或内部网络目标。

## 7. 仍然无法证明的安全边界

1. **已批准域名的 DNS 重绑定残余风险。** 白名单把攻击面收窄到三条维护者批准且可审查的公共源，但只要 Workers 无法固定解析 IP，就无法证明这些域名在 fetch 时不会解析到私网地址。此风险只能由运行时能力或平台合同解决，不能靠 URL 校验消除。
2. **Cloudflare 平台是否阻断私网出站没有公开合同。** 本卡不依赖、也不宣称该行为。
3. **未在真实生产 Worker 上验证。** 本卡不部署、不开启 Cron；真实 Cloudflare 出站/DNS 行为需要维护者授权的隔离环境验证。
4. **不是通用 SSRF 防护。** 本卡只覆盖「来源 URL 进入采集链路」这一条路径；未来若新增任意用户 URL、Feed 自动发现或整篇正文抓取，必须按新合同重新评估。
5. **本地 workerd 的网络 fixture 不执行真实 DNS。** 因此 CI 通过不等于生产出站安全验收。

## 8. 非目标

- 不重构 Scheduler、Parser、D1 数据模型，不新增迁移。
- 不实现通用网页爬虫、RSS 自动发现、公共注册 REST API、账户/消费者 UI、MCP 消费状态。
- 不引入新 Worker、第二数据库、第三方 DNS/安全代理或付费依赖。
- 不部署、不开启生产/Canary Cron、不合并 PR、不关闭 Issue。
