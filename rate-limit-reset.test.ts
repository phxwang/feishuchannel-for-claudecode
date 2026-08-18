import { describe, expect, test } from 'bun:test'
import { parseRateLimitResetTime } from './rate-limit-reset'

describe('parseRateLimitResetTime', () => {
  test('returns null when the text has no reset time', () => {
    expect(parseRateLimitResetTime('Usage limit reached.')).toBeNull()
  })

  test('returns null for an unknown/invalid IANA zone', () => {
    const now = new Date('2026-03-05T10:00:00Z')
    expect(parseRateLimitResetTime('resets 9:30pm (Not/AZone)', now)).toBeNull()
  })

  test('resolves a fixed-offset zone (Asia/Singapore, UTC+8, no DST) later today', () => {
    const now = new Date('2026-03-05T10:00:00Z') // 18:00 SGT
    const reset = parseRateLimitResetTime("You've hit your session limit · resets 9:30pm (Asia/Singapore)", now)
    expect(reset?.toISOString()).toBe('2026-03-05T13:30:00.000Z') // 21:30 SGT same day
  })

  test('rolls over to tomorrow when the stated time already passed today', () => {
    const now = new Date('2026-03-05T14:00:00Z') // 22:00 SGT, past 21:30
    const reset = parseRateLimitResetTime('resets 9:30pm (Asia/Singapore)', now)
    expect(reset?.toISOString()).toBe('2026-03-06T13:30:00.000Z')
  })

  test('handles a DST-observing zone (America/New_York, EDT = UTC-4 in July)', () => {
    const now = new Date('2026-07-01T10:00:00Z') // 06:00 EDT
    const reset = parseRateLimitResetTime('resets 9:30pm (America/New_York)', now)
    expect(reset?.toISOString()).toBe('2026-07-02T01:30:00.000Z') // 21:30 EDT = 01:30 UTC next day
  })

  test('12:00am means midnight, not noon', () => {
    const now = new Date('2026-03-05T10:00:00Z') // 18:00 SGT
    const reset = parseRateLimitResetTime('resets 12:00am (Asia/Singapore)', now)
    expect(reset?.toISOString()).toBe('2026-03-05T16:00:00.000Z') // next midnight SGT (today's already passed)
  })

  test('12:00pm means noon, not midnight', () => {
    const now = new Date('2026-03-05T10:00:00Z') // 18:00 SGT, past noon
    const reset = parseRateLimitResetTime('resets 12:00pm (Asia/Singapore)', now)
    expect(reset?.toISOString()).toBe('2026-03-06T04:00:00.000Z') // tomorrow's noon SGT
  })
})
