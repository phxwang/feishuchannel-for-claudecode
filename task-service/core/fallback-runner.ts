/**
 * Effectful side of the fallback controller (design doc §12.3–12.5):
 * settle the previous owner, run the pure decision, plan the next attempt,
 * and request a fresh grant when needed. All state is persisted before any
 * backend effect.
 */
import { decide, type ClassifiedFailure, type Decision } from '../fallback/decide'
import { newId } from '../ids'
import { jcsSha256 } from '../jcs'
import type { AttemptRecord, PendingAuthorization, TaskRecord } from '../model'
import { LIMITS } from '../schema/tools'
import { attemptEvent, taskEvent } from './commit'
import type { Engine } from './engine'
import { requestFinalize } from './finalize'
import { newAttempt, newTurn, NO_OWNER } from './records'

export function recoveryRemainingMs(task: TaskRecord, now: number): number {
  const used = task.budgets.recoveryUsedMs + (task.budgets.recoveryEnteredAtMs !== null ? now - task.budgets.recoveryEnteredAtMs : 0)
  return task.policy.fallback.maxRecoverySeconds * 1000 - used
}

export function runRemainingMs(task: TaskRecord, now: number): number {
  return task.budgets.runDeadlineAtMs === null ? Number.MAX_SAFE_INTEGER : task.budgets.runDeadlineAtMs - now
}

function decisionFor(task: TaskRecord, attempt: AttemptRecord, failure: ClassifiedFailure, now: number): Decision {
  return decide({
    fallback: task.policy.fallback,
    currentIndex: attempt.candidateIndex,
    currentIsStartupRetry: attempt.isStartupRetry,
    switchesUsed: task.switchesUsed,
    sealed: task.sealed,
    recoveryRemainingMs: recoveryRemainingMs(task, now),
    runRemainingMs: runRemainingMs(task, now),
    failure,
  })
}

/**
 * Before entering FALLBACK_PENDING: would a switch/retry be possible if the
 * owner settles? Avoids releasing an owner whose task cannot fall back anyway.
 */
export function preDecide(engine: Engine, task: TaskRecord, attempt: AttemptRecord, failure: ClassifiedFailure): 'fallback' | 'unknown' | 'terminal' {
  const d = decisionFor(task, attempt, { ...failure, ownerSettled: true }, engine.deps.clock.now())
  if (d.kind === 'unknown') return 'unknown'
  if (d.kind === 'switch' || d.kind === 'retry_same' || d.kind === 'blocked' || d.kind === 'exhausted') return 'fallback'
  return 'terminal'
}

function failureOf(attempt: AttemptRecord): ClassifiedFailure {
  const f = attempt.failure
  const code = f && f.code !== 'other' && f.code !== 'delivery_unknown' && f.code !== 'cancelled' && f.code !== 'timeout' ? f.code : null
  return {
    code,
    stage: f?.stage ?? null,
    uncertain: attempt.delivery === 'unknown' || attempt.delivery === 'in_flight',
    ownerSettled: attempt.ownerReleased === true,
    effectStatus: attempt.effectStatus,
    detail: f?.detail ?? 'unknown failure',
  }
}

export async function evaluateFallback(engine: Engine, task: TaskRecord): Promise<void> {
  const { store, clock } = engine.deps
  let attempt = engine.currentAttempt(task)
  if (!attempt) { requestFinalize(engine, task.taskId, { kind: 'terminate', reason: 'FALLBACK_EXHAUSTED', graceSeconds: null }); return }
  // A planned (not yet dispatched) attempt is already the decision's result: continue towards dispatch.
  if (attempt.state === 'planned') { proceedToDispatch(engine, task.taskId, false); return }

  // Step 2: settle the previous owner first. Releasing is necessary, not sufficient.
  if (attempt.ownerReleased !== true && (attempt.owner.backendSessionId || attempt.owner.pid || Object.keys(attempt.owner.extra).length)) {
    engine.stopObserving(task.taskId)
    const backend = engine.backendFor(attempt)
    const turn = engine.currentTurn(task)
    const ctx = engine.attemptContext(task, attempt, turn?.turnId ?? '')
    const rel = await backend.release(ctx, engine.handleOf(attempt, turn), engine.deps.releaseGraceMs)
      .catch(e => ({ released: null, backgroundWorkSettled: null, detail: String(e) }))
    const attemptId = attempt.executionAttemptId
    engine.commitForAttempt(task.taskId, attemptId, (t, a) => ({
      task: { ...t, owner: rel.released ? { ...t.owner, state: 'released' } : t.owner },
      attempts: [{ ...a, ownerReleased: rel.released }],
      events: [attemptEvent('backend.diagnostic', a, t.currentTurnId, { detail: `release: ${rel.detail}`, released: rel.released })],
    }))
    attempt = store.getAttempt(attemptId)!
  } else if (attempt.ownerReleased !== true) {
    const attemptId = attempt.executionAttemptId
    engine.commitForAttempt(task.taskId, attemptId, (t, a) => ({ task: t, attempts: [{ ...a, ownerReleased: true }] }))
    attempt = store.getAttempt(attemptId)!
  }

  const latest = store.getTask(task.taskId)!
  if (latest.phase !== 'FALLBACK_PENDING') return
  const now = clock.now()
  const decision = decisionFor(latest, attempt, failureOf(attempt), now)
  applyDecision(engine, latest, attempt, decision, now)
}

function applyDecision(engine: Engine, task: TaskRecord, attempt: AttemptRecord, d: Decision, now: number): void {
  const evaluated = attemptEvent('fallback.evaluated', attempt, task.currentTurnId, { decision: d.kind, ...('reason' in d ? { reason: d.reason } : {}), triggerCode: attempt.failure?.code ?? null, stage: attempt.failure?.stage ?? null })
  if (d.kind === 'unknown') {
    engine.deps.committer.commit(task.taskId, t => ({
      task: { ...t, phase: 'UNKNOWN', needsAttention: true, terminalReason: 'DELIVERY_UNKNOWN', fallbackState: 'blocked' }, events: [evaluated, taskEvent('task.unknown', { reason: d.reason })],
    }))
    return
  }
  if (d.kind === 'terminate' || d.kind === 'blocked' || d.kind === 'exhausted') {
    const extra = d.kind === 'blocked'
      ? [attemptEvent('fallback.blocked', attempt, task.currentTurnId, { reason: d.reason, toCandidateIndex: d.toIndex })]
      : d.kind === 'exhausted' ? [taskEvent('fallback.exhausted', { reason: d.reason })] : []
    const reason = d.kind === 'blocked' ? 'FALLBACK_BLOCKED' : d.kind === 'exhausted' ? 'FALLBACK_EXHAUSTED' : 'BACKEND_FAILED'
    engine.deps.committer.commit(task.taskId, t => ({
      task: { ...t, fallbackState: d.kind === 'blocked' ? 'blocked' : d.kind === 'exhausted' ? 'exhausted' : t.fallbackState },
      events: [evaluated, ...extra],
    }))
    requestFinalize(engine, task.taskId, { kind: 'terminate', reason, graceSeconds: null })
    return
  }
  const toIndex = d.kind === 'switch' ? d.toIndex : attempt.candidateIndex
  const needsFreshGrant = d.kind === 'switch' && d.needsFreshGrant
  planNextAttempt(engine, task, attempt, toIndex, { isStartupRetry: d.kind === 'retry_same', isSwitch: d.kind === 'switch', delayMs: d.delayMs, needsFreshGrant, preEvents: [evaluated], now })
}

function planNextAttempt(engine: Engine, task: TaskRecord, prev: AttemptRecord, toIndex: number, o: {
  isStartupRetry: boolean; isSwitch: boolean; delayMs: number; needsFreshGrant: boolean; preEvents: ReturnType<typeof taskEvent>[]; now: number; triggerOverride?: string
}): void {
  const res = engine.deps.committer.commit(task.taskId, t => {
    if (t.currentExecutionAttemptId !== prev.executionAttemptId) return null
    const next = newAttempt(t, toIndex, {
      ordinal: t.executionAttemptCount, generation: t.owner.generation + 1, inputSha256: t.assignment.promptSha256,
      triggerCode: o.triggerOverride ?? prev.failure?.code ?? null, evidenceDigest: jcsSha256({ prev: prev.executionAttemptId, failure: prev.failure }),
      isStartupRetry: o.isStartupRetry, now: o.now,
    })
    const turn = newTurn(t, next, '')
    const base: TaskRecord = {
      ...t,
      currentExecutionAttemptId: next.executionAttemptId,
      currentTurnId: turn.turnId,
      executionAttemptCount: t.executionAttemptCount + 1,
      switchesUsed: t.switchesUsed + (o.isSwitch ? 1 : 0),
      selectedCandidateIndex: toIndex,
      owner: { ...NO_OWNER, generation: next.generation },
      fallbackState: 'pending',
    }
    const planned = attemptEvent('fallback.planned', next, turn.turnId, {
      executionAttemptId: next.executionAttemptId, candidateIndex: toIndex, backend: next.backend, inputSha256: next.inputSha256,
      isStartupRetry: o.isStartupRetry, delayMs: o.delayMs,
    })
    const events = [...o.preEvents, planned]
    if (o.delayMs > 0) {
      return {
        task: { ...base, phase: 'WAITING_RETRY', fallbackState: 'waiting_retry', budgets: { ...base.budgets, retryWakeAtMs: o.now + o.delayMs } },
        attempts: [next], turns: [turn], control: true,
        events: [...events, attemptEvent('recovery.scheduled', next, turn.turnId, { wakeAt: new Date(o.now + o.delayMs).toISOString(), delayMs: o.delayMs })],
      }
    }
    return { task: { ...base, phase: 'FALLBACK_PENDING' }, attempts: [next], turns: [turn], control: true, events }
  })
  if (!res) return
  if (res.task.phase === 'FALLBACK_PENDING') proceedToDispatch(engine, task.taskId, o.needsFreshGrant)
  else engine.kick(task.taskId)
}

/** Leave a waiting state for STARTING, or ask for a fresh grant first. */
export function proceedToDispatch(engine: Engine, taskId: string, needsFreshGrant: boolean): void {
  const { clock, store } = engine.deps
  const task = store.getTask(taskId)
  if (!task || task.sealed) return
  const attempt = engine.currentAttempt(task)
  if (!attempt) return
  const now = clock.now()
  const marginMs = 2000
  const grantOk = !needsFreshGrant && !engine.grantProblem(task, now + marginMs)
  if (!grantOk) {
    requestAuthorization(engine, taskId, attempt.executionAttemptId, attempt.failure?.code ?? attempt.triggerCode ?? 'grant_expired', needsFreshGrant ? 'fresh grant required' : 'grant expired')
    return
  }
  const res = engine.deps.committer.commit(taskId, t => {
    if (t.currentExecutionAttemptId !== attempt.executionAttemptId) return null
    if (!['FALLBACK_PENDING', 'WAITING_RETRY', 'WAITING_AUTHORIZATION'].includes(t.phase)) return null
    return {
      task: { ...t, phase: 'STARTING', fallbackState: 'idle', budgets: leaveRecovery(t, now) },
      events: t.phase === 'WAITING_RETRY' ? [attemptEvent('recovery.resumed', attempt, t.currentTurnId, {})] : [],
    }
  })
  if (res) engine.kick(taskId)
}

export function leaveRecovery(t: TaskRecord, now: number): TaskRecord['budgets'] {
  const entered = t.budgets.recoveryEnteredAtMs
  return { ...t.budgets, recoveryUsedMs: t.budgets.recoveryUsedMs + (entered !== null ? now - entered : 0), recoveryEnteredAtMs: null, retryWakeAtMs: null }
}

/** Enter WAITING_AUTHORIZATION with a bound transition request (spec §12.5). */
export function requestAuthorization(engine: Engine, taskId: string, attemptId: string, trigger: string, detail: string): void {
  const { clock } = engine.deps
  const now = clock.now()
  const current = engine.deps.store.getTask(taskId)
  if (current && Math.min(recoveryRemainingMs(current, now), runRemainingMs(current, now)) <= 0) {
    requestFinalize(engine, taskId, { kind: 'terminate', reason: 'FALLBACK_EXHAUSTED', graceSeconds: null })
    return
  }
  engine.commitForAttempt(taskId, attemptId, (t, a) => {
    const lifetime = Math.min(LIMITS.transitionRequestMaxSeconds * 1000, recoveryRemainingMs(t, now), runRemainingMs(t, now))
    if (lifetime <= 0) return null
    const prevAttempts = engine.deps.store.listAttempts(t.taskId).filter(x => x.ordinal < a.ordinal)
    const prev = prevAttempts[prevAttempts.length - 1]
    const req: Omit<PendingAuthorization, 'transitionSha256'> = {
      transitionRequestId: newId('xreq'),
      action: 'fallback_dispatch',
      candidateIndex: a.candidateIndex,
      backend: a.backend,
      executionAttemptId: a.executionAttemptId,
      previousOwner: prev ? { executionId: prev.executionId, generation: prev.generation } : null,
      triggerCode: (trigger as PendingAuthorization['triggerCode']),
      evidenceDigest: a.evidenceDigest ?? jcsSha256({ detail }),
      checkpointSha256: null,
      effectiveInputSha256: t.assignment.promptSha256,
      nonce: newId('nonce'),
      expiresAtMs: now + lifetime,
      requiredBusinessChecks: ['live_authority', 'stop_switch', 'scope_lease'],
    }
    const { expiresAtMs: _e, ...binding } = req
    const pending: PendingAuthorization = { ...req, transitionSha256: jcsSha256(binding) }
    const phase = t.phase === 'WAITING_AUTHORIZATION' ? t.phase : 'WAITING_AUTHORIZATION'
    const enteredRecovery = t.budgets.recoveryEnteredAtMs ?? now
    return {
      task: {
        ...t, phase, pendingAuthorization: pending, fallbackState: 'waiting_authorization',
        grant: t.grant && t.grant.state === 'valid' ? { ...t.grant, state: 'void' } : t.grant,
        budgets: { ...t.budgets, recoveryEnteredAtMs: enteredRecovery },
      },
      control: true,
      events: [attemptEvent('authorization.required', a, t.currentTurnId, {
        transitionRequestId: pending.transitionRequestId, action: pending.action, candidateIndex: pending.candidateIndex,
        backend: pending.backend, executionAttemptId: pending.executionAttemptId, triggerCode: pending.triggerCode,
        transitionSha256: pending.transitionSha256, effectiveInputSha256: pending.effectiveInputSha256,
        expiresAt: new Date(pending.expiresAtMs).toISOString(), detail,
      })],
    }
  })
  engine.kick(taskId)
}

/** Timer callbacks for waiting phases. */
export function onRetryWake(engine: Engine, task: TaskRecord): void {
  proceedToDispatch(engine, task.taskId, false)
}

export function onAuthorizationExpired(engine: Engine, task: TaskRecord): void {
  const attempt = engine.currentAttempt(task)
  const now = engine.deps.clock.now()
  if (attempt && recoveryRemainingMs(task, now) > 0 && runRemainingMs(task, now) > 0) {
    requestAuthorization(engine, task.taskId, attempt.executionAttemptId, task.pendingAuthorization?.triggerCode ?? 'grant_expired', 'previous transition request expired')
    return
  }
  requestFinalize(engine, task.taskId, { kind: 'terminate', reason: 'AUTHORIZATION_EXPIRED', graceSeconds: null })
}
