# GLN-006 · 账户 × 稳定消费者的有效订阅读取合同

Issue: [#13](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/13). 本文说明**已实现的只读领域合同**，不宣称 Cloud Auth 实账号授权、管理 API 或 MCP 新闻过滤已经交付。

## 身份边界

- 唯一实现入口：`src/subscriptions.ts`。调用方必须先用 `subjectFromPrincipal(principal)` 把**服务端已验证凭证派生**的主体（完整 `GuanlanPrincipal`，即 `principalFromAuthInfo(...)` 的返回值）转成 `GuanlanSubject`。
- `GuanlanSubject` 带编译期 brand：普通 DTO、工具参数或 URL 值不能在不经过 `subjectFromPrincipal` 的情况下被当作已验证主体使用。**类型无法证明来源**——手工拼出同形状对象同样能编译；真正的信任边界在凭证验证器，不在本模块。brand 运行时会被擦除，因此 `read()` 会重新校验标识形状，非法标识返回 `invalid_subject` 且不访问数据库。
- 主体格式校验至少与 `0003` 的 CHECK 同样严格（JS `trim()`/`.length` 比 SQLite 略严），不一致时 fail-closed；不存在「用空白/超长 ID 探测数据库」的路径。
- **来源 ID 不套用主体上限**：`poc_sources.id` 在 `0001` 中是无长度/trim CHECK 的 `TEXT PRIMARY KEY`，`0003` 只以外键引用它。因此端口按存储合同原样接受并返回来源 ID——129 字符或更长的合法 ID 必须能读出，不能把整个配置变成 `storage_failure`。账户/消费者 ID 仍保留 128 字符与 trim 校验。

## 有效集合规则（契约测试固定）

有效配置 = 账户级基线 ∪ **当前消费者**专属增量，只读取 `0003` 的六张表：

| 维度 | 去重 | 排序 | 层级优先级 |
| --- | --- | --- | --- |
| 来源 | 按 `source_id` 唯一 | `source_id` 码元序 | 两层都有时 `intervalHours` 取消费者值（更具体偏好），`origin=both` 记录账户基线也覆盖；`intervalSource` 标明取值层级 |
| 关注点 | 按 `kind` + **ASCII 折叠**后的 `value` 唯一 | 先 `kind` 再折叠值 | 两层命中同一折叠值时保留**账户**的存储拼写（全体消费者继承的基线），`origin=both` |

- ASCII 折叠与存储层的 `COLLATE NOCASE` 完全一致（只折叠 A–Z）；不能在这里折叠更多，否则会合并数据库视为不同的值。
- 相同 `value` 的 `keyword` 与 `topic` 是两个关注点，不互相吞并。
- 订阅上的 `interval_hours` 只是用户偏好，**绝不回写** `poc_sources.interval_hours`；读取不触发采集、不写消费状态、不影响 Cron 调度字段。
- `origin=both` 的输出只携带**生效值**（消费者值）；账户基线值仍保存在表中，不随输出返回，因此下游不能把它当成「账户偏好已被读取」。
- `read()` 只做**存在性与归属**校验：账户存在，且 `(account_id, consumer_id)` 组合存在于 `guanlan_consumers`。它不证明调用方就是该主体——命名一个真实存在但并非调用方的主体同样会成功。防止越权命名的是凭证验证器，本卡不重新实现它。

## 失败语义

| 情形 | 返回 | 说明 |
| --- | --- | --- |
| 标识形状非法（绕过 brand 的 JS 调用） | `{ ok: false, failure: "invalid_subject" }` | 不访问数据库 |
| `guanlan_accounts` 无该账户 | `{ ok: false, failure: "account_not_found" }` | |
| 账户存在，但 `guanlan_consumers` 无该 `(account_id, consumer_id)` | `{ ok: false, failure: "consumer_not_found" }` | 含「消费者属于另一个账户」的越权探测 |
| 主体有效但没有任何订阅/关注点 | `{ ok: true, effective: { sources: [], sourceIds: [], interests: [] } }` | 空集合是**针对该主体的正面回答**，绝不回退全局 `poc_news` |
| D1 读失败或结果集形状不符合查询承诺（缺行、缺 `results`、计数不是数字） | 抛 `SubscriptionReadError{ code: "storage_failure" }` | 不降级为空成功，避免把故障或畸形结果伪装成「没有订阅」 |

`read()` 只发出 `SELECT`，三条查询作为一个 D1 batch 执行，避免并发配置变更造成撕裂视图。存在性判定要求**恰好一行**且 `accounts`/`consumers` 为数字，来源/兴趣结果集必须是数组——畸形负载一律 `storage_failure`，不会被读成「空配置」。

## 供 GLN-009 复用的授权来源集合

`effective.sourceIds` 即**经权限验证后**、按确定顺序去重排序的来源 ID 集合，可直接用于 `poc_news` 的 SQL 过滤：

```ts
const read = await createD1SubscriptionReader(env.DB).read(subject);
if (!read.ok) return forbidden(read.failure);          // 明确拒绝，不返回新闻
if (read.effective.sourceIds.length === 0) return emptyPage(); // 零可见来源
const placeholders = read.effective.sourceIds.map(() => "?").join(",");
// SELECT ... FROM poc_news WHERE source_id IN (placeholders) ...
```

`sourceIds` 为空表示「零可见来源」，调用方不得把它当作「不加来源条件」。

## 复用入口与边界

- 管理 API（后续）与 MCP 工具必须复用同一个 `createD1SubscriptionReader` 与同一套失败语义，不另造平行授权路径。
- 本卡**不**改动 `src/mcp/service.ts` 的全局读取：MCP 新闻分页与授权过滤属于 GLN-009，`guanlan_news_recent` 目前仍是全局读取（已知缺口，见 PR 风险）。
- 不新增 D1 迁移、不开放公网接口、不实现 CRUD、不接真实 Cloud Auth 账号。

## 验证证据

- `tests/subscriptions.test.mjs`（T1/T2）：合并/去重/排序、**双向**偏好优先级（消费者值高于或低于账户值都取消费者，排除 min/max）、标识与行级契约校验、**超过 128 字符与带空白的来源 ID 原样返回**、畸形存在性负载、失败语义、只发 `SELECT`。
- `tests/subscriptions-workerd.test.mjs`（T3，真实 Miniflare/workerd + D1）：两账户共享同一 source 的各自继承、同账户两消费者的独有增量、消费者偏好双向生效（账户 2h/消费者 8h → 8h）、跨账户与错配主体拒绝、空订阅零可见来源（并证明删除 `poc_news` 后仍不依赖它）、删除域表时 `storage_failure` 而非空成功、**129/300 字符来源 ID 在真实 D1 中正常读出**、读取无副作用、删除消费者专属订阅不影响共享基线与兄弟消费者。
- 两者均进入 `npm run test:unit` / `npm run test:integration`，因此 `npm run check` 与 `bash scripts/check.sh` 都会执行。
