# GLN-003 · Cloudflare 隔离实测手册与证据状态

> [任务契约 #6](https://github.com/uichat-mira/cloud-guanlan/issues/6)。
> **当前状态：隔离测试工装已施工；尚未创建 Cloudflare 测试资源、部署代码或取得真实 Free CPU/D1 指标。** 不能以通过 CI 代替云端验收。

## 1. 本轮已经核实的账号事实

使用已连接的 Cloudflare OAuth 只读检查：

- 当前只有一个可读 Cloudflare 账号。该账号已有 Mira Relay、拾言、Control Room 等 Worker，及一个 **非 Guanlan** D1 数据库。
- 尚无 `cloud-guanlan-gln003-canary` Worker 和同名 D1；这些是本卡专属的隔离资源名。**绝不复用、修改、迁移或删除其他资源**。
- `GET /accounts/{id}/workers/account-settings` 返回 `default_usage_model: standard`，这**不是** Free/Paid 计划证明。
- `GET /accounts/{id}/subscriptions` 和 `billing/usage` 返回 **403 / OAuth 无 Billing Read scope**。故无法验证本账号 Workers Free 状态、余额或付费风险。
- 截至这些权限问题消除或维护者从 Dashboard 独立确认 Free 计划之前，**本卡不得创建真实云资源或启动 Cron**。下面所有云端步骤均为**后续待执行**的手册，不是执行记录。

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

## 3. Cloudflare 真实资源验收步骤（全部待执行）

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

Workers Dashboard 可直接查看 CPU 使用分布。Cloudflare 官方 GraphQL 的 `workersInvocationsAdaptive` 可返回 Worker CPU P50/P99；`d1AnalyticsAdaptiveGroups` 可返回目标数据库读/写**查询次数**。在拥有 `Account Analytics Read` 的独立 API token 后可运行：

```powershell
$env:GLN003_FROM = "2026-11-01T00:00:00Z"
$env:GLN003_TO   = "2026-11-01T01:00:00Z"
$env:CLOUDFLARE_API_TOKEN = "<Account Analytics Read API token>"
node scripts/gln003-metrics.mjs
```

*注意：查询次数不是行读/写数量！* 行数应从 D1 Dashboard Row Metrics 或 Worker Binding API 返回的 `meta.rows_read` / `meta.rows_written` 的真实查询记录获取。GraphQL 接口实现未在本轮连接上实测成功，不能当作已完成云端监控。

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
| GitHub CI / canary dry-run | 待记录实际 PR run |
| Cloudflare 账号确认为 Free | **阻塞：Billing Read 403** |
| 隔离 Worker / D1 创建 | **未执行** |
| 真实 Cron / 外网 RSS / D1 租约 | **未执行** |
| 真实 CPU P50/P99、D1 rows | **未取得** |
| 免费运行容量与成本决策 | **不能验收** |

**GLN-003 必须保持开放，直到真的取得账号计划与云端数据。**
