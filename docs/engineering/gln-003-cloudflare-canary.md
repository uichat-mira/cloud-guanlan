# GLN-003 · Cloudflare 隔离实测手册与证据状态

> [任务契约 #6](https://github.com/uichat-mira/cloud-guanlan/issues/6)。
> **当前状态：已在维护者确认无 Workers Paid 订阅后，创建隔离 D1、执行迁移、通过 Cloudflare API 上传真实 Worker，并完成公网 HTTP smoke；Cron 已配置，采集结果及真实 RSS CPU 仍待观察。** 不能以通过 CI 代替云端验收。

## 1. 本轮已经核实的账号事实

使用已连接的 Cloudflare OAuth 只读检查：

- 当前只有一个可读 Cloudflare 账号。该账号已有 Mira Relay、拾言、Control Room 等 Worker，及一个 **非 Guanlan** D1 数据库。
- 已于 2026-10-31 UTC 建立 `cloud-guanlan-gln003-canary` Worker 和同名 D1，严格只操作这两件新建资源。**未复用、修改、迁移或删除其他资源**。
- `GET /accounts/{id}/workers/account-settings` 返回 `default_usage_model: standard`，这**不是** Free/Paid 计划证明。
- `GET /accounts/{id}/subscriptions` 和 `billing/usage` 返回 **403 / OAuth 无 Billing Read scope**。故无法验证本账号 Workers Free 状态、余额或付费风险。
- **2026-11-01 用户独立确认 Cloudflare 控制台无 Workers Paid 订阅**，且仅为域名绑卡；据此视为允许在 Free 边界内开始小规模隔离验证。Billing Read API 仍是 403，不将 HTTP API 无权限当成付费证据。下述为可复现操作步骤，已执行的实际证据见第 6 节。

## 2. 隔离配置与防误操作

代码仍然是 `src/index.ts` + `src/ingest.ts`；没有专用的简化版合成 Worker。GLN-003 仅增加独立配置生成器、HTTP smoke、真实分析接口采集脚本和保护测试，不修改 `wrangler.jsonc` 的 GLN-001/002 POC 定义。

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

## 3. Cloudflare 真实资源验收步骤（复现手册；实际执行状态见第 6 节）

**前提：** 确认本连接账号的 Workers **Free** 计划；取得账户管理权限、隔离 Worker/D1 创建权限和 Analytics Read。核对专属资源名仍未占用。创建前保存当前非 Guanlan Worker/D1 列表（资源基线）。

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
| GitHub CI / canary dry-run | **通过**：[PR #7 Run 41222777457](https://github.com/uichat-mira/cloud-guanlan/actions/runs/41222777457)，9/9 T1、12/12 workerd+D1 T3、**5/5 Canary 安全检查**（包含相似域名拒绝）、两份 Wrangler dry-run、Mira Gate 全绿。实际应用包 211.46 KiB / gzip 54.22 KiB，隔离 config 包 211.77 KiB / gzip 54.24 KiB |
| Cloudflare 账号确认为 Free | **维护者从控制台确认无 Workers Paid 订阅**；OAuth Billing Read 仍为 403 |
| 隔离 Worker / D1 创建 | **已完成**：专属资源、迁移和 D1 DB binding 校验；无其他资源修改 |
| 真实 Cron / 外网 RSS / D1 租约 | Cron 已配置（5 分钟）；RSS 数据处理结果**待观测** |
| 真实 CPU P50/P99、D1 rows | **部分取得**：HTTP health 的日志 CPU 样本 0–3ms、D1 remote 查询 rows_read/rows_written；**采集 CPU 未取得** |
| 免费运行容量与成本决策 | **不能验收** |

**GLN-003 必须保持开放，直到 RSS 定时采集、容错和 CPU/D1 用量满足真实验收。**

## 6. 真实 Cloudflare 隔离环境执行记录（2026-10-31 UTC）

- 17:18 UTC：使用已连接 Cloudflare 账号创建专属 D1 `cloud-guanlan-gln003-canary`；REST API 成功执行 `0001_poc.sql` / `0002_source_leases.sql` 八条建表、索引和 ALTER 操作，校验十个列名称。D1 库 UUID 和账号 ID **不进入仓库文本**。
- GitHub 隔离构建 [Actions #41224035516](https://github.com/uichat-mira/cloud-guanlan/actions/runs/41224035516) 基于 GLN-003 PR 源码（未更改其真实 `src/index.ts` / `src/ingest.ts` / `src/parser.ts`）编译 ES Module bundle；上传的 bundle Git blob 是 `0bdca1006db3d628ad933de6a1c1b615e0425a11`。临时构建仅在分离的 `feat/gln-003-bundle-staging` 分支发生，不属于待合入的 PR。
- 17:22 UTC 前后：Cloudflare API 上传完整 207,449 字符 Worker bundle，`DB` binding 精确绑定该专属 D1，`compatibility_date=2026-08-06`；独立验证初始 Cron 为空，`workers.dev` 开启、preview 关闭。
- 17:22 UTC：公网真实 smoke [Actions #41224199119](https://github.com/uichat-mira/cloud-guanlan/actions/runs/41224199119)：`/health` HTTP 200 + `publicApi:false`，四个私有路径均 404。
- 17:23 UTC：仅插入来源 `gln003-hn-small`，公共 HTTPS `hnrss.org/newest?count=5`，每 1 小时更新；只对该 Worker 启用 `*/5 * * * *` Cron。Cloudflare 官方说明新 Cron 最长约 15 分钟传播，因此**Cron API 显示成功不代表实际触发已成功**。
- 17:27 UTC：GitHub Runner HTTP health 及私有路由复验成功；在**同一测试 Worker**上开启 Cloudflare Observability（100% invocation logs、查询参数脱敏）；Analytics SQL `logs.workersLogs` 实测 5 次 HTTP 访问，CPU **0–3ms**，HTTP 200/404 均无异常。这不代表 RSS 解析的 CPU。
- 17:30–17:31 UTC：首个真实 Cron scheduled 调用触发，HNRSS 上游发生 8 秒请求超时，D1 记录 `fetch_timeout`、`retry_count=1` 和下次到期时间。Analytics SQL 取得该 scheduled **CPU 8ms、wall 9394ms**，未写入任何新闻；这证明失败记录与退避生效，但**不证明成功解析或稳定容量**。隔离 D1 `events.d1Queries` 可单独观察 lease claim、失败更新、积压计算的行读写，不能混入手工 SQL 观测成本。
- 17:32 UTC：新增第二个公共测试 Atom 来源 `https://www.cloudflarestatus.com/history.atom` 作为真实外网对照；仅 2 个来源，没有放开公共新闻接口。
- D1 REST SQL 查询每条响应包含 `meta.rows_read` / `meta.rows_written`，且 Cloudflare Analytics SQL `events.d1Queries` 成功查询该独立数据库的记录（例如单条 test-source INSERT 产生 5 行写入）；**手动 REST SQL 查询与 Worker Cron SQL 必须分离统计**。
- 后续待验证：真正 scheduled 事件、RSS 成功与幂等、错误恢复、scheduled CPU（及冷暖差异）、D1 采集读写计量和实测容量。不得把本节当成全部验收通过。

Cloudflare 官方 [Cron 触发器传播说明](https://developers.cloudflare.com/workers/configuration/cron-triggers/) 与 [Analytics SQL API](https://developers.cloudflare.com/analytics/sql-api/) 是本次指标和观察窗口的依据。
