import { describe, expect, test } from 'bun:test'
import {
  beginFallback, canTransition, createTask, InvalidTransitionError,
  isFallbackEligible, markSideEffect, transition,
} from './task-machine'

function preflightTask(fallback: 'opencode' | null = 'opencode') {
  const t = createTask('t1', 'group:oc_x:inv', 'claude', fallback)
  return transition(transition(t, 'PRIMARY_SELECTED'), 'PRIMARY_PREFLIGHT')
}

describe('state transitions', () => {
  test('valid chain RECEIVED -> ... -> COMPLETED', () => {
    let t = createTask('t1', 'k', 'claude', null)
    t = transition(t, 'PRIMARY_SELECTED')
    t = transition(t, 'PRIMARY_PREFLIGHT')
    t = transition(t, 'SUBMITTED')
    t = transition(t, 'RUNNING')
    t = transition(t, 'COMPLETED')
    expect(t.state).toBe('COMPLETED')
  })

  test('rejects illegal jump', () => {
    const t = createTask('t1', 'k', 'claude', null)
    expect(() => transition(t, 'COMPLETED')).toThrow(InvalidTransitionError)
  })

  test('terminal states have no outgoing transitions', () => {
    expect(canTransition('COMPLETED', 'RUNNING')).toBe(false)
    expect(canTransition('FAILED', 'SUBMITTED')).toBe(false)
    expect(canTransition('ABORTED', 'RUNNING')).toBe(false)
  })
})

describe('fallback eligibility — allowed cases (design doc §7)', () => {
  test('primary preflight, no side effect, trigger reason -> eligible', () => {
    const t = preflightTask()
    expect(isFallbackEligible(t, 'backend_unavailable')).toBe(true)
    expect(isFallbackEligible(t, 'startup_timeout')).toBe(true)
    expect(isFallbackEligible(t, 'rate_limited')).toBe(true)
    expect(isFallbackEligible(t, 'capacity_exhausted')).toBe(true)
  })

  test('submitted-but-unreceived may still fall back', () => {
    const t = transition(preflightTask(), 'SUBMITTED')
    expect(isFallbackEligible(t, 'startup_timeout')).toBe(true)
  })

  test('beginFallback records the attempted agent and moves state', () => {
    const t = preflightTask()
    const next = beginFallback(t, 'backend_unavailable')
    expect(next.state).toBe('FALLBACK_ELIGIBLE')
    expect(next.attemptedAgents).toEqual(['claude'])
  })
})

describe('fallback eligibility — forbidden cases (design doc §7)', () => {
  test('no fallback configured -> never eligible', () => {
    const t = preflightTask(null)
    expect(isFallbackEligible(t, 'backend_unavailable')).toBe(false)
  })

  test('already has a side effect -> never eligible', () => {
    const t = markSideEffect(preflightTask())
    expect(isFallbackEligible(t, 'backend_unavailable')).toBe(false)
  })

  test('permission_denied never triggers fallback', () => {
    const t = preflightTask()
    expect(isFallbackEligible(t, 'permission_denied')).toBe(false)
  })

  test('user_abort never triggers fallback', () => {
    const t = preflightTask()
    expect(isFallbackEligible(t, 'user_abort')).toBe(false)
  })

  test('tool_failure never triggers fallback', () => {
    const t = preflightTask()
    expect(isFallbackEligible(t, 'tool_failure')).toBe(false)
  })

  test('partial_execution never triggers fallback', () => {
    const t = preflightTask()
    expect(isFallbackEligible(t, 'partial_execution')).toBe(false)
  })

  test('already attempted a fallback once -> no second attempt (no ping-pong)', () => {
    const t = beginFallback(preflightTask(), 'backend_unavailable')
    const resubmitted = transition(transition(t, 'FALLBACK_PREFLIGHT'), 'SUBMITTED')
    expect(isFallbackEligible(resubmitted, 'backend_unavailable')).toBe(false)
  })

  test('wrong state (RUNNING) -> not eligible even with a valid reason', () => {
    const t = transition(transition(transition(preflightTask(), 'SUBMITTED'), 'RUNNING'), 'WAITING_PERMISSION')
    expect(isFallbackEligible(t, 'backend_unavailable')).toBe(false)
  })

  test('beginFallback throws when not eligible', () => {
    const t = markSideEffect(preflightTask())
    expect(() => beginFallback(t, 'backend_unavailable')).toThrow(InvalidTransitionError)
  })
})
