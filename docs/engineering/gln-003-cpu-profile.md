# GLN-003 · Cloudflare CPU 三段隔离剖析

> 任务契约：[GLN-003 Issue #6](https://github.com/uichat-mira/cloud-guanlan/issues/6)。此文是诊断方法与证据，不改变 GLN-003 的产品验收标准。

## 假设与工具

历史实测（唯一来源 Cloudflare `logs.workersLogs`，不是 `performance.now()`）：

- 原始每篇一条 SQL：25-item Atom 首次入库约 **32ms CPU**（一次观测）。
- JSON1 批量 SQL：同一公开 Atom、25 项首次入库约 **26ms CPU**（一次观测）。
- 两者不能视为受控统计上的稳定加速结论。尚未区分网络阶段、XML 解析、D1 持久化等 CPU 成本。

本次创建 **仅供 Canary 的独立编译入口** `tests/gln003-profile.worker.ts`，使用同一份代码：
- `fetch`：调用生产 `fetchLimited` 下载同一份 `https://www.cloudflarestatus.com/history.atom`；**不解析，不写新闻表**。
- `parse`：调用相同 `fetchLimited` 后使用生产 `parseWithFastXml`；**不写新闻表**。
- `full`：调用完整生产 `collectDue`（D1 原子 claim → fetch → parse → fenced batch write → success next-due）。为了让每轮在隔离库中到期，额外增加一次测试专用 `UPDATE due_at`，所以其 CPU 包含该设置开销，不能简单做无偏的阶段差值。

只能由 **Cron scheduled** 触发；公网 fetch 与真实应用一致，仅 `/health`、其他端点 404。额外两张 `gln003_profile_plan` / `gln003_profile_samples` 诊断表只在专属 Canary D1 创建，不进入仓库正式 migrations，更不能出现在生产数据库。

`gln003_profile_plan` 原子更新领取 1–9 个序号，模式轮流 `fetch → parse → full`，每种 3 次，**第十次开始直接 no-op**。运行时会记录 `run/mode/success/inserted/duration` 等非敏感标识；Cloudflare 的实际 billed CPU 通过 `logs.workersLogs` 中时间相邻的 `scheduled` 调用与 `gln003_cpu_profile` JSON 日志及 D1 样本交叉匹配。**不能把 profile worker 的少量 D1 管理开销误认为完全不存在**。

## 实验隔离与安全约束

1. 先查 Cloudflare 专属 Worker 名 `cloud-guanlan-gln003-canary`、唯一 D1 绑定和 Cron 空列表。只允许修改这一个 Worker/D1，禁止在真实产品 Worker、Relay、拾言等开启 profile。
2. 使用已测试的源码构建独立 `gln003-profile.mjs`，人工检查编译内容确实复用生产抓取/解析/调度。保留部署前的原 Canary Worker bundle SHA 以便恢复。
3. 在 D1 上创建两张上述诊断表并初始化 9 次上限，其他所有来源 `due_at` 设置为实验窗口之后。三个模式取**同一固定源**，不使用用户输入。
4. 确保 Worker 只有健康接口；启用专属 Canary **`* * * * *` Cron** 作短期剖析。检测 9 次状态后立即 PUT 空计划数组并 GET 确认 `schedules=[]`；考虑 Cloudflare 约 15 分钟 Cron 传播延迟。
5. 完成后重新上传原正式应用 bundle（不应保留诊断入口），校验 D1 binding、健康接口和没有 Cron；不修改旧资源。
6. 记录每个模式的样本数、实际 CPU、墙钟、失败、D1 插入/去重。对比应注明 **首轮 full 是首次写入，后两轮 full 是去重写入**，并解释额外 D1 诊断操作的偏差。
7. 没有足够真实样本时，报告“未取得”，绝不以本地 benchmark 代替 Cloudflare 账单 CPU。**不得据单次数字宣称 Free 10ms 达标或 P99 安全**。

### 本地验证

```sh
npm run test:profile
npm run check
```

`test:profile` 通过 Miniflare/workerd + **真实 D1 binding** 验证：9 次 scheduled（每种 3 次）、健康路径和 404、前两段没有新闻写入、第三段确实使用生产调度和去重、10 次后完全停止抓取。

## 真实运行结果

**待写入**：部署 commit、profile bundle Git SHA、9 次样本、CPU 分段结论、停机和恢复证明。若远程 Cron 无法及时触发，禁止把尚未发生的试验标为通过。
