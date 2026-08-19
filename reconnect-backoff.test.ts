import { describe, expect, test } from 'bun:test'
import { nextReconnectDelay, RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS } from './reconnect-backoff'

describe('nextReconnectDelay', () => {
  test('doubles the current delay', () => {
    expect(nextReconnectDelay(RECONNECT_BASE_DELAY_MS)).toBe(RECONNECT_BASE_DELAY_MS * 2)
    expect(nextReconnectDelay(2000)).toBe(4000)
  })

  test('caps at RECONNECT_MAX_DELAY_MS', () => {
    expect(nextReconnectDelay(RECONNECT_MAX_DELAY_MS)).toBe(RECONNECT_MAX_DELAY_MS)
    expect(nextReconnectDelay(RECONNECT_MAX_DELAY_MS * 10)).toBe(RECONNECT_MAX_DELAY_MS)
  })

  test('reaches the cap within a handful of doublings from the base delay', () => {
    let delay = RECONNECT_BASE_DELAY_MS
    for (let i = 0; i < 10; i++) delay = nextReconnectDelay(delay)
    expect(delay).toBe(RECONNECT_MAX_DELAY_MS)
  })
})
