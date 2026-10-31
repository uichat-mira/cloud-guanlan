# GLN-002 · D1 租约驱动的动态串行调度

> Contract: [Issue #4](https://github.com/uichat-mira/cloud-guanlan/issues/4). Independent of GLN-001 selection POC.
> Current status: **implementation PR; simulated Workers/D1 evidence only**. No Cloudflare deployment, no production-user data.

## Implementation boundary

- **Cron wakes every 5 minutes**, but the service reads each source's `interval_hours` from D1 (1–24 hours); cron frequency is *not* source polling cadence.
- A single SQLite `UPDATE ... RETURNING` claims the earliest due, available source. The `lease_token` and `lease_expires_at` columns protect against concurrent Cron invocations and recover from crashes.
- Lease duration **60 seconds**, request wall timeout **8 seconds**, invocation soft wall budget **16 seconds**, **maximum 2 sources per invocation**; sources are fetched and parsed sequentially. These are **local POC starting parameters**, not measured Cloudflare Free capacity or guaranteed real-time latency.
- Success writes news and resets retry state. Insertions and state completion share a **single D1 batch transaction**, with every news insertion fenced by the current lease token; stale holders cannot overwrite newer source status or insert out-of-lease news.
- Failure of an external source records an error **category** without URL or response body. Repeated failures use capped exponential backoff starting at 5 minutes with deterministic jitter under 45 seconds, max 6 hours + jitter. Failed sources do not consume every future tick.
- Failure of D1 persistence **propagates** instead of being misclassified as upstream feed failure. The lease expires and a subsequent tick can safely reclaim work; failed D1 batch must not leave partial news.
- The D1 `ORDER BY due_at,id` selection gives overdue older sources priority, avoiding indefinite starvation. A successful source moves forward by its configured interval; a failing source moves forward by a bounded backoff. Under sustained backlog, elapsed delay is measurable but **no guarantee of timely refresh** can be offered without observed capacity.

## Minimal D1 schema migration

`migrations/0002_source_leases.sql` adds the ownership token, expiration and retry counter. This is a POC schema, **not production migration authorization**. If migrating a pre-existing local database, apply `0001_poc.sql` then `0002_source_leases.sql` once.

## Capacity arithmetic (upper bounds, not SLA)

| Cron | Sources per invocation | Upper bound per hour | Upper bound per day |
| --- | --- | --- | --- |
| Every 5 minutes | 2 | 24 attempts | 576 attempts |

This assumes all invocations execute promptly and always find two eligible sources; it does not account for failures, network, D1 quota, CPU, other services, or the schedule's 16s wall budget. With 24 sources each requesting a 1-hour interval, there is no spare headroom; real sustainable capacity will be lower. A shared source is ingested once, independent of subscribers.

- Worker Free CPU (10ms budget in prior platform documentation), Cron CPU, D1 rows read/written, and subrequests require **actual connected Cloudflare-account measurement**.
- The local test's `durationMs` is **wall time** and `cpuMs` deliberately returns `null`; this is not an inferred CPU-cost number.
- Visibility: structured, source-identity-free summary fields `processed`, `inserted`, `errors`, `leaseConflicts`, `recovered`, `retries`, `backlog`, `oldestOverdueSeconds`, `durationMs` and `cpuMs:null`. No source URL, private account ID, credential, or item text in logs. Upstream errors persist only as safe categories.

## Validation

Execute:

```sh
npm ci
npm run test:unit
npm run test:integration
npm run dry-run
npm run check
```

The fast unit tests cover interval validity, capped deterministic backoff and bounded Cron policy. The real Miniflare/workerd + D1 tests cover: concurrent Cron claim, two-source bounded batches and eventual progress for a third, failed source retry, stale-holder fencing after lease expiry, D1 transaction failure rollback and recovery, oversized/invalid feeds, idempotence and GET safety. CI verifies the actual Worker handler and D1 binding, not a mock database.

**GitHub Runner evidence (code commit `0f2e76c`):**

- [Actions run 41219774475](https://github.com/uichat-mira/cloud-guanlan/actions/runs/41219774475): Repository Contract, Branch Policy, Mira Gate all **success**. Reproducible `npm ci`; `tsc --noEmit`; T1 **9/9**, real Miniflare/workerd + D1 T3 **10/10** (including a 3-hour source interval across 5-minute Cron wakes), Wrangler dry-run and parsing comparison passed.
- First implementation run [41219502927](https://github.com/uichat-mira/cloud-guanlan/actions/runs/41219502927) caught a stale assertion expecting free-form `oversized` text rather than the safe stored error category `feed_too_large`. The test now checks the explicit code while retaining its rejection/no-write assertion. The corrected run [41219566002](https://github.com/uichat-mira/cloud-guanlan/actions/runs/41219566002) was also green.
- Final measured Worker dry-run artifact: **211.50 KiB / gzip 54.23 KiB**; benchmark-only Feedsmith is not included in the production Worker bundle.
- **These are only emulated workerd metrics and package size**. Cloudflare Free account billed CPU, D1 row usage and real network error rates have not been measured; no live deployment was performed.

## Explicitly deferred

- Source URL/IP/DNS/redirect SSRF hardening, private subscription and Cloud Auth integration.
- User subscription sharing rules, news consumer state, cross-user privacy enforcement, 90-day retention and free-quota degradation policy.
- Real Workers Free CPU + D1 usage and actual remote-feed testing. No binding to live D1 and no production deployment.

The GLN-002 issue remains open until independently reviewed and accepted by an authorized maintainer.
