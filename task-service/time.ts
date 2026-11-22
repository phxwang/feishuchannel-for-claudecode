/**
 * Clock abstraction + RFC 3339 formatting with a fixed +08:00 offset
 * (spec §4.4: server-generated timestamps use +08:00).
 */

export interface Clock {
  /** Wall clock, epoch ms. */
  now(): number
  /** Monotonic ms, only meaningful within one process lifetime. */
  monotonic(): number
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
}

const OFFSET_MS = 8 * 3600 * 1000
const pad = (n: number, w = 2) => String(n).padStart(w, '0')

export function formatTimestamp(ms: number): string {
  const d = new Date(ms + OFFSET_MS)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}+08:00`
}

/** Strict RFC 3339 with an explicit offset or Z. Returns epoch ms or null. */
export function parseTimestamp(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** A controllable clock for tests. */
export class ManualClock implements Clock {
  constructor(private wall = Date.parse('2026-11-22T12:00:00+08:00'), private mono = 0) {}
  now() { return this.wall }
  monotonic() { return this.mono }
  advance(ms: number) { this.wall += ms; this.mono += ms }
  setWall(ms: number) { this.wall = ms }
}
