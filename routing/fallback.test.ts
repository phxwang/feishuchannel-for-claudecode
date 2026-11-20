import { describe, expect, test } from 'bun:test'
import { chooseFallback } from './fallback'
import type { AgentPolicy } from './types'

const avail = { enabled: true, openCodeConfigured: true }
const policy = (primary: AgentPolicy['primary'], fallback: AgentPolicy['fallback'], mode?: AgentPolicy['mode']): AgentPolicy => ({ primary, fallback, ...(mode ? { mode } : {}) })

describe('chooseFallback — pre-delivery fallback target', () => {
  test('Claude (socket or tmux) → OpenCode, as before', () => {
    expect(chooseFallback('claude', policy('claude', 'opencode'), avail)).toEqual({ kind: 'opencode' })
    expect(chooseFallback('claude', policy('claude', 'opencode', 'tmux'), avail)).toEqual({ kind: 'opencode' })
  })

  test('Claude → agy', () => {
    expect(chooseFallback('claude', policy('claude', 'agy', 'tmux'), avail)).toEqual({ kind: 'agy' })
  })

  test('agy → OpenCode, and agy → Claude via tmux or socket per agent.mode', () => {
    expect(chooseFallback('agy', policy('agy', 'opencode'), avail)).toEqual({ kind: 'opencode' })
    expect(chooseFallback('agy', policy('agy', 'claude', 'tmux'), avail)).toEqual({ kind: 'claude', via: 'tmux' })
    expect(chooseFallback('agy', policy('agy', 'claude'), avail)).toEqual({ kind: 'claude', via: 'socket' })
  })

  test('nothing when fallback is disabled globally or not configured', () => {
    expect(chooseFallback('agy', policy('agy', 'opencode'), { ...avail, enabled: false })).toBeNull()
    expect(chooseFallback('agy', policy('agy', null), avail)).toBeNull()
  })

  test('OpenCode as a target needs agents.opencode configured', () => {
    expect(chooseFallback('agy', policy('agy', 'opencode'), { ...avail, openCodeConfigured: false })).toBeNull()
  })

  test('never falls back to the backend that just failed (no loops)', () => {
    expect(chooseFallback('agy', policy('claude', 'agy'), avail)).toBeNull()
    expect(chooseFallback('claude', policy('agy', 'claude'), avail)).toBeNull()
  })
})
