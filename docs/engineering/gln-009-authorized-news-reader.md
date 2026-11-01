# GLN-009 · MCP 授权新闻分页与消费状态查询

Issue: [#16](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/16). 本文说明**已实现的只读 MCP 新闻读取合同**，不宣称 Cloud Auth 真实令牌联调、状态写回工具、GUI 配置或生产部署已经交付。

## 交付物

| 文件 | 作用 |
| --- | --- |
| `src/mcp/service.ts` | 授权新闻读取器：GLN-006 授权来源集合 + GLN-007 消费账本 + 有界分页扫描 |
| `src/mcp/capabilities.ts` | 扩展 `NEWS_INPUT_SCHEMA` / `NEWS_OUTPUT_SCHEMA` / `NewsPage` / Markdown 渲染 |
| `src/mcp/server.ts` | 工具参数透传与显式错误映射（不再吞成空页） |
| `tests/news-query.test.mjs` | T1/T2：查询规范化、LIKE 转义、游标绑定、失败语义、扫描预算、只读语句 |
| `tests/news-workerd.test.mjs` | T3：真实 Miniflare/workerd + D1 + 真实 MCP transport（现代/legacy） |

**没有**新增 D1 迁移、第二套状态表、写回工具、Cron、采集触发、新路由、新身份系统或部署配置。

## 身份与授权

- 唯一身份入口是服务端已验证的 MCP `authInfo`：`principalFromAuthInfo` → `GuanlanPrincipal` → GLN-006 `subjectFromPrincipal`。工具参数不能指定或切换 `accountId` / `consumerId`；`guanlan_whoami` 与新闻工具都只读 token 派生身份。
- 每次调用都重新执行 `createD1SubscriptionReader(...).read(subject)`，用 `effective.sourceIds` 作为**唯一**授权来源集合，并把它作为 SQL 条件 `source_id IN (SELECT value FROM json_each(?))`（JSON 数组绑定，避免参数个数上限）。
- `sourceIds` 为空 = 零可见来源，返回合法空页（`items: []`, `nextCursor: null`），绝不回退全局 `poc_news`。
- 显式 `sourceId` 不在有效集合内时同样返回空页，不报错、不区分「不存在」与「无权」，避免探测全局新闻/他人来源。
- 主体未 provisioning（`account_not_found` / `consumer_not_found`）与存储故障是**显式工具错误**，不是空页。
- 游标不是授权凭证：任何翻页请求都重新做上述授权查询；游标只携带位置。即使当前订阅为空或指定了未授权 `sourceId`，提供的游标仍须先通过身份、筛选集合和完整性校验；畸形游标不可被提前返回的空页吞掉。

## 查询合同

| 参数 | 语义 |
| --- | --- |
| `limit` | 1..50，默认 20 |
| `cursor` | 上一页返回的 opaque `nextCursor`；绑定当前主体与筛选集合 |
| `sourceId` | 可选，限定到一个**当前有效**来源 |
| `status` | `unread` / `pending` / `adopted` / `ignored` 的非空子集；默认 `["unread","pending"]` |
| `keyword` | 显式词面匹配；按空白拆词，AND 组合，最多 8 词、单词 ≤64 字符、总长 ≤200 |
| `ingestedAfter` / `ingestedBefore` | 采集时间范围（含端点，ISO 8601，服务端规范化为 UTC） |
| `publishedAfter` / `publishedBefore` | 上游发布时间范围（含端点）；`published_at IS NULL` 的行在有发布时间条件时被排除 |

- **状态语义**：`unread` 是 GLN-007 账本中**没有行**；`pending/adopted/ignored` 是已存行。默认只返回 `unread + pending`，`adopted/ignored` 属于历史，必须显式请求。同一 URL 在不同消费者上状态独立，跨账户同名消费者在数据库层就是不同行。
- **关键词**：SQLite `LIKE`（ASCII 大小写不敏感）对 `title` 与 `summary` 做字面子串匹配，`%`、`_`、`\` 通过 `ESCAPE '\'` 转义，不会变成通配符。非 ASCII 大小写不做折叠。GLN-006 的 `topic` 只是用户兴趣配置，**不会**被当成文章主题分类；本卡不实现分类器或语义检索。
- **时间**：以字符串比较（存储值统一为 `toISOString()` 的 UTC 形式）；非法或超长输入显式 `invalid_query`。
- **排序**：`ingested_at DESC, url ASC`，`url` 是唯一身份，因此同时间戳多篇新闻也能稳定翻页。

## SQL 方案与状态筛选（本卡的核心工程决策）

`poc_news` 以规范 URL 为身份；GLN-007 账本以 `SHA-256(canonicalNewsUrl(url))` 的 `news_fingerprint` 为键，且**不保存 URL**。要在一个 SQL 语句里把「新闻行」与「该消费者状态」关联，SQL 必须能计算 URL 的 SHA-256。

**实测结论（真实 Miniflare/workerd + D1）**：

```text
SELECT sha256('abc')      -> D1_ERROR: no such function: sha256
SELECT sha3('abc')        -> D1_ERROR: no such function: sha3
SELECT digest('abc','sha256') -> D1_ERROR: no such function: digest
```

D1 没有 SHA-256 SQL 函数，也不能注册自定义函数。因此在不改动共享存储合同的前提下，**状态谓词无法作为 SQL `JOIN` 条件**。两种「改存储」的修法（给 `poc_news` 加派生指纹列，或给账本加规范 URL 列）都会改动 GLN-005/GLN-007 已冻结的共享表或引入第二套新闻身份，按本卡边界**不由施工方擅自实施**（见文末「需要维护者裁决」）。

本卡采用的**最小、可验证、成本有界**实现：

1. **SQL 承担所有可表达条件**：有效来源集合、`sourceId`、采集/发布时间范围、词面 `keyword`、稳定排序、keyset 游标，全部在 `LIMIT` 前完成。
2. SQL 每次只取一个有界 chunk（50 行）。
3. 对该 chunk 的 URL 用 GLN-007 批量读取消费者状态（复用 `ledger.read`，不建第二张状态表），在 JS 中应用状态谓词。
4. 若页未填满且 chunk 已用尽，继续下一个 chunk；**每次请求最多 8 个 chunk（400 行）**。
5. 返回的 `nextCursor` 指向**最后一个被扫描的行**（不是最后一个被返回的行），因此「扫描 → 状态过滤 → 截断」的语义在跨请求时仍然精确：不重复、不遗漏。
6. 预算用尽时返回已匹配的部分页 + 游标，由下一次请求从该位置继续；不把全表读入内存，也不做「固定过量抓取然后假装完整」。**即使本窗口零命中**，只要 `nextCursor` 非空便不等于“没有符合条件的新闻”；Markdown 必须明确提示继续翻页，不得把窗口空结果说成查询整体无结果。

这样满足「过滤发生在最终页面截断之前」和「有界读取」，代价是：显式查询 `adopted/ignored` 这类稀疏状态时，单次请求可能需要翻更多扫描页（由游标推进，仍是有限步数）。

### 最小修正方案（供维护者裁决，不在本卡实施）

若希望把状态谓词完全下推到 SQL（单语句、无扫描预算）：

- 方案 A：`poc_news` 增加派生列 `news_fingerprint`（`canonicalNewsUrl(url)` 的 SHA-256），采集写入时计算，并加 `(source_id, ingested_at DESC, url)` 索引；账本按指纹 LEFT JOIN。
- 方案 B：`guanlan_consumer_news_states` 增加规范 `news_url` 列（写入路径已持有规范 URL），按 URL LEFT JOIN；需修改 GLN-007「账本不保存 URL」的隐私决定。

两者都需要新的 migration、回填策略与对应用例；在维护者选定前，本卡不引入其中任何一个。

## 游标合同

- 负载：`{ v:1, a:accountId, c:consumerId, f:筛选摘要, t:ingested_at, u:url, h:完整性摘要 }`，base64url 编码，编码长度上限 12,000。
- `f` 是「主体 + 规范化筛选条件（来源、状态集合、词项、时间范围）」的 SHA-256 摘要。跨主体、改动任一筛选条件、格式错误、篡改 `t/u/h` 都返回显式 `guanlan_news_cursor_invalid`。
- `h` 是完整性校验（检测误改/损坏），**不是**认证凭据：即使攻击者重算摘要，也只能得到自己已授权结果流中的另一个位置，不能扩大权限；授权始终来自每次重新执行的 GLN-006 查询。
- `limit` 不参与游标绑定：翻页中途调整页大小不会失效。

## 输出合同

- `NewsPage`：`items[]`、`count`、`limit`、`nextCursor`。每个 item 含完整不可截断的 `id`/`url`、`title`、`summary`、`sourceId`、`publishedAt`、`ingestedAt`、`status`。
- JSON（`structuredContent`）与 Markdown 由**同一个 `NewsPage` 对象**渲染，因此集合、状态、页大小、返回数量与 `nextCursor` 必然一致。
- 字段预算：`title ≤ 500`、`summary ≤ 2000`、`url ≤ 4096`、`sourceId ≤ 2048`、页 ≤ 50 条。`title/summary` 可截断（内容）；`url`/`sourceId` 是身份，**超预算时整页显式失败**（`guanlan_news_unavailable`），绝不返回截断后的假身份。GLN-006 已证明合法来源 ID 可超过 128 字符，`sourceId` 原样返回（T3 覆盖 300 字符）。
- 失败一律 `isError: true` + 明确错误码，不带 `structuredContent`：`guanlan_news_unavailable`（存储/契约异常）、`guanlan_news_cursor_invalid`、`guanlan_news_query_invalid`、`guanlan_principal_unavailable`。错误文本不区分「他人账户/消费者是否存在」。

## 只读保证

读取路径只发 `SELECT`：不写 `pending`、不调用 Cron、不触发采集、不改租约/订阅/账本。T3 对 9 张表的整库快照断言调用前后逐行一致；T1 断言生成的语句全部是 `SELECT`。

## 验证证据

- `npm run typecheck`
- `npm run test:unit`（含 `tests/news-query.test.mjs`，T1/T2）
- `npm run test:integration`（含 `tests/news-workerd.test.mjs`，T3，真实 workerd/D1 + 真实 MCP transport）
- `npm run check`、Wrangler dry-run（见 PR 与 Taskboard 执行报告中的精确 head SHA）

T3 覆盖：A/B 两账户与 A 两消费者面对同一全局新闻表只看到各自有效来源；同一 URL 在不同消费者上分别为 pending/adopted/ignored；默认 unread+pending 与显式历史查询；120 条同时间戳新闻多页遍历不重不漏且不超页大小；来源/关键词/采集时间/发布时间组合过滤仍精确分页；`%`/`_` 字面匹配；游标跨消费者、变更过滤、篡改、垃圾值均拒绝；空订阅空页与未 provisioning 显式失败；无权来源探测返回空页；`DROP TABLE poc_news` 是显式错误而非空页；读取零写入；现代与 `2025-06-18` legacy stateless 客户端结果一致；JSON 与 Markdown 同页同状态；300 字符来源 ID 原样保留、超预算来源 ID 显式失败；WHOAMI 与工具注解不变。

## 边界与未决问题

1. **状态筛选未下推到 SQL**：受 GLN-007 指纹身份与 D1 无 SHA-256 限制，当前用有界 chunk 扫描实现；如需单语句 SQL 过滤，请裁决上文方案 A/B。
2. **真实 Cloud Auth 联调未做**：本卡只使用已存在的 MCP 认证边界与测试专用可信主体；没有真实 Guanlan Token/终端 E2E 验收。
3. **状态写回工具**不在本卡；读取不会把新闻标成 pending。
4. **稀疏状态查询成本**：扫描预算固定为每请求 400 行；极端稀疏的历史查询需要多次游标翻页，未做「按状态预建消费者索引」。
5. **Workers Free CPU**：本卡未评估长期 Cron/查询的 10ms 预算，仍以 GLN-003 结论为准。
