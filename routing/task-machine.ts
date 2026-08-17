/**
 * Task state machine + fallback eligibility. See design doc §7.
 *
 *   RECEIVED → PRIMARY_SELECTED → PRIMARY_PREFLIGHT
 *       → SUBMITTED → RUNNING → WAITING_PERMISSION → COMPLETED | FAILED | ABORTED
 *       ↘ FALLBACK_ELIGIBLE → FALLBACK_PREFLIGHT → SUBMITTED → RUNNING → COMPLETED | FAILED
 *
 * Only PRIMARY_PREFLIGHT, or a SUBMITTED task confirmed *not* received by
 * the backend, may become FALLBACK_ELIGIBLE. At most one fallback attempt;
 * Claude → OpenCode → Claude is never allowed.
 */
import type { AgentKind, FallbackTrigger, TaskContext, TaskState } from './types'

const TRANSITIONS: Record<TaskState, TaskState[]> = {
  RECEIVED: ['PRIMARY_SELECTED'],
  PRIMARY_SELECTED: ['PRIMARY_PREFLIGHT'],
  PRIMARY_PREFLIGHT: ['SUBMITTED', 'FALLBACK_ELIGIBLE'],
  SUBMITTED: ['RUNNING', 'FALLBACK_ELIGIBLE', 'FAILED'],
  RUNNING: ['WAITING_PERMISSION', 'COMPLETED', 'FAILED', 'ABORTED'],
  WAITING_PERMISSION: ['RUNNING', 'ABORTED', 'FAILED'],
  FALLBACK_ELIGIBLE: ['FALLBACK_PREFLIGHT'],
  FALLBACK_PREFLIGHT: ['SUBMITTED'],
  COMPLETED: [],
  FAILED: [],
  ABORTED: [],
}

export class InvalidTransitionError extends Error {}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

export function transition(ctx: TaskContext, to: TaskState): TaskContext {
  if (!canTransition(ctx.state, to)) {
    throw new InvalidTransitionError(`task ${ctx.taskId}: cannot go from ${ctx.state} to ${to}`)
  }
  return { ...ctx, state: to }
}

const AUTO_FALLBACK_TRIGGERS: readonly FallbackTrigger[] = [
  'backend_unavailable', 'startup_timeout', 'rate_limited', 'capacity_exhausted',
]

const NEVER_FALLBACK_REASONS = [
  'permission_denied', 'user_abort', 'invalid_request', 'tool_failure', 'partial_execution',
] as const

/**
 * Decide whether a task may be moved to FALLBACK_ELIGIBLE.
 * Mirrors design doc §7 "允许自动 fallback" / "禁止自动 fallback" lists —
 * every rule here must have a corresponding negative test.
 */
export function isFallbackEligible(ctx: TaskContext, reason: TaskContext['failureReason']): boolean {
  if (ctx.state !== 'PRIMARY_PREFLIGHT' && ctx.state !== 'SUBMITTED') return false
  if (!ctx.fallback) return false
  if (ctx.attemptedAgents.length >= 1) return false // at most one fallback attempt, no Claude→OpenCode→Claude loop
  if (ctx.hasSideEffect) return false // primary already produced visible output/tool call/permission request
  if (!reason) return false
  if ((NEVER_FALLBACK_REASONS as readonly string[]).includes(reason)) return false
  return (AUTO_FALLBACK_TRIGGERS as readonly string[]).includes(reason)
}

export function markSideEffect(ctx: TaskContext): TaskContext {
  return { ...ctx, hasSideEffect: true }
}

/** Move a task into fallback, recording the agent switch. Throws if not eligible. */
export function beginFallback(ctx: TaskContext, reason: TaskContext['failureReason']): TaskContext {
  if (!isFallbackEligible(ctx, reason)) {
    throw new InvalidTransitionError(`task ${ctx.taskId}: not fallback-eligible (state=${ctx.state}, reason=${reason}, hasSideEffect=${ctx.hasSideEffect}, attempts=${ctx.attemptedAgents.length})`)
  }
  const next = transition(ctx, 'FALLBACK_ELIGIBLE')
  return { ...next, failureReason: reason, attemptedAgents: [...next.attemptedAgents, next.primary] }
}

export function createTask(taskId: string, conversationKey: string, primary: AgentKind, fallback: AgentKind | null): TaskContext {
  return {
    taskId, conversationKey, state: 'RECEIVED', primary, fallback,
    attemptedAgents: [], hasSideEffect: false,
  }
}
