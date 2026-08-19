/** Capped exponential backoff for the worker's router-socket reconnect loop. */
export const RECONNECT_BASE_DELAY_MS = 1000
export const RECONNECT_MAX_DELAY_MS = 30_000

export function nextReconnectDelay(current: number): number {
  return Math.min(current * 2, RECONNECT_MAX_DELAY_MS)
}
