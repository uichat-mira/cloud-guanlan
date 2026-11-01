# GLN-001 · Workers Free + D1 技术选型 POC

> 任务契约：[GLN-001 / Issue #2](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/2)。
> **证据状态：选用 fast-xml-parser 后，GitHub Actions / workerd-D1 全套验证已通过；Cloudflare Free 真实账户 CPU/额度未测，未部署。**

## POC 与产品边界

本卡验证 Hono、D1（使用 Drizzle 的 insert / D1 prepared SQL）和小时级 scheduled 路径是否能作为低成本服务的技术底座，并以相同 RSS/Atom 样本对照 Feedsmith 3.0.1 与 fast-xml-parser 5.x。

只暴露不读写新闻的 `GET /health`。订阅源由本地测试插入 D1；没有管理接口、私人新闻 API、Cloud Auth 或部署配置里的有效生产数据库 ID。

### 测试设计

- **T1 解析兼容**：RSS、Atom、数量上限 40、缺失 URL、恶意协议、不支持文档。
- **T3 Worker/D1**：真实 Miniflare / workerd、`getWorker().scheduled()`、本地 D1 迁移、同 URL 去重、到期调度、不因 GET 刷新、上游 503 后保留原数据、响应体上限。
- **解析基准**：一个 workerd 进程内，用 5 / 40 篇合成 RSS 条目分别执行两种解析器各 12 次，报告中位和最慢 wall-time。仅供对照趋势，**不是 Cloudflare 计费 CPU，也不代表服务请求的总 CPU 开销**。
- **Wrangler dry-run**：无凭证、不部署，验证 bundle/兼容性。
- **CI 与锁文件**：已固定从真实 GitHub Runner 生成的 `package-lock.json`；CI 与 Worker 必须执行 `npm ci`，不得临时解析漂移依赖。

### 重现命令

```sh
npm ci --no-audit --no-fund
npm run check
# 或独立运行 npm run test:integration、npm run test:benchmark、npm run dry-run
```

## 预计边界

单次 Cron 最多处理 1 个到期来源；未定义用户订阅/消费记录，也不对公网提供手工刷新。RSS 读取上限 128 KiB、最多 40 篇；不跟随 HTTP 重定向，失败写入来源状态但不能掩盖为成功。

URL 过滤只是初步防护：真实用户输入仍需 SSRF、IP/DNS 及跳转链的全面安全处理。当前未引入 Cloud Auth，因此**绝不开放私人新闻接口**。

## 已取得的 CI 证据

- GitHub Actions [run 41217814811](https://github.com/uichat-mira/cloud-mcp-guanlan/actions/runs/41217814811)：**GLN-001 解析器代码审查修复后的最终完整复验**，含针对 Atom `rel=self` 以及空 URL 错误落到 Feed URL 的两套解析器回归测试；Repository Contract / Branch Policy / Mira Gate 全绿。
- GitHub Actions: [run 41216624651](https://github.com/uichat-mira/cloud-mcp-guanlan/actions/runs/41216624651)（双解析器的初步全绿）；[run 41216709426](https://github.com/uichat-mira/cloud-mcp-guanlan/actions/runs/41216709426)（**实际采集已改用 fast-xml-parser 之后的复验**，提交 `2bf566bd`，Repository Contract、Branch Policy、Mira Gate **全部 success**）。后续仅文档修改不改变这些测试覆盖的运行代码版本。
- Runner: Ubuntu 24.04, Node.js `v22.23.4`, npm `10.9.9`, Wrangler `4.156.0`, Feedsmith `3.0.1`，fast-xml-parser 锁文件固定为具体版本。
- `tsc --noEmit` 通过；T1 解析单测 **6/6**（RSS、Atom、40 项边界、不支持文档与协议拦截）；T3 workerd + D1 **3/3**（Cron 插入 3 条、未到期不重复抓取、再次到期无重复新闻；上游 503 保留原新闻和错误状态；超大响应拒绝）。
- Wrangler `deploy --dry-run` 通过，**无真实部署**。双解析器都进入采集依赖树时：608.00 KiB（gzip 136.90 KiB）；切换生产路径仅使用 fast-xml-parser 后：**378.36 KiB（gzip 85.80 KiB）**，gzip 减少约 **37.3%**。测试/基准构建仍保留两个解析器，但已从最终 Worker 的采集依赖树裁掉 Feedsmith。
- workerd 原位对照（同一合成 RSS，分别运行 12 次，`performance.now()` 的毫秒级分辨率，仅为 wall-time）： 

| Fixture | 内容字节 | Feedsmith 中位 / 最大 | fast-xml-parser 中位 / 最大 |
| --- | ---: | ---: | ---: |
| 5 篇 | 973 B | 2 / 9 ms | 1 / 1 ms |
| 40 篇 | 6773 B | 3 / 3 ms | 2 / 2 ms |

- 复验后第二组同条件观测（12 次）：5 篇 Feedsmith 中位 1ms、fast-xml-parser 中位 0ms；40 篇两者均为 1ms。此差异说明 wall-time 毫秒级采样受 warmup / 调度和计时分辨率影响，**不能将 1ms 差异夸大为确定的 CPU 性能优势**。上述选择更明确的收益是**生产包体减少与成熟已有适配**。
- Review 修复来自 [PR #3](https://github.com/uichat-mira/cloud-mcp-guanlan/pull/3) 的 Atom 非 alternate 链接审查意见。现在缺失文章 URL 会被统一拒绝，且不把 `rel=self` 的元数据链接当作文章；测试在两种解析器下执行。
- **测试含义限制**：仅 5/40 篇合成 RSS，未覆盖大型/真实 Feed 的长尾 XML、Atom 扩展、RDF、编码、CPU 计费分解、真实远端网络与 SSRF/DNS、防止重叠 Cron 的分布式协调。以上 wall-time 不能直接等同于 Worker Free 的 **10 ms CPU 限额**，不能据此断言生产准入。
- Cloudflare 免费账号真实运行指标：**未测**，待后续独立授权的测试资源 / 实测验证。
- 免费额度耗尽时的降级取舍：**用户尚未拍板**。

## 技术判断（POC 结论）

- 优先保持 **Hono + 单一 Worker + D1**，不要提前加队列和服务拆分。
- Drizzle 仅用于类型化 D1 写入的可行性验证，生产读写是否全部采用 ORM 等核心 Schema 稳定后再判断。
- **选择 fast-xml-parser 作为首版 RSS/Atom 采集路径**：本轮数据集的解析结果一致，fast-xml-parser 的 workerd 解析中位耗时略低，Desktop 已有现成兼容思路；Feedsmith 的更广格式支持尚非观澜当前交付需求。保留 Feedsmith 对照基准到技术结论稳定，但不让它进入实际 Worker 的采集依赖闭包（以最终 Wrangler dry-run 包体确认）。
- Free 上线资格需要真实 Cloudflare Account 测试与监控数据。本 POC 不能代替；未进行 Cloud Auth / 多用户 / 私人订阅授权设计，不可把 POC 发布为公众新闻服务。
- 真实新闻源调度、高并发、重复 Cron 锁、URL SSRF/IP/DNS 防护和 90 天清理属于后续专门任务，**不能把本 POC 当成安全生产版**。
