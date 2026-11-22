/**
 * Close / cancel / time-limit termination (design doc §9.10). Intent is
 * persisted (sealed, FINALIZING) before any backend action; CLOSED is reported
 * only after release of the exact owner is verified, otherwise UNKNOWN.
 */
import type { ReleaseResult } from '../backends/backend'
import type { AttemptRecord, TaskIntent, TaskRecord, TurnOutcome, TurnRecord } from '../model'
import { attemptEvent, taskEvent } from './commit'
import type { Engine } from './engine'
import { finalOutcome } from './records'

const TIMEOUT_REASONS = new Set(['RUN_TIMEOUT', 'IDLE_TIMEOUT', 'PERMISSION_TIMEOUT'])

export function interruptedOutcome(intent: TaskIntent | null): TurnOutcome {
  if (!intent) return 'failed'
  if (intent.kind === 'cancel') return 'cancelled'
  if (TIMEOUT_REASONS.has(intent.reason)) return 'timed_out'
  return 'failed'
}

/** Persist the termination intent and move to FINALIZING. Idempotent: the first intent wins. */
export function requestFinalize(engine: Engine, taskId: string, intent: TaskIntent): TaskRecord | null {
  const res = engine.deps.committer.commit(taskId, t => sealAndFinalize(t, intent))
  engine.kick(taskId)
  return res?.task ?? null
}

export function sealAndFinalize(t: TaskRecord, intent: TaskIntent) {
  if (t.phase === 'CLOSED' || t.phase === 'FINALIZING') return null
  const events = []
  if (!t.sealed) events.push(taskEvent('task.sealed', { reason: intent.reason }))
  events.push(taskEvent('task.finalizing', { reason: intent.reason, kind: intent.kind }))
  return {
    task: {
      ...t,
      phase: 'FINALIZING' as const,
      sealed: true,
      intent,
      pendingAuthorization: null,
      grant: t.grant && t.grant.state === 'valid' ? { ...t.grant, state: 'void' as const } : t.grant,
      permissions: t.permissions.map(p => (p.state === 'pending' || p.state === 'decided' ? { ...p, state: 'expired' as const } : p)),
      fallbackState: t.fallbackState === 'idle' ? t.fallbackState : t.fallbackState,
      budgets: { ...t.budgets, retryWakeAtMs: null },
    },
    events,
    control: true,
  }
}

function hasOwnerIdentity(a: AttemptRecord): boolean {
  return !!(a.owner.backendSessionId || a.owner.pid || Object.keys(a.owner.extra).length)
}

export async function finalizeTask(engine: Engine, task: TaskRecord): Promise<void> {
  const { store, clock } = engine.deps
  const attempt = engine.currentAttempt(task)
  const turn = engine.currentTurn(task)
  let rel: ReleaseResult | null = null

  if (attempt && attempt.ownerReleased !== true && hasOwnerIdentity(attempt)) {
    const backend = engine.backendFor(attempt)
    const ctx = engine.attemptContext(task, attempt, turn?.turnId ?? '')
    const handle = engine.handleOf(attempt, turn)
    const graceMs = (task.intent?.graceSeconds ?? engine.deps.releaseGraceMs / 1000) * 1000
    if (turn && turn.state !== 'ended') await backend.interrupt(ctx, handle).catch(() => undefined)
    rel = await backend.release(ctx, handle, graceMs).catch(e => ({ released: null, backgroundWorkSettled: null, detail: String(e) }))
    // Give a concurrent observer a moment to record a natural completion that raced the cancel.
    await new Promise(r => setTimeout(r, 50))
    engine.stopObserving(task.taskId)
    if (rel.released !== true) {
      engine.deps.committer.commit(task.taskId, t => {
        if (t.phase !== 'FINALIZING') return null
        return {
          task: {
            ...t, phase: 'UNKNOWN', needsAttention: true, terminalReason: 'CLEANUP_UNKNOWN', owner: { ...t.owner, state: 'unknown' },
            cleanup: { ownerReleased: rel!.released, backgroundWorkSettled: rel!.backgroundWorkSettled, detail: rel!.detail },
          },
          events: [taskEvent('task.unknown', { reason: 'cleanup could not be verified', detail: rel!.detail })],
        }
      })
      return
    }
  } else {
    engine.stopObserving(task.taskId)
  }

  const now = clock.now()
  engine.deps.committer.commit(task.taskId, t => {
    if (t.phase !== 'FINALIZING') return null
    const attempts = store.listAttempts(t.taskId)
    const turns = store.listTurns(t.taskId)
    const cancelled = t.intent?.kind === 'cancel'
    const interrupted = interruptedOutcome(t.intent)
    const changedTurns: TurnRecord[] = []
    const changedAttempts: AttemptRecord[] = []
    const finalTurns = turns.map(tu => {
      if (tu.state === 'ended' || tu.delivery === 'not_sent') return tu
      const ended = { ...tu, state: 'ended' as const, outcome: interrupted, endedAtMs: now, process: { ...tu.process, controlledShutdown: true } }
      changedTurns.push(ended)
      return ended
    })
    const finalAttempts = attempts.map(a => {
      if (a.state === 'ended' || a.state === 'skipped') {
        if (a.executionAttemptId === t.currentExecutionAttemptId && a.ownerReleased !== true) {
          const r = { ...a, ownerReleased: true }
          changedAttempts.push(r)
          return r
        }
        return a
      }
      const delivered = a.delivery !== 'not_sent'
      const r: AttemptRecord = {
        ...a, state: delivered ? 'ended' : 'skipped', endedAtMs: now, ownerReleased: true,
        outcome: delivered ? interrupted : 'not_started',
      }
      changedAttempts.push(r)
      return r
    })
    const outcome = finalOutcome(finalAttempts, finalTurns, cancelled)
    const established = t.owner.executionId !== null && t.owner.state !== 'none'
    const events = changedAttempts
      .filter(a => a.state === 'ended' || a.state === 'skipped')
      .filter(a => !attempts.find(x => x.executionAttemptId === a.executionAttemptId && (x.state === 'ended' || x.state === 'skipped')))
      .map(a => attemptEvent('execution_attempt.ended', a, t.currentTurnId, { outcome: a.outcome, delivery: a.delivery }))
    return {
      task: {
        ...t,
        phase: 'CLOSED',
        owner: { ...t.owner, state: established ? 'released' : 'none' },
        executionOutcome: outcome,
        closedAtMs: now,
        terminalReason: t.intent?.reason ?? t.terminalReason,
        needsAttention: false,
        cleanup: {
          ownerReleased: established ? true : null,
          backgroundWorkSettled: rel ? rel.backgroundWorkSettled : (established ? true : null),
          detail: rel?.detail ?? (established ? 'owner already released' : 'no owner'),
        },
      },
      attempts: changedAttempts,
      turns: changedTurns,
      events: [...events, taskEvent('task.closed', { executionOutcome: outcome, reason: t.intent?.reason ?? null })],
    }
  })
}
