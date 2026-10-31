// A scheduled invocation may process at most this many feeds sequentially.
// Keep deliberately small for Workers Free until actual billed CPU is measured.
export const MAX_SOURCES_PER_INVOCATION = 2;
export const CRON_EXPRESSION = "*/5 * * * *";
export const SOURCE_TIMEOUT_MS = 8_000;
export const INVOCATION_WALL_BUDGET_MS = 16_000;
export const LEASE_MS = 60_000;
export const MAX_FEED_BYTES = 128 * 1024;

// Bound retry interval to [5 minutes, 6 hours]; deterministic per-source jitter
// spreads retries without persisting new scheduling state.
export function retryDelayMs(previousFailures: number, sourceId: string): number {
  const attempt = Math.max(0, Math.min(16, Math.trunc(previousFailures)));
  const exponential = Math.min(6 * 3_600_000, 300_000 * 2 ** attempt);
  let hash = 2166136261;
  for (let i=0;i<sourceId.length;i++) hash = Math.imul(hash ^ sourceId.charCodeAt(i), 16777619);
  return exponential + ((hash >>> 0) % 45_000);
}
export function nextSuccessAt(now: number, intervalHours: number): string {
  if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 24) throw new Error("Invalid hours");
  return new Date(now + intervalHours * 3_600_000).toISOString();
}
export function nextFailureAt(now: number, previousFailures: number, id: string): string {
  return new Date(now + retryDelayMs(previousFailures, id)).toISOString();
}
