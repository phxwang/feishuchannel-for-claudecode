/**
 * One timer per task, armed for the earliest durable deadline (design doc
 * §10.3). Deadlines are wall-clock values persisted in the task record, so a
 * restart recomputes them and never grants a fresh budget.
 */
import type { TaskRecord } from '../model'
import type { Engine } from './engine'
import { onAuthorizationExpired, onRetryWake, recoveryRemainingMs } from './fallback-runner'
import { requestFinalize } from './finalize'

export type DeadlineKind = 'prepared_expiry' | 'run' | 'idle' | 'permission' | 'quiescent' | 'retry' | 'authorization' | 'recovery' | 'reconcile'

export interface TimerHost {
  timers: Map<string, ReturnType<typeof setTimeout>>
}

const MAX_TIMEOUT_MS = 2 ** 31 - 1
const RECOVERY_PHASES = new Set(['FALLBACK_PENDING', 'WAITING_RETRY', 'WAITING_AUTHORIZATION'])
const RUN_PHASES = new Set(['STARTING', 'ACTIVE', 'WAITING_PERMISSION', 'WAITING_INPUT', 'FALLBACK_PENDING', 'WAITING_RETRY', 'WAITING_AUTHORIZATION'])

export function deadlines(engine: Engine, task: TaskRecord, now: number): { at: number; kind: DeadlineKind }[] {
  const out: { at: number; kind: DeadlineKind }[] = []
  const b = task.budgets
  if (task.phase === 'PREPARED') out.push({ at: b.preparedExpiresAtMs, kind: 'prepared_expiry' })
  if (RUN_PHASES.has(task.phase) && b.runDeadlineAtMs !== null) out.push({ at: b.runDeadlineAtMs, kind: 'run' })
  if (task.phase === 'ACTIVE' && b.lastActivityAtMs !== null) {
    const rt = engine.runtimes.get(task.taskId)
    if (!rt || rt.activeTools.size === 0) out.push({ at: b.lastActivityAtMs + task.policy.idleTimeoutSeconds * 1000, kind: 'idle' })
  }
  if (task.phase === 'WAITING_PERMISSION') {
    const pending = task.permissions.filter(p => p.state === 'pending' || p.state === 'decided' || p.state === 'unresolved_unknown')
    if (pending.length) out.push({ at: Math.min(...pending.map(p => p.expiresAtMs)), kind: 'permission' })
  }
  if (task.phase === 'QUIESCENT' && b.quiescentDeadlineAtMs !== null) out.push({ at: b.quiescentDeadlineAtMs, kind: 'quiescent' })
  if (task.phase === 'WAITING_RETRY' && b.retryWakeAtMs !== null) out.push({ at: b.retryWakeAtMs, kind: 'retry' })
  if (task.phase === 'WAITING_AUTHORIZATION' && task.pendingAuthorization) out.push({ at: task.pendingAuthorization.expiresAtMs, kind: 'authorization' })
  if (RECOVERY_PHASES.has(task.phase)) out.push({ at: now + Math.max(0, recoveryRemainingMs(task, now)), kind: 'recovery' })
  // UNKNOWN keeps reconciling; FINALIZING retries release if a previous attempt threw.
  if (task.phase === 'UNKNOWN' || task.phase === 'FINALIZING') out.push({ at: now + engine.deps.reconcileRetryMs, kind: 'reconcile' })
  return out
}

export function armTimer(engine: Engine, task: TaskRecord): void {
  const prev = engine.timers.get(task.taskId)
  if (prev) clearTimeout(prev)
  engine.timers.delete(task.taskId)
  if (task.phase === 'CLOSED') return
  const now = engine.deps.clock.now()
  const all = deadlines(engine, task, now)
  if (!all.length) return
  const next = all.reduce((a, b) => (b.at < a.at ? b : a))
  const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, next.at - now))
  const timer = setTimeout(() => {
    engine.timers.delete(task.taskId)
    try { fire(engine, task.taskId) } catch (e) {
      // Never let a deadline crash the router; retry shortly instead.
      engine.deps.log(`task-service: deadline handling for ${task.taskId} failed: ${e instanceof Error ? e.message : String(e)}`)
      const retry = setTimeout(() => engine.kick(task.taskId), engine.deps.reconcileRetryMs)
      engine.timers.set(task.taskId, retry)
    }
  }, delay)
  engine.timers.set(task.taskId, timer)
}

/** Evaluate every deadline that has passed, in a fixed priority order. */
export function fire(engine: Engine, taskId: string): void {
  const task = engine.deps.store.getTask(taskId)
  if (!task || task.phase === 'CLOSED') return
  const now = engine.deps.clock.now()
  if (now + 5000 < task.updatedAtMs) {
    // Wall clock moved backwards: budgets are unprovable, fail closed.
    requestFinalize(engine, taskId, { kind: 'terminate', reason: 'RUN_TIMEOUT', graceSeconds: null })
    return
  }
  const due = deadlines(engine, task, now).filter(d => d.at <= now).map(d => d.kind)
  const has = (k: DeadlineKind) => due.includes(k)
  if (has('prepared_expiry')) { requestFinalize(engine, taskId, { kind: 'expire', reason: 'PREPARED_EXPIRED', graceSeconds: null }); return }
  if (has('run')) { requestFinalize(engine, taskId, { kind: 'terminate', reason: 'RUN_TIMEOUT', graceSeconds: null }); return }
  if (has('permission')) { expirePermissions(engine, task, now); return }
  if (has('idle')) { requestFinalize(engine, taskId, { kind: 'terminate', reason: 'IDLE_TIMEOUT', graceSeconds: null }); return }
  if (has('quiescent')) { requestFinalize(engine, taskId, { kind: 'close', reason: 'QUIESCENT_TIMEOUT', graceSeconds: null }); return }
  if (has('recovery')) { requestFinalize(engine, taskId, { kind: 'terminate', reason: 'FALLBACK_EXHAUSTED', graceSeconds: null }); return }
  if (has('retry')) { onRetryWake(engine, task); return }
  if (has('authorization')) { onAuthorizationExpired(engine, task); return }
  if (has('reconcile')) { engine.kick(taskId); return }
  engine.kick(taskId)
}

function expirePermissions(engine: Engine, task: TaskRecord, now: number): void {
  const attempt = engine.currentAttempt(task)
  const turn = engine.currentTurn(task)
  if (attempt) {
    const backend = engine.backendFor(attempt)
    const ctx = engine.attemptContext(task, attempt, turn?.turnId ?? '')
    for (const p of task.permissions.filter(x => x.state === 'pending' && x.expiresAtMs <= now)) {
      void backend.replyPermission(ctx, engine.handleOf(attempt, turn), p.backendRequestId, 'deny_once').catch(() => 'unknown')
    }
  }
  requestFinalize(engine, task.taskId, { kind: 'terminate', reason: 'PERMISSION_TIMEOUT', graceSeconds: null })
}
