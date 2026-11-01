# GLN-010 · MCP 消费状态写回与独立客户端读写验收

Issue: [#22](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/22). 本文说明**已实现的 MCP 写工具合同**，不宣称 Cloud Auth 已正式签发 `guanlan.write`、未部署 Cloudflare、也未完成 Cloud Agent 接线或真实用户生产授权。

## 交付物

| 文件 | 作用 |
| --- | --- |
| `src/mcp/capabilities.ts` | `guanlan_news_decide` 的输入/输出 Schema、写注解、错误码、Markdown；`NewsItem.stateVersion` |
| `src/mcp/service.ts` | 授权新闻页返回 `stateVersion`；`createNewsDecider` / `createD1NewsDecider` 复用 GLN-007 账本 |
| `src/mcp/server.ts` | 用官方 SDK v2 `registerTool` 注册写工具；独立写 scope 检查；错误分类与 `isError` 边界 |
| `src/mcp/config.ts` | `GUANLAN_WRITE_SCOPE = "guanlan.write"` 与 `hasWriteScope` |
| `src/mcp/runtime.ts` | 为运行时注入 D1 decider |
| `tests/decision.test.mjs` | T1/T2：Schema 边界、身份来源、错误分类、写 scope 独立性 |
| `tests/decision-workerd.test.mjs` | T3：真实 Miniflare/workerd + D1 + 官方 MCP Client 全链路 |
| `tests/mcp-fixtures.ts` | 受控的读+写测试凭证（仅测试用） |

**没有**新增 D1 迁移、第二套状态表、HTTP 路由、身份平台、OAuth 发行方、Cron、部署配置或管理 UI。写路径唯一权威仍是 GLN-007 `src/consumption.ts`。

## 身份与授权

- 主体只来自服务端已验证的 MCP `authInfo`：`principalFromAuthInfo` → `GuanlanPrincipal` → `subjectFromPrincipal`。工具参数没有 `accountId`/`consumerId` 字段；即使客户端额外传入也会被 Schema 丢弃，写入仍落在 token 派生的账户×消费者上（T3 有断言）。
- **读 gate 不变**：`requireBearerAuth` 仍按 `MCP_REQUIRED_SCOPES`（默认 `guanlan.read`）验证整条 `/mcp` 请求；Host/Origin、JWT issuer/audience/JWKS、401/403 与 protected-resource metadata 均未改动。
- **写权限独立**：`guanlan_news_decide` 处理器额外要求 token 携带 `guanlan.write`。只读凭证可以 `tools/list` 看到该工具，但调用立即返回 `guanlan_decision_forbidden`，且**不访问 D1**。写 scope 不进入读工具，读请求也不需要写 scope。
- `scopes_supported` 仍只声明读 gate 所需 scope：`guanlan.write` 尚未由 Cloud Auth 正式签发，本卡不把计划中的写权限伪装成已开通能力；写 scope 在工具调用时检查。

## 写工具合同

`guanlan_news_decide`：

| 参数 | 语义 |
| --- | --- |
| `url` | 规范新闻 URL（与 `guanlan_news_recent` 的 `id`/`url` 一致）；复用采集的 `canonicalNewsUrl` 规则 |
| `status` | `pending` / `adopted` / `ignored`；`unread` 不可写（它是“没有行”） |
| `expectedVersion` | CAS 前置版本：上一次读到的 `stateVersion`，未读为 `0` |
| `operationId` | 单次决策的幂等键（1..128，无首尾空白）；**幂等范围是 (account, consumer, 新闻条目)**：同一决策重试必须复用，同一新闻的新决策必须更换；不同新闻可复用同一 id，但推荐每条新闻使用唯一 id |
| `reason?` | 可选 1..500 字符，无首尾空白 |
| `outcomeUrl?` | 可选 1..2048 字符的 http(s) 成果链接 |

输出（成功）：

```json
{
  "result": "updated | replayed",
  "state": {
    "url": "...", "status": "adopted", "version": 2,
    "sourceId": "feed-1", "reason": null, "outcomeUrl": null,
    "decidedAt": "2026-11-01T00:00:00.000Z"
  }
}
```

- 注解：`readOnlyHint=false`、`destructiveHint=false`、`idempotentHint=true`、`openWorldHint=false`。
- JSON（`structuredContent`）与 Markdown 由同一个 `{ result, state }` 渲染，版本与状态必然一致。
- 成功结果不包含内部指纹；`decidedAt` 是服务端观察时间，不参与排序。

## 读取页的版本可见性

- `guanlan_news_recent` 的每个 item 新增 `stateVersion`：已存决策为 GLN-007 `version`（≥1），未读为 `0`。
- JSON 与 Markdown 同时渲染该字段（`State version: N`）。
- 读取仍然零写入：`stateVersion` 来自 GLN-007 的批量只读查询，不创建默认行。
- 默认 `status` 过滤仍是 `unread+pending`；写入 `adopted/ignored` 后需显式请求对应状态才能在页中看到（与 GLN-009 一致）。

## 错误合同

所有失败均为 `isError: true`、单一文本 content、**无 `structuredContent`**；成功才有 `structuredContent`。

| 情况 | 工具错误码 | 说明 |
| --- | --- | --- |
| 成功写入 | —（`result: updated`） | 版本 +1（或首次为 1） |
| 相同 `operationId` 完全相同重试 | —（`result: replayed`） | 不增版本、不改时间戳 |
| `expectedVersion` 过期/并发落后 | `guanlan_decision_version_conflict` | 文本附当前受限状态 JSON（`url`/status/version/reason/outcomeUrl/decidedAt）；无已存行但传了非零版本时该 JSON 为 `{"status":"unread","version":0,...}` |
| 同一 `operationId` 携带不同内容 | `guanlan_decision_operation_conflict` | 不静默改写；文本附当前状态 |
| 新闻不存在 / 来源不在有效集合 | `guanlan_decision_not_available` | **同一不透明错误**，不区分“不存在”与“无权/属于他人账户” |
| 无 `guanlan.write` | `guanlan_decision_forbidden` | 只读凭证不得改状态 |
| 主体未 provisioning | `guanlan_principal_unavailable` | 与读路径同名错误 |
| 入参越界（直接领域调用） | `guanlan_decision_invalid` | MCP 层通常先由 Schema 拒绝 |
| D1/账本故障 | `guanlan_decision_unavailable` | 不伪装成冲突、拒绝或成功 |

读工具的错误码保持 GLN-009 原样（`guanlan_news_unavailable` 等），两套错误码不会混用。

## 幂等、并发与重启

- 写路径完全复用 GLN-007 的单条条件 `INSERT ... ON CONFLICT DO UPDATE ... WHERE` 事务；本卡不新增 CAS 规则、不加锁、不建进程内缓存。
- 重放识别只依赖 D1 的 `last_operation_id`，且按 `(account_id, consumer_id, news_fingerprint)` 一行一个 `last_operation_id`；因此同一 `operationId` 用于**另一条新闻**不会冲突，而是那条新闻的独立决策。客户端应为每条新闻使用新的 `operationId`（例如 UUID）。
- 该识别跨请求、跨设备、跨 worker 重启都有效。
- 同一 `expectedVersion` 的并发写恰好一个胜出，另一个得到 `version_conflict`。
- 乱序旧写不会覆盖较新决策。
- T3 用独立 `d1Persist` 目录在两个真实 Miniflare 实例间验证：重启后状态与版本仍在，且相同 `operationId` 仍识别为 `replayed`。

## 兼容性

- 现代 `2026-07-28` 客户端与 `2025-06-18`/`2025-11-25` legacy stateless 客户端使用同一工具工厂；`tools/list` 现在返回 3 个工具。
- 既有 `guanlan_news_recent`、`guanlan_whoami`、401/403、protected-resource metadata、Host/Origin 校验与只读行为均保留。
- 未新增 session、未改变 `createMcpHandler({ legacy: "stateless" })` 配置。

## 验证证据

本卡交付的真实执行（精确结果见 PR / Taskboard 报告，对应提交 head SHA）：

- `npm run typecheck`
- `npm run test:unit`（含 `tests/decision.test.mjs`，T1/T2）
- `npm run test:integration`（含 `tests/decision-workerd.test.mjs`，T3）
- `npm run check`、`bash scripts/check.sh`（Ubuntu CI）与 Wrangler dry-run
- 独立官方 MCP Client：`@modelcontextprotocol/client@2.4.0` + `StreamableHTTPClientTransport`，**不是** Pi SDK，也不是直接调用领域函数。

T3 覆盖：写工具发现与注解；只读凭证 `forbidden` 且账本零写入；授权读取 `stateVersion=0` → 写入 → 重读版本/状态 → 相同 `operationId` 重放 → 过期版本冲突 → 复用 `operationId` 冲突 → 乱序旧写不覆盖 → JSON/Markdown 一致；跨消费者、跨账户隔离；未知新闻与无权来源同一不透明错误；参数无法切换账户/消费者；并发恰好一个胜出；D1 故障为独立 `unavailable`；未 provisioning、空订阅与 legacy 客户端；跨 Miniflare 实例重启后的状态与重放。

## 边界与未决问题

1. **`guanlan.write` 尚未正式签发**：本卡只验证受控测试凭证；Cloud Auth 的 Guanlan audience/scope 签发、撤销与无人值守委托仍归后续 Cloud Auth 合同。测试凭证不是生产授权。
2. **未部署**：没有 Cloudflare 部署、D1 迁移执行、Cron 变更或生产 smoke；`/mcp` 在缺少有效签发时仍 fail-closed。
3. **冲突回传形式**：`version_conflict`/`operation_conflict` 的当前状态是文本中的受限 JSON，而不是 `structuredContent`；这是为保持“错误无 structuredContent”的既有边界。若后续客户端需要机器可读错误负载，应作为独立合同裁决。
4. **未做**：Cloud Agent/Pi 接线、Desktop/Mobile UI、订阅变更写工具、管理 API、第二套身份或 Gateway。
5. **写 scope 的 metadata 声明**：`scopes_supported` 暂不包含 `guanlan.write`，避免把未签发能力宣称为已开通；正式签发后应同步更新发现文档。
6. **读/写授权口径的继承差异**：GLN-007 的读路径接受「已存决策来源 ∪ 新闻当前来源」，而写路径只按新闻当前来源授权。若一条新闻在决策后更换了来源，读取页可能仍返回它的 `stateVersion`，但写回会得到不透明的 `not_available`。这是 GLN-007 的既有语义，本卡未改变；需要在后续合同里统一，或明确读路径也只按当前来源。
7. **写工具的兜底错误**：处理器把非预期异常折叠为 `guanlan_decision_unavailable` 而不是原样抛出，因为官方 SDK 会把抛出的异常文本直接回显给客户端（可能泄漏内部细节）。数据库/账本故障本身已由 `ConsumptionLedgerError` 明确表示；非预期编程缺陷目前与存储故障共用同一客户端错误码，后续应通过服务端日志/告警区分。
8. **Schema 与领域校验的分工**：`reason`/`outcomeUrl`/`operationId` 的「无首尾空白」「http(s) 链接」由 GLN-007 领域校验最终裁决，MCP Schema 只约束长度与枚举；越界会得到明确的 `guanlan_decision_invalid`，而不是被静默接受。
