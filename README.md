# Cloud MCP Guanlan · 云端观澜

**Mira Cloud 的基础新闻采集与聚合服务。**

观澜接受用户配置的公共/私人新闻源与关注点，按小时级配置持续采集**标题、摘要、原文链接及必要元数据**，向授权的外部 Agent 提供统一、可追溯、可增量消费的新闻候选，并维护**每个消费者独立且持久的处理状态**。

观澜负责“采集和记账”，不负责“理解与决策”。外部 Agent 自行选择是否 Web Fetch 原文、是否采用新闻，并明确回写处理结果。

> **当前能力：** 已有公共 Feed 采集与 D1 租约/去重 POC、受保护的只读 MCP 服务端、GLN-005 的多用户数据模型，以及 GLN-006 有效订阅读取、GLN-007 消费者决策账本、GLN-009 的**按账户 × 稳定消费者授权、可分页/可筛选消费状态**的 MCP 新闻读取，和 GLN-010 的 **MCP 消费状态写回工具 `guanlan_news_decide`**（复用 GLN-007 CAS/幂等账本，读取页返回 `stateVersion`，写入需独立 `guanlan.write` scope）。GLN-003 的隔离 Cloudflare 实测已完成研究验收，但 Workers Free 持续 Cron CPU 裕量仍未获放行；真实 Cloud Auth 账号与 `guanlan.write` 正式签发联调、Desktop/Mobile 接入和生产上线尚未完成。
> 请勿将本 README 中的目标能力理解为已经上线的 API 或 Cloudflare 服务。

## 设计入口

**[产品与服务设计 v0](docs/product-design.md)** 是本仓库产品决策、非目标、消费状态、授权边界及待决问题的单一真相源。README 只做概览，不重复维护完整契约。

远程 MCP 是外部 Agent 的 canonical 集成入口；当前协议、Cloud Auth 边界、工具与未交付依赖见 [GLN-004 工程边界](docs/engineering/gln-004-mcp.md)。REST 不作为平行的 Agent API。

## 已确定的核心原则

- **独立云服务，多用户使用。** 身份统一由 Mira Cloud Account / Cloud Auth 提供，不再自建账号体系。
- **公共源 + 个人订阅。** 私人订阅和关注点不公开；同 URL 可以在后台复用采集，不泄漏订阅关系。
- **轻量新闻索引。** 仅标题、摘要、原文链接及必要元数据；不抓全文、不生成 AI 摘要、不做事件级聚类。
- **关键词筛选而非语义智能。** 默认按关注点读取；Agent 可以主动扩大到有权限的新闻范围。
- **明确消费状态。** 未读、已读待决、已采用、已忽略；读取无副作用，显式回写，换会话后不丢处理记忆。
- **每个消费者独立。** 不同 Agent 对同一条新闻可以做不同决定，状态可附可选理由和成果链接。
- **面向 Agent 的统一视图。** Markdown 优先、JSON 辅助；每个 Agent 可以获得专属、可撤销的私人只读链接，写入仍需单独授权。
- **建议不等于修改。** Agent 可以提出订阅配置建议，只有用户确认后才能生效。
- **新闻索引保留 90 天。** 精简去重指纹和处理记忆长期保留，仍支持授权撤销及必要的数据删除。
- **小时级采集间隔配置。** 不要求实时推送。

## 首选部署方向（待技术验证）

以 **Cloudflare Workers Free + Cron Triggers + D1** 为第一候选，力求零额外费用、有限资源下的可靠服务；**这不排除未来上阿里云**，但大陆用户入口及新闻源出口可达性都必须真实验证，多 Worker/双部署暂不建设。**已验证隔离 Canary 的真实运行，但 10ms Free 单次 CPU 仍缺乏可靠余量；免费额度耗尽时的降级优先级仍由维护者决定。**

不为首版默认引入 LLM、向量检索、浏览器抓取、内置 Agent 或额外付费基础设施。

## 与已有 Mira Desktop 的关系

Desktop 的本地 NewsHub 已有采集、订阅、SQLite 缓存和检索实现。这里是**新的云服务边界**，不是将整个桌面后端原样搬进 Worker；本仓库不自动授权改变或移除现有桌面能力。

参考：

- [Mira Cloud Auth 设计](https://github.com/uichat-mira/.github/blob/main/docs/engineering/mira-cloud-auth.md)
- [Desktop dev](https://github.com/uichat-mira/mira-desktop/tree/dev)
- [Cloudflare Workers 官方限制](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare D1 定价与免费额度](https://developers.cloudflare.com/d1/platform/pricing/)

## 项目状态与工程协作

[GLN-003](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/6) 是已完成的隔离运行研究，结论仍是不批准依赖 Free 10ms CPU 的长期 Cron；相关 Canary 保留且调度关闭。[GLN-004](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/8) 的远程 MCP 协议代码已并入 `dev`，但不代表真实 Cloud Auth 令牌或客户端已经接通。[GLN-005](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/11) 的多用户持久化模型也已进入 `dev`。[GLN-008](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/15) 的来源安全准入（精确测试 URL 白名单 + fail-closed URL 策略 + 受控登记）由 [PR #19](https://github.com/uichat-mira/cloud-mcp-guanlan/pull/19) 交付 `dev`；未部署、未开启 Cron，也未证明真实 DNS 出站防护或 Free CPU 长期余量。[GLN-006](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/13)、[GLN-007](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/14) 与 [GLN-009](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/16) 的领域合同（有效订阅、决策账本、授权分页读取）同样只进入 `dev`。[GLN-010](https://github.com/uichat-mira/cloud-mcp-guanlan/issues/22) 的 MCP 写回工具在本分支实现，使用受控测试凭证完成真实 MCP 客户端与 workerd/D1 验收；它**不是**已签发的 Cloud Auth 写权限，也未部署，仍无真实 Cloud Auth 账号、正式 `guanlan.write` 签发或生产部署。

- [仓库工程约束](AGENTS.md)
- [GLN-010 MCP 消费状态写回](docs/engineering/gln-010-mcp-consumption-write.md)：写工具 Schema、独立写 scope、`stateVersion`、错误/幂等合同与验收证据。
- [GLN-009 授权新闻分页与消费状态查询](docs/engineering/gln-009-authorized-news-reader.md)：查询/游标/状态合同、SQL 方案与剩余裁决项。
- [GLN-008 来源安全准入与受控采集边界](docs/engineering/gln-008-source-safety.md)：接受/拒绝矩阵、Workers 能力限制与剩余安全边界。
- [Issue 任务卡与付费 OpenCode Worker 使用说明](docs/engineering/work-items.md)
- `bash scripts/check.sh`：有运行时代码后执行完整 `npm run check`（类型、解析、真实 workerd/D1 集成、Wrangler dry-run、同环境基准）。
- [GLN-001 技术证据](docs/engineering/gln-001-poc.md)：运行结果、选型结论和剩余限制。
- `.github/workflows/mira-external-worker.yml`：可信 Issue 评论触发**付费** OpenCode Worker，交付 Draft PR 到 `dev`，不自动合并。
- `.github/workflows/ci.yml`：Mira Gate 与分支流程检查，执行结果以真实 Actions 为准。

后续按 [Mira Organization AGENTS](https://github.com/uichat-mira/.github/blob/main/AGENTS.md) 小步实现、用运行证据验收。仓库当前默认分支为 **dev**；尚未创建 `test` 或 `prod` 环境分支。

## License

[MIT](LICENSE)

## Cloudflare 隔离验收（GLN-003）

[GLN-003 工程手册与证据状态](docs/engineering/gln-003-cloudflare-canary.md) 记录专属 Workers/D1 Canary 的真实执行、CPU/行用量与安全收尾；[九次 CPU 三段剖析报告](docs/engineering/gln-003-cpu-profile.md) 记录解析与 D1 成本。**当前 Canary 保留但 Cron 关闭，不是产品上线。** `npm run test:canary` / `npm run dry-run:canary` 仅验证隔离配置和真实应用打包，不产生云端副作用。
