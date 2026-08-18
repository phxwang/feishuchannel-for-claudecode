import { describe, expect, test } from 'bun:test'
import { DegradedTracker } from './degraded'

describe('DegradedTracker', () => {
  test('is not degraded when never marked', () => {
    const t = new DegradedTracker()
    expect(t.isDegraded('/path/a')).toBe(false)
  })

  test('is degraded before the until timestamp', () => {
    const t = new DegradedTracker()
    t.markDegraded('/path/a', 1_000)
    expect(t.isDegraded('/path/a', 500)).toBe(true)
  })

  test('is not degraded at or after the until timestamp', () => {
    const t = new DegradedTracker()
    t.markDegraded('/path/a', 1_000)
    expect(t.isDegraded('/path/a', 1_000)).toBe(false)
    expect(t.isDegraded('/path/a', 1_500)).toBe(false)
  })

  test('expiry evicts the entry so a later re-mark starts fresh', () => {
    const t = new DegradedTracker()
    t.markDegraded('/path/a', 1_000)
    expect(t.isDegraded('/path/a', 2_000)).toBe(false) // evicts
    t.markDegraded('/path/a', 3_000)
    expect(t.isDegraded('/path/a', 2_500)).toBe(true)
  })

  test('a later mark extends (or shortens) the window', () => {
    const t = new DegradedTracker()
    t.markDegraded('/path/a', 1_000)
    t.markDegraded('/path/a', 5_000)
    expect(t.isDegraded('/path/a', 2_000)).toBe(true)
  })

  test('tracks workdirs independently', () => {
    const t = new DegradedTracker()
    t.markDegraded('/path/a', 1_000)
    expect(t.isDegraded('/path/b', 500)).toBe(false)
  })
})
