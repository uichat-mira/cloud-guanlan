# GLN-001 · Workers Free + D1 技术选型 POC

> 任务契约：[GLN-001 / Issue #2](https://github.com/uichat-mira/cloud-guanlan/issues/2)。
> **证据状态：待 GitHub CI 和 workerd 实测完成后填写，不把代码存在当成测试通过。**

## POC 与产品边界

本卡验证 Hono、D1（使用 Drizzle 的 insert / D1 prepared SQL）和小时级 scheduled 路径是否能作为低成本服务的技术底座，并以相同 RSS/Atom 样本对照 Feedsmith 3.0.1 与 fast-xml-parser 5.x。

只暴露不读写新闻的 `GET /health`。订阅源由本地测试插入 D1；没有管理接口、私人新闻 API、Cloud Auth 或部署配置里的有效生产数据库 ID。

### 测试设计

- **T1 解析兼容**：RSS、Atom、数量上限 40、缺失 URL、恶意协议、不支持文档。
- **T3 Worker/D1**：真实 Miniflare / workerd、`getWorker().scheduled()`、本地 D1 迁移、同 URL 去重、到期调度、不因 GET 刷新、上游 503 后保留原数据、响应体上限。
- **解析基准**：一个 workerd 进程内，用 5 / 40 篇合成 RSS 条目分别执行两种解析器各 12 次，报告中位和最慢 wall-time。仅供对照趋势，**不是 Cloudflare 计费 CPU，也不代表服务请求的总 CPU 开销**。
- **Wrangler dry-run**：无凭证、不部署，验证 bundle/兼容性。
- **CI 与锁文件**：已固定从真实 GitHub Runner 生成的 `package-lock.json`；CI 与 Worker 必须执行 `npm ci`，不得临时解析漂移依赖。

### 重现命令

```sh
npm ci --no-audit --no-fund
npm run check
# 或独立运行 npm run test:integration、npm run test:benchmark、npm run dry-run
```

## 预计边界

单次 Cron 最多处理 1 个到期来源；未定义用户订阅/消费记录，也不对公网提供手工刷新。RSS 读取上限 128 KiB、最多 40 篇；不跟随 HTTP 重定向，失败写入来源状态但不能掩盖为成功。

URL 过滤只是初步防护：真实用户输入仍需 SSRF、IP/DNS 及跳转链的全面安全处理。当前未引入 Cloud Auth，因此**绝不开放私人新闻接口**。

## 待 CI 填写的证据

- GitHub Actions run：**pending**
- Node.js / Wrangler / Feedsmith / fast-xml-parser：**待记录实际 Runner 版本**
- T1 / T3 / dry-run：**pending**
- RSS 5、40 篇 workerd 基准：**pending**
- Cloudflare 免费账户真实运行指标：**未测，非本地 CI 可证明**
- 产品免费额度耗尽时的降级选择：**维护者尚未拍板**

## 技术判断（暂定）

- 优先保持 **Hono + 单一 Worker + D1**，不要提前加队列和服务拆分。
- Drizzle 仅用于类型化 D1 写入的可行性验证，生产读写是否全部采用 ORM 等核心 Schema 稳定后再判断。
- **解析器待实测决定**：Feedsmith 功能更全、维护活跃，但必须同时满足结果正确、Workers 能打包、实际 CPU/体积可接受；fast-xml-parser 已被 Desktop 采用，若差距过大应允许选择它。
- Free 上线资格需要真实 Cloudflare Account 测试与监控数据。本 POC 不能代替。
