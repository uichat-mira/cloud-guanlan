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

### 2026-10-31 18:25–18:33 UTC · 已完成 9 次真实 scheduled 调用

- **源码分支**：`feat/gln-003-cloudflare-canary`，Profile 入口提交 `7f58ec3`、完整 T3 测试提交 `fbdbc14`；[CI run #41228319868](https://github.com/uichat-mira/cloud-guanlan/actions/runs/41228319868) **T1 9/9、runtime D1 T3 13/13、Canary 6/6、Profile runtime test 1/1、Mira Gate 成功**。后续文档提交的 CI 另行检查。
- **构建/部署身份证据**：临时隔离分支 `feat/gln-003-profile-bundle-stage`，GitHub Actions [#41228436418](https://github.com/uichat-mira/cloud-guanlan/actions/runs/41228436418) 编译出完整、重用生产 `fetchLimited`/`parseWithFastXml`/`collectDue` 的专用 scheduled 入口，**Git blob `7d503624428443539826eb9ab252a34bf93953a2`**（210,236 字符）。构建用的临时可写 workflow 已删除。
- **受控环境**：仅覆盖同名 `cloud-guanlan-gln003-canary` Worker；D1 唯一绑定未更改。创建专属 `gln003_profile_plan` 和 `gln003_profile_samples` 表（不属于正式迁移）；在运行前清除该测试源此前的 25 条记录，其他来源只临时顺延到期时间且已恢复。Cron 设置为 `* * * * *`，Cloudflare 首次真正投递约 9 分钟后开始，于 18:25–18:33 UTC 每分钟运行一次，**9/9 成功且无错误**。
- 来源为同一公开 `https://www.cloudflarestatus.com/history.atom`，约 **32,218 UTF-16 字符、25 条 Atom 项目**；实际 CPU 数值取自 Cloudflare Analytics SQL `logs.workersLogs` 的 scheduled `cpuTimeMs`，并以 D1 `gln003_profile_samples.run/mode` 及分钟时间顺序核对。下列 `wall_ms` 是代码内部的阶段墙钟，不是 CPU。

| 序号 / UTC | 模式 | Cloudflare CPU | Worker 内部阶段 wall | 新增新闻 |
| --- | --- | ---: | ---: | ---: |
| 1 / 18:25 | fetch | **4ms** | 283ms | 0 |
| 2 / 18:26 | parse | **14ms** | 203ms | 0 |
| 3 / 18:27 | full | **18ms** | 1,129ms | **25** |
| 4 / 18:28 | fetch | **4ms** | 99ms | 0 |
| 5 / 18:29 | parse | **13ms** | 204ms | 0 |
| 6 / 18:30 | full | **45ms** | 1,188ms | 0（URL 去重） |
| 7 / 18:31 | fetch | **6ms** | 80ms | 0 |
| 8 / 18:32 | parse | **31ms** | 75ms | 0 |
| 9 / 18:33 | full | **19ms** | 1,201ms | 0（URL 去重） |

**分组描述性统计（n=3/组，不计算虚假的 P99）：**

| 模式 | 实测 CPU 序列 | 中位数 | 最小–最大 |
| --- | --- | ---: | ---: |
| 仅抓取 | 4, 4, 6ms | **4ms** | 4–6ms |
| 抓取 + XML 解析 | 14, 13, 31ms | **14ms** | 13–31ms |
| 完整解析 + D1 | 18, 45, 19ms | **19ms** | 18–45ms |

### 判断与可信度

1. **主线发现：XML 解析是明确的 CPU 高成本环节。** 相同源、相同生产抓取函数条件下，只抓取的 CPU 三次为 4–6ms，调用 `parseWithFastXml` 后为 13–31ms。中位数差 10ms，但不是纯解析 CPU 的无偏估计；只有三个样本，节点/冷暖/网络响应内容与 Worker isolate 状态可能影响结果。
2. **D1 完整路径也有异常长尾。** 完整模式 18/45/19ms，第二次甚至在 0 新增新闻时用了 45ms；不能断言“D1 写入只消耗 5ms”。完整路径还包含 claim、lease fencing、JSON1 去重和 profile 为使源到期额外执行的一次 UPDATE。D1 外部调用等待时间不计入 Worker CPU，统计混合了运行时调度/序列化等成本。
3. **免费运行可靠性仍不达标。** Cloudflare 官方 [Workers Free Cron 10ms CPU 限额](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)，parse-only 和 full 的本次 6 次观测全部在 13–45ms，偶发超限被允许成功不代表可持续。9 次样本无法做 P95/P99 或定容量。
4. 下一步优化应**优先减轻 XML 文档解析、字段归一化和无用节点处理**，并单独评估 D1 claim/fencing/JSON1 去重的固定开销；对 Atom 大源适当控制采集粒度，但不能削弱事务、安全和小时级调度。**不值得为了单次超限购买 Paid**，也不能把本次诊断入口当成生产机制。

### 收尾与安全

- 18:33 UTC，Cloudflare API 对**唯一 Canary Worker** 执行 `PUT schedules=[]` 并 `GET` 确认为 `[]`；Cron 传播可能存在最多约 15 分钟延迟，但 profiler 自身也在 9 次后停止任何网络抓取。
- 同一会话重新上传先前真实应用 bundle（Git blob `cff903cf9b07493803ca3188eb3268eb36084f00`），确认 `DB` 仍绑定同一个专属 D1，`schedules=[]`。Profile Worker **不再是线上运行版本**。
- 临时调整的 `gln003-controlled-two` 到期时间恢复到 `2026-10-31T18:45:55.344Z`。D1 新闻始终保留最终 **25 条 Atom + 2 条 RSS，共 27 唯一 URL**。本次 9 条样本和 CPU 已写入此文档后，专属 D1 中的两张临时 `gln003_profile_*` 表均已删除；再次检查数据库仅保留 `poc_sources`、`poc_news` 及 Cloudflare 内部 `_cf_KV`。诊断结构不扩散到正式数据库。
- 本次没有更新 `dev/test/prod`，没有触碰其他 Workers、拾言数据库或生产域名。GLN-003 Issue #6 保持 **OPEN**，性能验收不可宣称通过。

