/**
 * Classifies the error text agy attaches to a Stop hook payload. Quota and
 * rate-limit errors make the router treat agy as unavailable for a while
 * (routing/degraded.ts), so new messages go to the configured fallback
 * instead of failing one by one. agy itself already retries short
 * per-minute limits (changelog 1.5.10), so an error that reaches the Stop
 * hook is a real stop: spend cap, prepaid balance, weekly quota.
 */
const QUOTA_RE = /RESOURCE_EXHAUSTED|\b429\b|quota|rate[ -]?limit|spend[ -]?cap|prepaid balance|too many requests/i

/** agy reports no reset time in the Stop payload, so a fixed window is used (same as Claude's unparseable-reset default). */
export const AGY_QUOTA_COOLDOWN_MS = 30 * 60 * 1000

export function isAgyQuotaError(error: string): boolean {
  return QUOTA_RE.test(error)
}
