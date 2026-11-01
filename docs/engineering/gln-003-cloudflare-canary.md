# GLN-003 · Cloudflare 隔离实测手册与证据状态

> [任务契约 #6](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/6)。
> **当前状态（2026-11-01）：专属 Cloudflare Worker + D1 已真实部署、采集、测量并完成安全收尾；Canary Cron 已关闭，正式应用 bundle 已恢复。** 已取得定时采集、超时退避、过期租约、URL 幂等和 CPU 的运行证据；**尚未证明 Workers Free 10ms CPU 限额下可持续稳定运行**。见第 6 节与 [九次 CPU 三段剖析](gln-003-cpu-profile.md)，不能以通过 CI 代替云端验收。

## 1. 本轮已经核实的账号事实

使用已连接的 Cloudflare OAuth 只读检查：

- 当前只有一个可读 Cloudflare 账号。该账号已有 Mira Relay、拾言、Control Room 等 Worker，及一个 **非 Guanlan** D1 数据库。
- 已于 2026-10-31 UTC 建立 `cloud-guanlan-gln003-canary` Worker 和同名 D1，严格只操作这两件新建资源。**未复用、修改、迁移或删除其他资源**。
- `GET /accounts/{id}/workers/account-settings` 返回 `default_usage_model: standard`，这**不是** Free/Paid 计划证明。
- `GET /accounts/{id}/subscriptions` 和 `billing/usage` 返回 **403 / OAuth 无 Billing Read scope**。故无法验证本账号 Workers Free 状态、余额或付费风险。
- **2026-11-01 用户独立确认 Cloudflare 控制台无 Workers Paid 订阅**，且仅为域名绑卡；据此视为允许在 Free 边界内开始小规模隔离验证。Billing Read API 仍是 403，不将 HTTP API 无权限当成付费证据。下述为可复现操作步骤，已执行的实际证据见第 6 节。

## 2. 隔离配置与防误操作

正式运行代码仍是 `src/index.ts` + `src/ingest.ts`；隔离 Canary 部署与 CPU 对照均复用这套采集实现，而不是合成假 Worker。GLN-003 增加独立配置、HTTP smoke、指标脚本、临时可复现的 scheduled 剖析入口与回归测试；`src/parser.ts` / `src/ingest.ts` 只做有测试保护的局部性能优化。原始 POC 的 `wrangler.jsonc` 不改动，也不附带自动生产部署。

- Worker / D1 名：`cloud-guanlan-gln003-canary`，Workers.dev 仅暴露现有 `GET /health`；其他资讯/账号路径必须 404。
- 初始配置 **Cron 关闭**，须完成迁移与隔离检查后再次明确启用；不关联任何生产域名、route、队列或其他 D1。
- 实际账户 ID 和 D1 UUID 仅通过运行时环境变量提供；生成物写入 `dist/gln003/`（被 `.gitignore` 排除），不可提交。
- `GLN003_CONFIRMED_PLAN=free` 是授权操作者的**独立确认声明**，不是自动查询账单的能力；若账号实际上为 Paid，禁止用这个开关冒充 Free 实验。
- 需要 `GLN003_CONFIRM_ISOLATION=cloud-guanlan-gln003-canary` 才能生成可用于云端的部署配置；启用 Cron 还需要 `GLN003_CONFIRM_CRON=yes`。这些保护不能代替 Cloudflare IAM 或实时计费核对。
- 不使用 Github Secrets 部署，不创建自动部署工作流，不添加生产 route；任何部署都需在当前授权的测试会话由维护者明确执行。

### 不需要 Cloudflare 凭证的安全测试（已接入 CI）

```bash
npm ci
npm run check
# 包括: npm run test:canary + npm run dry-run:canary
```

`node scripts/gln003-config.mjs --dry-run` 生成仅用于打包的不可用 D1 UUID / 无 Cron 配置；`wrangler deploy --dry-run --config dist/gln003/wrangler.json` 仅打包，不部署。

## 3. Cloudflare 真实资源验收步骤（仅供全新隔离环境复现；已创建资源绝不可照做重建）

**前提：** 确认本连接账号的 Workers **Free** 计划；取得账户管理权限、隔离 Worker/D1 创建权限和 Analytics Read。核对专属资源名仍未占用。创建前保存当前非 Guanlan Worker/D1 列表（资源基线）。

**重要：** 本仓库当前 Cloudflare 账号中已存在同名 Canary Worker/D1。以下 `d1 create` 与迁移命令仅供新的隔离测试账号或经明确命名、重新核准的全新资源复现；**不可在现存 Canary 上重新执行创建/迁移、不可拿历史 UUID 代入并覆盖现有绑定**。现存环境要复测须先读取真实资源名、绑定与 Cron 状态，再按 Issue 约定逐项执行。

1. `npx wrangler d1 create cloud-guanlan-gln003-canary`，记录输出的**新建专属** D1 UUID，不得输入其他数据库 ID。
2. 以下环境变量仅在本地终端设置，不写入仓库或日志（PowerShell 示意）：

   ```powershell
   $env:GLN003_ACCOUNT_ID = "<Cloudflare account ID>"
   $env:GLN003_DATABASE_ID = "<newly-created GLN-003 D1 UUID>"
   $env:GLN003_CONFIRMED_PLAN = "free"
   $env:GLN003_CONFIRM_ISOLATION = "cloud-guanlan-gln003-canary"
   node scripts/gln003-config.mjs
   ```

3. 执行 **新建专属数据库** 的迁移，确认不含真实账号/私有源，然后部署 **Cron 关闭** 的 Worker：

   ```powershell
   npx wrangler d1 migrations apply DB --remote --config dist/gln003/wrangler.json
   npx wrangler deploy --config dist/gln003/wrangler.json
   ```

4. 从 Cloudflare Dashboard 获取新建 Worker 的准确 `workers.dev` 地址；只读 smoke：

   ```powershell
   $env:GLN003_CANARY_URL = "https://cloud-guanlan-gln003-canary.<account-subdomain>.workers.dev"
   node scripts/gln003-smoke.mjs
   ```

5. 在 **专属** D1 上添加一条公开、非敏感的 Cloudflare 官方 RSS 测试源；不调用订阅 CRUD，不采集用户私有 URL：

   ```powershell
   npx wrangler d1 execute DB --remote --config dist/gln003/wrangler.json --command="INSERT OR IGNORE INTO poc_sources(id,url,interval_hours,due_at) VALUES ('gln003-official','https://developers.cloudflare.com/changelog/rss/index.xml',1,'1970-01-01T00:00:00.000Z')"
   ```

6. 再次核对配额余额、测试源条数与目标资源，显式启动 Cron。观测至少一个采集窗口、一个重复 Cron 窗口（验证无重复新闻及正确的 `due_at`），以及一个后续到期窗口；不使用系统时间变更绕过任务逻辑。

   ```powershell
   $env:GLN003_CONFIRM_CRON = "yes"
   node scripts/gln003-config.mjs --enable-cron
   npx wrangler deploy --config dist/gln003/wrangler.json
   npx wrangler d1 execute DB --remote --config dist/gln003/wrangler.json --command="SELECT id,last_status,retry_count,due_at,last_error FROM poc_sources"
   npx wrangler d1 execute DB --remote --config dist/gln003/wrangler.json --command="SELECT COUNT(*) AS news_count FROM poc_news"
   ```

7. 对 D1 失败恢复仅使用控制在本资源内的到期/租约状态与故障源测试；测试后恢复安全态，不暴露写 API。禁止未经测试授权制造云服务整体配额耗尽或修改其它 Worker。
8. 必须记录精确部署的 Git SHA、资源标识、测试时段、成功/失败/重复执行次数、RSS 条数、Cron 调度与租约证据、实际 Worker CPU P50/P99 和 D1 行读写。若统计未提供或没有 Analytics 权限，写 **N/A**，不可填 0。

### 云端使用量获取

Workers Dashboard 可直接查看 CPU 使用分布。Cloudflare **Analytics SQL API** 可以直接查询 `logs.workersLogs` 的真实 CPU/墙钟记录和 `events.d1Queries` 的 D1 **实际 rowsRead/rowsWritten**。本次连接的 Cloudflare OAuth 已实测能读取这些数据；在独立终端使用同类权限的 API token 可运行：

```powershell
$env:GLN003_FROM = "2026-11-01T00:00:00Z"
$env:GLN003_TO   = "2026-11-01T01:00:00Z"
$env:CLOUDFLARE_API_TOKEN = "<Account Analytics Read API token>"
node scripts/gln003-metrics.mjs
```

*注意：Analytics SQL 可能采样或延迟，且 D1 数据包含手工迁移和验证 SQL，不应把窗口内所有行读写都算作 Cron。* 可以通过查询文本、执行时段及应用日志区分操作；Worker 绑定的 `meta.rows_read/rows_written` 和 D1 Dashboard 可以用于交叉核对。

Cloudflare 官方实时依据：
- [Workers Free 额度](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 免费配额与行统计](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 云端指标与 GraphQL](https://developers.cloudflare.com/d1/observability/metrics-analytics/)
- [Cloudflare 2026-09-01 D1 免费行配额执行规则](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)

## 4. 估算与释放条件

初始 **5 分钟 Cron × 每轮上限 2 个来源**：理论最多 288 次 Cron/天、576 次来源尝试/天，不能把它解释成可支持 576 个用户或 576 个稳定源。真实容量取决于 CPU、D1 scan、缓存、源大小、失败退避及其他服务共享配额；测试样本不足时不定正式生产参数。

停机优先：关闭专属 Cron、核对 Worker 名称并删除 **专属** Worker、备份必要的临时测量结果后仅删除**专属** D1。不可按前缀广泛批量删除，也不得触碰账号里已有的 Relay/拾言等资源。

## 5. 验收结果表（未运行不可伪填）

| 项目 | 状态 |
| --- | --- |
| GitHub CI / canary dry-run | **通过**：[PR #7 run 41225808350](https://github.com/uichat-mira/cloud-mcp-guanlan/actions/runs/41225808350)，T1 9/9、workerd+D1 T3 12/12、Canary 6/6，双 Wrangler dry-run、Mira Gate、SonarCloud 均成功；CodeRabbit skipped 不等于批准 |
| Cloudflare 账号确认为 Free | **维护者从控制台确认无 Workers Paid 订阅**；OAuth Billing Read 仍为 403 |
| 隔离 Worker / D1 创建 | **已完成**：专属资源、迁移和 D1 DB binding 校验；无其他资源修改 |
| 真实 Cron / 外网 RSS / D1 租约 | **已验证**：HNRSS 超时退避、25 条真实 Atom 成功、2 条 RSS 成功、2 条重复抓取不新增、过期租约接管且旧 token 写入 0 行 |
| 真实 CPU P50/P99、D1 rows | **已测得四次 scheduled CPU：8、32、10、10ms**，墙钟 9394、1600、1647、1721ms；D1 REST meta 和 Analytics SQL rowsRead/rowsWritten 可读取。但样本少，不能作为稳定 P99/账单容量预估 |
| 免费运行容量与成本决策 | **仍不放行长期免费采集**：首轮批量 JSON1 优化后，相同 25 条 Atom 首次入库实测 26ms（旧版 32ms，单样本差值 6ms），仍超过 Free 标称 10ms；需继续识别 CPU 热点、降低单次负载并增加样本 |

**GLN-003 保持开放：真实云端功能链路已验证，但 Free CPU 裕量未满足生产化验收，仍需优化/复测。Cron 已停用，不会持续消耗测试额度。**

## 6. 真实 Cloudflare 隔离环境执行记录（2026-10-31 UTC）

- 17:18 UTC：使用已连接 Cloudflare 账号创建专属 D1 `cloud-guanlan-gln003-canary`；REST API 成功执行 `0001_poc.sql` / `0002_source_leases.sql` 八条建表、索引和 ALTER 操作，校验十个列名称。D1 库 UUID 和账号 ID **不进入仓库文本**。
- GitHub 隔离构建 [Actions #41224035516](https://github.com/uichat-mira/cloud-mcp-guanlan/actions/runs/41224035516) 基于 GLN-003 PR 源码（未更改其真实 `src/index.ts` / `src/ingest.ts` / `src/parser.ts`）编译 ES Module bundle；上传的 bundle Git blob 是 `0bdca1006db3d628ad933de6a1c1b615e0425a11`。临时构建仅在分离的 `feat/gln-003-bundle-staging` 分支发生，不属于待合入的 PR。
- 17:22 UTC 前后：Cloudflare API 上传完整 207,449 字符 Worker bundle，`DB` binding 精确绑定该专属 D1，`compatibility_date=2026-08-06`；独立验证初始 Cron 为空，`workers.dev` 开启、preview 关闭。
- 17:22 UTC：公网真实 smoke [Actions #41224199119](https://github.com/uichat-mira/cloud-mcp-guanlan/actions/runs/41224199119)：`/health` HTTP 200 + `publicApi:false`，四个私有路径均 404。
- 17:23 UTC：仅插入来源 `gln003-hn-small`，公共 HTTPS `hnrss.org/newest?count=5`，每 1 小时更新；只对该 Worker 启用 `*/5 * * * *` Cron。Cloudflare 官方说明新 Cron 最长约 15 分钟传播，因此**Cron API 显示成功不代表实际触发已成功**。
- 17:27 UTC：GitHub Runner HTTP health 及私有路由复验成功；在**同一测试 Worker**上开启 Cloudflare Observability（100% invocation logs、查询参数脱敏）；Analytics SQL `logs.workersLogs` 实测 5 次 HTTP 访问，CPU **0–3ms**，HTTP 200/404 均无异常。这不代表 RSS 解析的 CPU。
- 17:30–17:31 UTC：首个真实 Cron scheduled 调用触发，HNRSS 上游发生 8 秒请求超时，D1 记录 `fetch_timeout`、`retry_count=1` 和下次到期时间。Analytics SQL 取得该 scheduled **CPU 8ms、wall 9394ms**，未写入任何新闻；这证明失败记录与退避生效，但**不证明成功解析或稳定容量**。隔离 D1 `events.d1Queries` 可单独观察 lease claim、失败更新、积压计算的行读写，不能混入手工 SQL 观测成本。
- 17:32 UTC：新增第二个公共测试 Atom 来源 `https://www.cloudflarestatus.com/history.atom` 作为真实外网对照；仅 2 个来源，没有放开公共新闻接口。
- D1 REST SQL 查询每条响应包含 `meta.rows_read` / `meta.rows_written`，且 Cloudflare Analytics SQL `events.d1Queries` 成功查询该独立数据库的记录（例如单条 test-source INSERT 产生 5 行写入）；**手动 REST SQL 查询与 Worker Cron SQL 必须分离统计**。
- 当前已经实际验证 scheduled、RSS/Atom 成功/失败退避、D1 租约接管和 URL 幂等；**尚未通过**的是免费 CPU 安全裕量、持续冷/热样本以及精确区分手工 SQL 和 Cron 的全面 D1 行成本。不得把当前验收当成可投入长期生产的免费容量证明。


### 17:35—17:46 UTC 实测补充与停机确认

| Cron 事件 | 来源 / 结果 | CPU (Cloudflare) | Wall | 数据处理 |
| --- | --- | ---: | ---: | --- |
| 17:30（日志 17:31） | HNRSS 请求超时 | 8ms | 9,394ms | `fetch_timeout`、退避成功、0 新增 |
| 17:35 | Cloudflare Status Atom | **32ms** | 1,600ms | 25 条独立 URL 成功入库 |
| 17:40 | 受控、公开 2 条 RSS fixture | **10ms** | 1,647ms | 新增 2 条独立 URL |
| 17:45 | 同一 2 条 RSS 再次采集 | **10ms** | 1,721ms | **0 新增**，过期租约被接管 |

17:45 UTC 测试准备时，仅在专属库将 `gln003-controlled-two` 的 `due_at` 调到已到期，并设置 `lease_token=gln003-expired-lease-test`、`lease_expires_at` 为过去时间。真实 Cron 完成后：
- `last_status=succeeded`，`last_error=NULL`，`retry_count=0`，`lease_token=NULL`，`lease_expires_at=NULL`。
- `due_at=2026-10-31T18:45:55.344Z`，从实际完成时间重新顺延 1 小时，而非 Cron 计划时间。
- 逐源新闻计数：Cloudflare Status **25/25 URL 唯一**，fixture **2/2 URL 唯一**；总数始终为 **27**。
- 使用原过期 token 执行条件 UPDATE，**0 行改变**。这能证明远程 D1 的所有权围栏条件；真实双 Cron 实例同时争抢只在前序 workerd T3 通过，**不能把这次按序复测描述成真实并发竞争验收**。

**17:46 UTC：仅操作 `cloud-guanlan-gln003-canary` Worker，PUT 空计划数组关闭 Cron，GET 复核 `schedules=[]`。** Cloudflare 表示 Cron 配置全球传播可能最长 15 分钟，所以此时是控制面的**已禁用**，不能承诺所有区域立刻停止；保留两件隔离资源但不做自动采集，未做 `dev/test/prod` 发布。资源安全复核：原有 11 个 Workers 和唯一原有 D1 `mira-shiyan` 全部仍在。

**免费额度技术结论（暂不生产放行）：** Cloudflare 官方 [Workers Free CPU time limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time) 标称 Cron 单次 10ms，当前四个成功/失败混合样本的 CPU 是 **8、32、10、10ms**，至少一次明显超限、两次踩线。单次 32ms 成功来自平台偶发超限容忍度，绝不能外推为可持续生产承诺。优先做局部 CPU profiling：区分解析、每条记录构造、批量 D1 `prepare`/事务响应；保留 GLN-002 的租约原子性和失败安全，控制条目上限、按真实样本定参数，不引入付费平台，不提前冻结每日可支持来源数量。**不能凭 4 次样本算可靠 P99。**

观测来源：Cloudflare Analytics SQL API `logs.workersLogs` + 专属 D1 REST `meta` 与 `events.d1Queries`，查询窗口 2026-10-31 17:30–17:46 UTC。D1 SQL telemetry 可能采样且混合了人工查询，**不将整个查询窗口 rowsRead/rowsWritten 汇总作为纯 Cron 开销**。成功路径和幂等数据以实时 D1 记录核实。


### 2026-10-31 18:05 UTC · 单次 CPU 优化实测（本轮）

**目标与改动：**将原本对每一条新闻分别调用 `DB.prepare(...).bind(...)` 的 1:N SQL 写入，改为 **一次 `json_each(?)` / `json_extract(...)` 批量插入 + 一次拥有者状态更新**，仍以 `DB.batch()` 作为原子事务，并在批量插入的 SQL 内保留 `lease_token` / `lease_expires_at` 条件。保持来源间隔、失败退避、全局 URL 主键、最大候选数 40 和队列原子领取逻辑不变。

- 代码：[PR #7](https://github.com/uichat-mira/cloud-mcp-guanlan/pull/7) 优化提交 `5ad91ec`，新增 40-item D1 测试提交 `1d24c47`。CI [Actions #41226821899](https://github.com/uichat-mira/cloud-mcp-guanlan/actions/runs/41226821899) **T1 9/9，workerd+D1 T3 13/13，Canary 6/6，Wrangler dry-run、Mira Gate 和 SonarCloud 全绿**。原有超时/事务回滚/过期旧令牌不能写入用例均保留。
- 实际部署：从上述优化后的 PR 分支创建仅用于 bundle 的 `feat/gln-003-perf-bundle-stage`，GitHub Actions [#41226905681](https://github.com/uichat-mira/cloud-mcp-guanlan/actions/runs/41226905681) 编译实际 `src/index.ts`，bundle Git blob `cff903cf9b07493803ca3188eb3268eb36084f00`。临时 write-enabled workflow 在完成后删除，仅新建的 Guanlan Canary Worker 被更新。部署时检查 `Cron=[]`、唯一 D1 binding 指向专属库、Observability enabled。
- 对照方法：只从 Canary D1 删除先前 **25 条由 `gln003-cf-status` 创建的测试新闻**，保留另一个小型来源的 2 条新闻，然后把同一 Cloudflare Status `history.atom` 来源调为到期；2026-10-31 17:57 UTC 为 Canary 开启短期 `*/5` Cron。无真实用户数据、无其他 Worker/D1 变更。
- **本次真实 scheduled 执行（18:05:39 UTC）：CPU 26ms、wall 1,384ms**，成功解析与写入 **25 条 Atom 新闻、25 个不同 URL**；D1 来源状态 `succeeded`、`retry_count=0`、租约 token/expiry 清空，下次到期 `2026-10-31T19:05:38.694Z`。Canary 新闻共 27 条（25 Atom + 2 受控 RSS）。CPU 来源为 Cloudflare Analytics SQL `logs.workersLogs`。
- **历史基线（17:35 UTC）：CPU 32ms / wall 1,600ms**，同一 Atom feed 首次入库 25 条。单次 CPU 低了 **6ms（18.75%）**，但这只是两次独立观测，可能包含边缘节点、冷启动、上游负载和运行噪声差异，**不能据此承诺稳定下降或容量提升**。
- 独立的 Cloudflare D1 REST SQL 测试证明 `json_each/json_extract` 在实际 D1 支持。Cloudflare `events.d1Queries` 对该短窗口的细粒度 SQL 样本为空（采样/延迟），因此**没有可据以精确计算此轮纯 Cron rowsRead/rowsWritten 的细分证据**。
- **复测后立即关闭 Cron 并重新 GET 确认 `schedules=[]`**。Cloudflare 官方说明停用传播最长可能 15 分钟；隔离 Worker 和 D1 保留但不授权长期定时运行。

**判定：**本轮优化保留全部 D1 正确性并通过真实 Cloudflare 首次入库，产生一个方向积极、但统计证据不足的 CPU 观测。**26ms 仍高于 Workers Free 标称 Cron 10ms，GLN-003 不应标记完成，更不应批准生产化免费运行。**下一步若继续优化，应优先查清 `fast-xml-parser` 对大型 Atom 的 CPU 消耗和单次多个来源的累计开销；应基于新的有界观测决定处理粒度，而不是盲目削减所有来源到 2 条。

Cloudflare 官方 [Cron 触发器传播说明](https://developers.cloudflare.com/workers/configuration/cron-triggers/) 与 [Analytics SQL API](https://developers.cloudflare.com/analytics/sql-api/) 是本次指标和观察窗口的依据。
