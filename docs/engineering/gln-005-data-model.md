# GLN-005 · D1 多用户基础模型与增量迁移

Issue: [#11](https://github.com/uichat-mira/cloud-guanlan/issues/11). 本文说明**已实现的存储合同**，不宣称 Cloud Auth 或终端接线已经交付。

## 单一身份边界

- `guanlan_accounts.account_id` 使用 Cloud Auth 将来签发/提供的**稳定账户 ID**；不保存密码、Cloud Session、设备 Token。
- `guanlan_consumers` 使用复合主键 `(account_id, consumer_id)`；同一消费者在 Desktop 与 Mobile 使用同一账户范围内的 ID 和账本，不能拿设备 ID/会话 ID 替代。
- `guanlan_account_subscriptions` / `guanlan_account_interests` 是账户共享基线；`guanlan_consumer_subscriptions` / `guanlan_consumer_interests` 是消费者的**专属增量**。有效配置需以同账户下的两层集合做 UNION；这张卡不实现公共管理 API 或 Cloud Auth 注册。
- 消费者专属关系对 `guanlan_consumers(account_id, consumer_id)` 使用复合外键，数据库拒绝把消费者附到另一个账户；每个所有者有唯一约束；关键词/主题值去掉首尾空格后用大小写不敏感的唯一键约束。应用程序创建时仍须完成入参长度/格式校验。
- `interval_hours` 在每条订阅上只是未来的**用户偏好**，当前 `poc_sources.interval_hours` 仍是唯一实际调度值。未来共享采集频率合并策略不在这张卡中推断。

## 向前兼容 / 升级

在原有 Wrangler migration 路径中顺序应用 `0001_poc.sql`、`0002_source_leases.sql`、`0003_guanlan_accounts.sql`。第三份仅**新增六张表与索引**，不改写/重建 `poc_sources`、`poc_news`，不触碰源 URL PK、租约、Cron 或 MCP。不能对已经完成过的数据库再次手动运行 `0003` 以冒充迁移系统幂等：应使用 Wrangler 自有迁移追踪。

新表使用 `ON DELETE CASCADE` 清理账户/消费者派生关系，源引用使用 `ON DELETE RESTRICT` 防止正在被订阅的共享源被删除。正式用户删除/历史数据保留和业务审计语义仍需独立合同。

## 验证与后续边界

`tests/migration-workerd.test.mjs` 在**真实 Miniflare/workerd+D1** 中覆盖空库迁移、带新闻和租约的既有库升级、跨账户复合外键、重复订阅与兴趣项、继承与独有集合、默认封闭 HTTP。由 `npm run test:integration` 和 `npm run check` 执行，不依赖 Cloudflare 凭证。

未来 Cloud Auth 的账号创建/补齐应可靠、幂等地创建账户空间；签发 Guanlan 受众与消费者约束的短期凭证，服务端验证后才能访问私有业务接口。本迁移不开放此类接口，不接受匿名主体、不伪造认证；消费状态写回和 90 天清理另立合同。
