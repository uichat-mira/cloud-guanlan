# GLN-007 · 账户 × 稳定消费者 × 新闻的持久处理账本

Issue: [#14](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/14). 本文说明**已实现的内部领域合同**，不宣称 Cloud Auth 写凭证、MCP 状态写入工具、管理 API 或任何公网写接口已经交付。

## 交付物

| 文件 | 作用 |
| --- | --- |
| `migrations/0004_consumer_news_state.sql` | 单个增量迁移：`guanlan_consumer_news_states` 表、复合外键、唯一键与状态索引 |
| `src/consumption.ts` | 领域服务：身份指纹、状态读写、幂等/并发合同、授权判定 |
| `src/parser.ts` | 导出 `canonicalNewsUrl`，让采集与账本共用同一条 URL 归一化规则 |
| `tests/consumption.test.mjs` | T1/T2：身份、请求/响应合同、失败语义、只读无副作用 |
| `tests/consumption-workerd.test.mjs` | T3：真实 Miniflare/workerd + D1 的隔离、幂等、并发、乱序、清理重建 |
| `tests/migration-workerd.test.mjs` | 新增「已填充 `0001..0003` 前向升级」用例 |

**没有**新增 HTTP 路由、MCP 工具、OAuth/第二套身份、Cron、清理任务或部署配置。`src/app.ts` 未改动。

## 数据键与身份

```text
guanlan_consumer_news_states(
  account_id, consumer_id, news_fingerprint,   -- PRIMARY KEY 三元组
  source_id, status, reason, outcome_url, decided_at, version, last_operation_id
)
```

- **唯一键**：`(account_id, consumer_id, news_fingerprint)`。同一账户下不同消费者互不覆盖；不同账户的同名消费者是不同租户。
- **复合外键**：`(account_id, consumer_id) → guanlan_consumers(account_id, consumer_id) ON DELETE CASCADE`。消费者被删除时其账本一起清理；数据库拒绝把消费者挂到另一个账户。
- **没有指向 `poc_news` 的外键**：新闻索引是全局、可清理的共享采集表，消费者决定必须比它活得久。删除新闻行不会删除账本。
- **`news_fingerprint`**：`canonicalNewsUrl(url)` 的 SHA-256 小写十六进制（64 字符）。归一化规则与采集完全一致：绝对 http(s)、拒绝 userinfo、去掉 fragment、**保留 query**、主机名由 URL 解析器小写化。因此标题相同不会合并，query 不同不会合并，fragment 不构成新身份。
- **不保存标题、摘要、正文或完整 URL**：账本只留指纹、决定与授权来源，90 天清理后不会从账本泄漏新闻内容。
- **`source_id`**：作出决定时被授权的来源，用于新闻行被清理后仍能在**当前**权限集合下复核该记忆；它本身不重新授权任何来源。
- **`version`**：行级单调整数，从 1 开始。排序权威是它，不是客户端时间戳。
- **`last_operation_id`**：当前记录在行上的操作幂等键，用于跨进程/请求/设备识别重放。
- **`decided_at`**：服务端时钟（可注入测试时钟）写入的观察时间，不参与排序。

`0004` 的 CHECK 约束覆盖：指纹必须是 64 位小写十六进制、`status ∈ {pending, adopted, ignored}`、`reason` 1..500 且无首尾空白、`outcome_url` 1..2048、`version ≥ 1`、`last_operation_id` 1..128 且无首尾空白。`source_id` 只要求非空，因为 `poc_sources.id` 本身没有长度约束（与 GLN-006 保持一致）。

## 状态语义

| 状态 | 存储 | 含义 |
| --- | --- | --- |
| `unread` | **无行** | 隐含状态，不落默认记录；读取不会写入 |
| `pending` | 行 | 已确认看过，尚无采用决定 |
| `adopted` | 行 | 消费者决定采用 |
| `ignored` | 行 | 消费者决定不采用 |

- 可以从 `unread` **直接**进入 `adopted` / `ignored`，不需要先写 `pending`。
- 读取（单条或批量）返回 `status`、`version`、`reason`、`outcomeUrl`、`decidedAt`；`unread` 的 `version = 0`，其余字段为 `null`。
- 纯读取只发 `SELECT`（T1 断言语句集合，T3 对整库快照断言前后一致）。

## 写合同

```ts
write(subject, {
  url,                 // 采集合同下的规范化 URL
  status,              // "pending" | "adopted" | "ignored"
  expectedVersion,     // 0 = 期望尚未有决定；否则为调用方最后读到的 version
  operationId,         // 本次决定的幂等键；重试必须复用，新决定必须更换
  reason?,             // ≤500，无首尾空白
  outcomeUrl?,         // ≤2048，仅 http(s)
})
```

结果：

| 结果 | 含义 |
| --- | --- |
| `{ ok: true, result: "updated", state }` | 决定已写入（新行或版本 +1） |
| `{ ok: true, result: "replayed", state }` | 同一 `operationId` 的完全相同重试，未新增版本/时间戳/行 |
| `{ ok: false, failure: "version_conflict", current }` | `expectedVersion` 与当前版本不符，较旧或并发落后的操作被拒绝 |
| `{ ok: false, failure: "operation_conflict", current }` | 同一 `operationId` 携带不同决定内容（客户端错误），不静默改写 |
| `{ ok: false, failure: "news_not_found" }` | 新闻不在索引中（写路径要求文章存在） |
| `{ ok: false, failure: "source_not_authorized" }` | 新闻来源不在该消费者的有效来源集合内 |
| `{ ok: false, failure: "invalid_request" }` | 入参超出存储合同，且不访问数据库 |
| `{ ok: false, failure: "invalid_subject" / "account_not_found" / "consumer_not_found" }` | 主体不可用或不存在 |

## 幂等与并发契约

写路径是**一条**带条件的 `INSERT ... SELECT ... ON CONFLICT DO UPDATE ... WHERE` 语句，和「当前行」「新闻来源」两条 `SELECT` 一起放在同一个 D1 batch（事务）里：

- 插入只在 `poc_news` 行存在且其 `source_id` 落在 GLN-006 有效集合（以 JSON 数组传入 `json_each`）时才可能发生；不存在「先查后写」的 JS 竞态窗口。
- 更新同时要求 `version = expectedVersion` **且** `last_operation_id <> operationId`。因此：
  - 相同操作重复提交：第二次不写行、不增版本、不改时间戳，返回 `replayed`；
  - 较旧操作延迟到达：版本不匹配，返回 `version_conflict`，不覆盖新决定；
  - 同一新闻两个冲突操作并发：数据库唯一键 + 版本守卫保证**恰好一个**胜出，另一个得到 `version_conflict`；测试用 `Promise.all` 在真实 D1 上断言该不变量；
  - 重放识别先于版本检查：客户端丢失第一次响应、用原始 `expectedVersion` 重试仍得到 `replayed`；用重新读到的版本重试同一 `operationId` 也不会再加版本；
  - 重放识别只依赖 D1 中的 `last_operation_id`，不依赖进程内 Map，因此进程重启、新请求、另一设备都能识别。
- 时间戳只是观察值，排序完全由 `version` 决定；不使用客户端时钟。

## 权限边界

- 主体只能来自服务端已验证凭证派生的 `GuanlanSubject`（GLN-006 `subjectFromPrincipal`）；运行时重新校验形状，非法即 `invalid_subject` 且不访问数据库。普通 DTO、工具参数、URL 都不能指定另一账户/消费者。
- 写入与读取都先调用 `createD1SubscriptionReader(...).read(subject)`，用 `effective.sourceIds` 作为**唯一**授权来源集合；空集合表示零可见来源，绝不回退到全局新闻。
- 写路径要求当前 `poc_news.source_id` 在有效集合内；读路径接受「当前新闻来源」与「账本记录的授权来源」的并集，用于新闻被清理后的记忆读取，且并集必须与当前有效集合相交，否则 `source_not_authorized`。历史指纹不能绕过当前订阅权限（T3 有取消订阅后的负例）。
- 不泄漏另一账户/消费者的处理状态：账本按主体三元组隔离，跨账户同名消费者在数据库层就是不同行。

> 内部服务为了可审计区分 `news_not_found` 与 `source_not_authorized`。将来若把该服务接到公网/MCP，边界层必须把两者折叠成同一个不透明「不可用」错误，避免暴露全局索引内容；当前没有这样的接口。

## 读合同

- `read(subject, { urls })`：1..50 个 URL，重复项按规范化后去重，结果按首次出现顺序返回。
- 批量是**原子**的：任一 URL 未知或无权时整批显式失败，不把失败项混成 `unread`。调用方（GLN-009）应从已授权新闻页取 URL，并对失败显式重试/报错。
- `unread` 是缺失记录：读路径只发 `SELECT`，不创建默认行。

## 与新闻索引生命周期的关系

- 删除 `poc_news` 行后，账本行仍在；读取凭 `source_id` 与当前权限复核后返回原决定（T3 覆盖）。
- 重新采集同一规范 URL 后，指纹不变，决定仍是同一条，可直接在新版本上继续更新。
- 新闻不在索引中时**不允许**新写决定（写路径要求文章存在），避免凭历史指纹写入不可核实的记录。
- 本卡不实现 90 天清理、墓碑格式、删号/撤销流程；`0004` 的键设计给 C2 复用，不另建事件流。

## 迁移

- 单个增量文件 `0004_consumer_news_state.sql`，只 `CREATE TABLE` + `CREATE INDEX`，不改写/重建 `0001..0003` 的任何表，不回填数据。
- 全新库与「已填充 `poc_sources` / `poc_news` / 账户 / 消费者 / 订阅 / 关注点的 `0001..0003` 库」都在真实 workerd/D1 中验证：升级前后旧表逐行一致，新表为空，复合外键在升级后的库上仍然生效。
- 生产 D1 迁移、Wrangler 部署与 Cron 均未执行。

## 验证证据

- `npm run typecheck`
- `npm run test:unit`（含 `tests/consumption.test.mjs`，T1/T2）
- `npm run test:integration`（含 `tests/consumption-workerd.test.mjs`、`tests/migration-workerd.test.mjs`，T3）
- `npm run check`、`bash scripts/check.sh`、Wrangler dry-run（见 PR 与 Taskboard 执行报告中的精确 head SHA 结果）

T3 覆盖：A 账户两个消费者对同一 URL 分别为 `pending`/`adopted` 而 B 账户仍 `unread`；未知账户、跨账户错配、未授权来源、未登记新闻拒绝；纯读零写入；`unread → adopted/ignored`；相同操作重试与跨实例重放；乱序与真实并发（恰好一个胜出）；删除并重建新闻索引后决定仍在；取消订阅后历史指纹不能绕过权限；相似标题不共享状态；迁移前后旧数据不变；表级 CHECK/复合外键/级联/无 `poc_news` 外键；账本缺失时 `storage_failure` 而非 `unread`。

## 后续边界与待裁决问题

1. **MCP 状态写入工具**归后续接线卡：需要真实 Cloud Auth Guanlan 写凭证、scope 设计与 Desktop 工具批准，本卡不暴露公网写接口。
2. **`expectedVersion` 的 Agent 友好度**：当前合同要求调用方先读再带版本写入。若后续希望 Agent 无感写入，需要产品决定「读-改-写」重试语义是否由 MCP 层封装，而不是放宽数据库守卫。
3. **批量读的原子性**：当前任一 URL 无权即整批失败，保证不把拒绝伪装成 `unread`；若 GLN-009 需要「部分成功 + 逐项错误」，应作为其读取合同的一部分显式设计，不能在本卡静默放宽。
4. **C2 清理/删号**：账本键已为墓碑与撤销复用，但保留期限、用户删除路径与审计要求仍需独立合同。
5. **旧数据模型冲突**：未发现必须改造 `poc_news` 全局 URL 去重或索引架构的问题；若未来需要「同一文章多来源」身份，应另行裁决，不在本卡扩张。
