import { describe, expect, test } from 'bun:test'
import { AGY_QUOTA_COOLDOWN_MS, isAgyQuotaError } from './agy-errors'

describe('isAgyQuotaError', () => {
  test.each([
    'RESOURCE_EXHAUSTED: You have exhausted your weekly quota',
    'Error 429: Too Many Requests',
    'spend cap reached for this billing period',
    'Your prepaid balance is empty',
    'quota exceeded for model gemini-3.8-flash',
    'rate limit exceeded, retry later',
  ])('treats %p as quota/rate-limit', (msg) => {
    expect(isAgyQuotaError(msg)).toBe(true)
  })

  test.each([
    '',
    'tool call denied by pre-tool hook: ',
    'model output must contain either output text or tool calls',
    'context deadline exceeded',
  ])('does not treat %p as quota', (msg) => {
    expect(isAgyQuotaError(msg)).toBe(false)
  })

  test('cooldown is 30 minutes', () => {
    expect(AGY_QUOTA_COOLDOWN_MS).toBe(30 * 60 * 1000)
  })
})
