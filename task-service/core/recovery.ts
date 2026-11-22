/**
 * Restart recovery and UNKNOWN reconciliation (design doc §10.4). Never
 * resends input to find out whether it arrived; only the persisted exact
 * backend identity is queried.
 */
import type { AttemptRecord, TaskRecord } from '../model'
import { attemptEvent, taskEvent } from './commit'
import type { Engine } from './engine'
import { requestAuthorization } from './fallback-runner'
import { requestFinalize } from './finalize'
import { newAttempt, newTurn, NO_OWNER, ownerFor } from './records'

const OWNER_PHASES = new Set(['STARTING', 'ACTIVE', 'WAITING_PERMISSION', 'WAITING_INPUT'])
const WAITING_PHASES = new Set(['FALLBACK_PENDING', 'WAITING_RETRY', 'WAITING_AUTHORIZATION'])

/** Run once at service start, with admission closed. */
export async function startupRecovery(engine: Engine): Promise<void> {
  const { store, committer } = engine.deps
  for (const task of store.listNonClosed()) {
    if (task.phase === 'PREPARED') {
      // Any unconsumed old start authorization is invalid after restart (none is stored for PREPARED).
      engine.kick(task.taskId)
      continue
    }
    if (OWNER_PHASES.has(task.phase)) {
      committer.commit(task.taskId, t => ({
        task: {
          ...t, phase: 'UNKNOWN', needsAttention: true, owner: { ...t.owner, state: 'unknown' },
          grant: t.grant && t.grant.state === 'valid' ? { ...t.grant, state: 'void' } : t.grant,
          permissions: t.permissions.map(p => (p.state === 'pending' || p.state === 'decided' ? { ...p, state: 'expired' as const } : p)),
        },
        events: [taskEvent('task.unknown', { reason: 'router restarted; reconciling exact owner', previousPhase: t.phase })],
      }))
    } else if (WAITING_PHASES.has(task.phase)) {
      // Old grants never survive a restart: a fresh grant is required before any new input.
      committer.commit(task.taskId, t => ({
        task: { ...t, grant: t.grant && t.grant.state === 'valid' ? { ...t.grant, state: 'void' } : t.grant, pendingAuthorization: null },
      }))
      const attempt = engine.currentAttempt(store.getTask(task.taskId)!)
      if (attempt && attempt.state === 'planned') requestAuthorization(engine, task.taskId, attempt.executionAttemptId, 'recovery_restart', 'router restarted')
    }
    engine.kick(task.taskId)
  }
}

function hasIdentity(a: AttemptRecord): boolean {
  return !!(a.owner.backendSessionId || a.owner.pid || Object.keys(a.owner.extra).length)
}

export async function reconcileTask(engine: Engine, task: TaskRecord): Promise<void> {
  const { store, committer } = engine.deps
  const attempt = engine.currentAttempt(task)
  const turn = engine.currentTurn(task)
  if (!attempt || !turn) { requestFinalize(engine, task.taskId, { kind: 'terminate', reason: 'RECOVERY_UNRESOLVED', graceSeconds: null }); return }
  const backend = engine.backendFor(attempt)
  const ctx = engine.attemptContext(task, attempt, turn.turnId)
  const handle = engine.handleOf(attempt, turn)

  // Input provably never left the router: release any empty owner, then require a fresh grant.
  if (attempt.delivery === 'not_sent') {
    if (hasIdentity(attempt) && attempt.ownerReleased !== true) {
      const rel = await backend.release(ctx, handle, engine.deps.releaseGraceMs).catch(() => ({ released: null }))
      if (rel.released !== true) return
    }
    const res = committer.commit(task.taskId, t => {
      if (t.phase !== 'UNKNOWN' || t.currentExecutionAttemptId !== attempt.executionAttemptId) return null
      const now = engine.deps.clock.now()
      if (t.sealed || t.intent) {
        return { task: { ...t, phase: 'FINALIZING', owner: { ...t.owner, state: 'released' } }, attempts: [{ ...attempt, ownerReleased: true }] }
      }
      const ended: AttemptRecord = { ...attempt, state: 'skipped', outcome: 'not_started', ownerReleased: true, endedAtMs: now,
        failure: { code: 'other', stage: null, detail: 'router restarted before dispatch', evidenceDigest: null } }
      const next = newAttempt(t, attempt.candidateIndex, {
        ordinal: t.executionAttemptCount, generation: t.owner.generation + 1, inputSha256: t.assignment.promptSha256,
        triggerCode: 'recovery_restart', evidenceDigest: null, isStartupRetry: attempt.isStartupRetry, now,
      })
      const nextTurn = newTurn(t, next, '')
      return {
        task: {
          ...t, phase: 'FALLBACK_PENDING', needsAttention: false, currentExecutionAttemptId: next.executionAttemptId, currentTurnId: nextTurn.turnId,
          executionAttemptCount: t.executionAttemptCount + 1, owner: { ...NO_OWNER, generation: next.generation },
          budgets: { ...t.budgets, recoveryEnteredAtMs: now },
        },
        attempts: [ended, next], turns: [nextTurn],
        events: [attemptEvent('execution_attempt.ended', ended, turn.turnId, { outcome: 'not_started', reason: 'recovery' })],
      }
    })
    if (res?.task.phase === 'FALLBACK_PENDING') {
      requestAuthorization(engine, task.taskId, res.task.currentExecutionAttemptId!, 'recovery_restart', 'router restarted before dispatch')
    } else engine.kick(task.taskId)
    return
  }

  const where = await backend.locate(ctx, handle).catch(() => 'unreachable' as const)
  if (where !== 'running' && where !== 'ended') {
    engine.deps.log(`task-service: ${task.taskId} stays UNKNOWN (${where})`)
    return
  }
  const res = committer.commit(task.taskId, t => {
    if (t.phase !== 'UNKNOWN' || t.currentExecutionAttemptId !== attempt.executionAttemptId) return null
    const reconciled: AttemptRecord = { ...attempt, generation: t.owner.generation + 1 }
    const latestTurn = store.getTurn(turn.turnId)!
    const phase = t.intent ? 'FINALIZING' as const : latestTurn.state === 'ended' ? 'QUIESCENT' as const : 'ACTIVE' as const
    return {
      task: {
        ...t, phase, needsAttention: false, terminalReason: null,
        owner: { ...ownerFor(reconciled, 'live'), generation: reconciled.generation },
        budgets: { ...t.budgets, lastActivityAtMs: engine.deps.clock.now() },
      },
      attempts: [reconciled], control: true,
      events: [attemptEvent('owner.reconciled', reconciled, turn.turnId, { generation: reconciled.generation, location: where })],
    }
  })
  if (res && res.task.phase === 'ACTIVE') engine.startObserve(res.task, store.getAttempt(attempt.executionAttemptId)!)
  engine.kick(task.taskId)
}

