/**
 * Which backend takes over when the primary provably never received a
 * message (design doc §7 "pre_execution_only"). Pure decision only — the
 * router performs it. One hop: a fallback is never itself allowed to fall
 * back, and never targets the backend that just failed.
 */
import type { AgentKind, AgentPolicy } from './types'

export type FallbackChoice =
  | { kind: 'opencode' }
  | { kind: 'agy' }
  | { kind: 'claude'; via: 'tmux' | 'socket' }

export interface FallbackAvailability {
  /** agents.yaml `fallback.enabled`. */
  enabled: boolean
  /** agents.yaml declares `agents.opencode`. */
  openCodeConfigured: boolean
}

export function chooseFallback(failed: AgentKind, policy: AgentPolicy, avail: FallbackAvailability): FallbackChoice | null {
  const target = policy.fallback
  if (!avail.enabled || !target || target === failed) return null
  switch (target) {
    case 'opencode': return avail.openCodeConfigured ? { kind: 'opencode' } : null
    case 'agy': return { kind: 'agy' }
    case 'claude': return { kind: 'claude', via: policy.mode === 'tmux' ? 'tmux' : 'socket' }
  }
}
