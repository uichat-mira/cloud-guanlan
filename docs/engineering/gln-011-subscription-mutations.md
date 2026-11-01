# GLN-011 · 已批准新闻源的账户与消费者订阅变更领域服务

> 任务契约：[Issue #23](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/23)。
> 交付范围：独立的 D1 订阅变更领域 port、T1/T2 与真实 workerd/D1 T3 测试及本文。**未接真实 Cloud Auth 管理凭证、未开放 HTTP/MCP 管理接口、未改 MCP Server 或消费状态账本、未部署。**

## 1. 决策摘要

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 可信管理授权 | `src/subscription-mutations.ts` · `managementGrantFromPrincipal` / `GuanlanManagementPolicy` | 只把已验证 principal + 明确 authority 变成 `GuanlanManagementGrant`；本卡不提供生产策略实现 |
| 变更领域 port | `src/subscription-mutations.ts` · `createD1SubscriptionMutator` | account / consumer 两层 upsert / remove，复用原表 PK/FK 与 D1 事务批 |
| 来源准入 | `src/source-safety.ts` · `evaluateSourceUrl` | 每次 mutation 重新校验 `poc_sources.url` 是否仍是 GLN-008 精确批准 URL |
| 有效视图 | `src/subscriptions.ts` · `createD1SubscriptionReader` | 唯一继承/覆盖算法；mutation 成功后直接调用它返回 `effective` |
| 数据模型 | `migrations/0003_guanlan_accounts.sql` | 复用 `guanlan_account_subscriptions` / `guanlan_consumer_subscriptions`，**不新增迁移** |

**核心结论：** 订阅变更只写目标两层订阅表；`intervalHours` 只是偏好，绝不回写 `poc_sources.interval_hours`、`due_at`、租约或 Cron。当前表没有 `enabled` 字段，因此「停用」在本轮就是**取消该层订阅**（`remove`），不引入新的状态机。

## 2. 可信管理授权边界

读取新闻的 `GuanlanSubject` **不等于**管理授权。本卡把两类 authority 分开：

| authority | 允许操作 | 不允许 |
| --- | --- | --- |
| `account` | 本账户的账户级订阅 upsert/remove | 任何消费者专属订阅；其他账户 |
| `consumer` | **仅本人 consumer** 的专属订阅 upsert/remove | 账户级共享订阅；同账户兄弟消费者；其他账户 |

- 唯一构造入口是 `managementGrantFromPrincipal(verifiedPrincipal, authority)`；它复用 GLN-006 的 `subjectFromPrincipal` 校验账户/消费者标识，非法主体返回 `invalid_principal`，非法 authority 返回 `not_authorized`。
- `GuanlanManagementGrant` 带编译期 brand，普通 principal、`GuanlanSubject`、DTO 或工具参数不能直接当授权用；运行时 brand 会被擦除，因此 `mutate()` 会重新校验 grant 形状，任何不合格输入返回 `forbidden` 且不访问 D1。
- **本卡不实现生产 `GuanlanManagementPolicy`**：Cloud Auth 尚未冻结观澜管理授权合同。测试用 fixture policy 从已验证 principal 模拟管理身份；普通 `guanlan.read` scope 不会被当成管理权限。未来接入时必须由服务端策略根据已验证凭证决定 authority，不能接受用户自报 role/accountId/consumerId。
- **mutation 输入没有 accountId/consumerId 字段**。目标账户/消费者只来自 grant；消费者级操作的目标永远是 grant 的 consumer。因此 DTO 无法选择另一账户、兄弟消费者或跨租户主体；额外传入的身份字段会被忽略。

## 3. 输入 / 输出 / 失败合同

### 3.1 输入

```ts
{ level: "account"  | "consumer",
  op:    "upsert"   | "remove",
  sourceId: string,          // poc_sources.id，必须真实存在且 URL 通过 GLN-008
  intervalHours?: number }   // upsert 必填，整数 1..24；remove 忽略
```

- `sourceId` 沿用 `poc_sources.id` 的存储合同：任意非空字符串，不套用账户/消费者 128 字符上限。
- `intervalHours` 必须是 1–24 的整数；浮点、字符串、越界、缺失均返回 `invalid_input`。
- 不接收任意 URL、来源发现、关键词、消费者创建/删除或 `enabled` 标志。

### 3.2 成功结果

```ts
{ ok: true, changed: boolean, level, sourceId,
  intervalHours: number | null,        // remove 后为 null
  effective: EffectiveSubscription }   // 来自 GLN-006 reader
```

`changed` 只表示本次调用是否真的插入、改价或删除了行：重复相同 upsert、重复 remove 都是 `changed: false`，且不重写 `created_at`。成功后直接调用原 `createD1SubscriptionReader().read(subject)`，不维护第二套继承算法。

### 3.3 失败语义

| 情形 | 结果 | 副作用 |
| --- | --- | --- |
| grant 形状非法 / 非管理主体 | `{ ok:false, failure:"forbidden" }` | 无，不访问 D1 |
| level 与 authority 不匹配 | `{ ok:false, failure:"forbidden" }` | 无，不访问 D1 |
| DTO 形状/interval/sourceId 非法 | `{ ok:false, failure:"invalid_input" }` | 无，不访问 D1 |
| grant 的账户不存在 | `{ ok:false, failure:"account_not_found" }` | 无 |
| grant 的消费者不存在（含同 label 在别账户） | `{ ok:false, failure:"consumer_not_found" }` | 无 |
| `poc_sources` 无该 id | `{ ok:false, failure:"source_not_found" }` | 无 |
| 来源存在但 URL 不是 GLN-008 精确批准 URL（含历史 POC 行、被篡改 URL） | `{ ok:false, failure:"source_not_approved" }` | 无 |
| D1 失败、batch 结果形状不符、写后 GLN-006 读取失败 | 抛 `SubscriptionMutationError{ code:"storage_failure" }` | 不伪装成功；写入幂等可重试 |

`account_not_found` / `consumer_not_found` 只描述 grant 自己的已验证主体，不暴露其他账户是否存在；消费者级目标不可由 DTO 指定，因此不存在跨租户消费者探测。来源错误只涉及公共来源目录。

## 4. 原子性、幂等与并发

每次 mutation 是「一次来源准入 SELECT + 一个四语句 D1 batch」：

1. 预读 `poc_sources(id,url)` 并执行 `evaluateSourceUrl`；不通过则不进入 batch。
2. batch 内写语句本身带条件：
   - upsert 用 `INSERT ... SELECT ... JOIN poc_sources ON id=? AND url=? WHERE consumer 存在`，再 `ON CONFLICT(...) DO UPDATE SET interval_hours=excluded.interval_hours WHERE interval_hours<>excluded.interval_hours`；
   - remove 用 `DELETE ... WHERE ... AND EXISTS(来源仍为同一 URL) AND EXISTS(consumer 仍存在)`。
3. 同 batch 再读回主体存在性、来源行与订阅行；任何与语句承诺不符的结果都抛 `storage_failure`。

因此：

- **幂等**：重复 upsert 同 interval、重复 remove 均为 `changed:false`，不产生重复行、不改 `created_at`。
- **并发**：PK/复合 FK 与 D1 串行事务保证最多一行；并发相同 upsert/remove 恰好一次 `changed:true`，其余为 no-op。
- **跨账号/跨消费者**：账户与消费者只来自 grant；消费者级操作永远落在 grant 的 consumer 上；复合 FK 是最终权威。
- **无部分写入**：写、存在性、来源回读、行回读在同一 D1 batch；来源或主体在预读后变化时，写语句条件不成立，batch 返回明确失败而非半写入。
- **写后读取失败**：写入已提交但 GLN-006 读取失败时抛 `storage_failure`，不会返回伪造的 effective；由于写入幂等，调用方可安全重试。

## 5. 继承与覆盖（完全复用 GLN-006）

- 账户级行是共享基线；消费者级同来源行覆盖 `intervalHours`（`origin=both`，`intervalSource=consumer`）。
- 撤消费者覆盖：删除 consumer 行，reader 立即恢复账户级 interval（若账户行仍在）。
- 撤账户基线：只删账户行，仍存在的 consumer 专属行继续生效；不会级联删除消费者配置。
- 消费者专属来源（账户没有）只对该消费者可见；同账户兄弟消费者与其他账户不受影响。
- 以上规则没有在 mutation 服务里重新实现；测试每次都调用原 reader 比对 `sourceIds` / `sources` / `origin` / `intervalSource`。

## 6. 来源准入与共享采集边界

- 只操作 `poc_sources` 中真实存在、且 `url` 仍通过 `evaluateSourceUrl`（GLN-008 精确白名单）的来源。
- 历史 `poc_sources` 行（例如 `https://example.com/legacy.xml`）不会因为存在就变成可订阅来源；返回 `source_not_approved`。
- 来源 id 不是安全边界：判断以存储 URL 为准。把已批准行的 URL 改成未批准值后，同一 id 立即被拒绝；手工行只要 URL 精确命中批准清单则可订阅（仍受 UNIQUE URL 约束）。
- 不登记新来源、不写 `poc_sources`、不写 `poc_news`、不改 `interval_hours`/`due_at`/租约/`retry_count`/Cron；T3 用前后行快照证明这些表逐行一致。
- 不写 `guanlan_account_interests` / `guanlan_consumer_interests` / `guanlan_consumer_news_states`。

## 7. 数据模型与非目标

- **不新增迁移**：`0003` 的两张订阅表、PK、复合 FK 与 `interval_hours BETWEEN 1 AND 24` 已足够。
- **没有 `enabled` 字段**：本轮「取消订阅」就是删除该层行；不虚构停用状态、不引入第二状态机。后续若需要保留停用记录，另行设计迁移与合同。
- 非目标：任意 RSS URL 登记、自定义来源发现、关键词管理、消费者创建/删除、HTTP 管理 API、MCP 订阅编辑工具、Cloud Auth 改造、Desktop/Mobile UI、采集调度器、第二张订阅表、部署。
- 不改 `src/mcp/server.ts`、`src/mcp/capabilities.ts`、`src/mcp/service.ts` 或 `src/consumption.ts`，避免与 GLN-010 并行踩线。

## 8. 验证证据

新增/更新：

- `tests/subscription-mutations.test.mjs`（T1/T2）：grant 构造与 authority 校验、普通读取权限不成为管理权限、principal/subject 不能冒充 grant、DTO 形状/interval/sourceId 负例、account/consumer authority 不互换、未知/未批准来源不访问 D1、成功路径复用 GLN-006 effective、身份字段不能从 DTO 注入、幂等 no-op、主体缺失、D1 失败/畸形 batch/写后读取失败均为 `storage_failure`、写 batch 只触及两张订阅表。
- `tests/subscription-mutations-workerd.test.mjs`（T3，真实 Miniflare/workerd + D1）：
  - 账户 A/B、同账户 A1/A2：账户基线、消费者覆盖、撤覆盖恢复、撤账户保留消费者行、账户/消费者/来源互不串写；
  - 重复 upsert/remove 与 5 路并发 upsert/remove：恰好一次 `changed:true`、PK 一行、无重复/复活；
  - 未知来源、历史未批准行、被篡改 URL 拒绝且零写入；批准 URL 的手工行可订阅；
  - consumer 不能改 account、account 不能改 consumer、只读 subject 不是 grant、DTO 身份字段被忽略、同 label 跨账户隔离、缺失主体拒绝；
  - 删除订阅表后 `storage_failure` 且无部分写入；
  - 每次操作前后 `poc_sources` / `poc_news` / 账户 / 消费者 / 关注点 / 消费状态账本快照完全一致，`PRAGMA foreign_key_check` 为空，`poc_sources` 的 interval/due_at/租约/retry 不变。
- 两者进入 `npm run test:unit` / `npm run test:integration`，因此 `npm run check` 与 `bash scripts/check.sh` 都会执行。

本地执行结果（2026-11-01，Windows，Node 24.9.0，Miniflare/workerd）：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test:unit` | 104 passed / 0 failed（含本卡 12 个） |
| `npm run test:integration` | 76 passed / 0 failed（含本卡 6 个）；本机 Windows 默认并行跑 10 个 workerd 测试文件会触发 Node/workerd 资源耗尽（既有 `tests/workerd.test.mjs` OOM、`tests/scheduler-workerd.test.mjs` 计时抖动），用 `--test-concurrency=1` 串行执行全部 76 个通过。Ubuntu CI（4 vCPU，默认并发更低）是权威门禁 |
| `npm run dry-run` | 通过，Total Upload 987.26 KiB / gzip 212.85 KiB |
| `npm run test:benchmark` | 通过 |
| `npm run test:canary` | 6 passed / 0 failed |
| `npm run dry-run:canary` | 通过，Total Upload 987.89 KiB / gzip 212.91 KiB |
| `npm run test:profile` | 1 passed / 0 failed |
| `bash scripts/check.sh` | 由精确 head 的 Ubuntu CI 验证（本机无可用 WSL bash） |

`npm run check` 的 typecheck、unit、dry-run、benchmark、canary、canary dry-run、profile 各阶段均通过；唯一未能在本机以默认并行方式一次跑绿的是 integration 阶段，原因如上，与本次改动表面无关。CI 日志是最终证据。

**T3 能证明：** 真实 workerd/D1 中的两层隔离、继承/覆盖、幂等/并发、来源准入负例、权限负例、共享表不变量与 D1 故障语义。
**T3 不能证明：** 真实 Cloud Auth 管理凭证/策略、HTTP/MCP 管理接口、Desktop/Mobile UI、生产部署或 Cloudflare 生产出站行为。本卡没有这些交付，也不宣称它们已存在。
