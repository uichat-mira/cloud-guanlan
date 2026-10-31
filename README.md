# Cloud Guanlan · 云端观澜

**Mira Cloud 的基础新闻采集与聚合服务。**

观澜接受用户配置的公共/私人新闻源与关注点，按小时级配置持续采集**标题、摘要、原文链接及必要元数据**，向授权的外部 Agent 提供统一、可追溯、可增量消费的新闻候选，并维护**每个消费者独立且持久的处理状态**。

观澜负责“采集和记账”，不负责“理解与决策”。外部 Agent 自行选择是否 Web Fetch 原文、是否采用新闻，并明确回写处理结果。

> **当前阶段：GLN-001/002 基础采集 POC 已完成；GLN-003 在专属 Cloudflare Canary 实测了 Cron、采集、D1 与 CPU。尚未上线多用户业务服务或完成 Free CPU 稳定性验收。**
> 请勿将本 README 中的目标能力理解为已经上线的 API 或 Cloudflare 服务。

## 设计入口

**[产品与服务设计 v0](docs/product-design.md)** 是本仓库产品决策、非目标、消费状态、授权边界及待决问题的单一真相源。README 只做概览，不重复维护完整契约。

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

当前 [GLN-003](https://github.com/uichat-mira/cloud-guanlan/issues/6) 正在完成 Workers + D1 的隔离实测及性能优化。专属测试环境真实执行过 Cron、Atom/RSS 采集和 D1 写入，**但它不是公开新闻 API，没有 Cloud Auth 或生产数据库接入，也未通过 Free 长期容量验收**。

- [仓库工程约束](AGENTS.md)
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
