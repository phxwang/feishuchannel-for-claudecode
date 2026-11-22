/**
 * Mutating task controls (design doc §9.5, §9.8–9.12). Each handler runs
 * synchronously inside the operation transaction and returns post-commit
 * work; backend effects never happen before the intent is durable.
 */
import { DomainError } from '../errors'
import { RUNNING_PHASES } from '../lifecycle'
import type { AttemptRecord, Grant, TaskRecord } from '../model'
import type { OwnerRef } from '../schema/primitives'
import { LIMITS, type Authorization, type TransitionAuthorization } from '../schema/tools'
import { parseTimestamp } from '../time'
import { attemptEvent, taskEvent } from './commit'
import type { Engine } from './engine'
import { proceedToDispatch } from './fallback-runner'
import { sealAndFinalize } from './finalize'
import type { MutationOutcome } from './operations'
import { newAttempt, newTurn, ownerFor } from './records'
import { toSnapshot } from './snapshot'

interface ControlBase { taskId: string; expectedControlVersion: number; expectedOwner: OwnerRef | null }

export function loadTask(engine: Engine, taskId: string): TaskRecord {
  const t = engine.deps.store.getTask(taskId)
  if (!t) throw new DomainError('TASK_NOT_FOUND', 'No such task.', { taskId })
  return t
}

function snapshotOf(engine: Engine, taskId: string) {
  const t = loadTask(engine, taskId)
  return toSnapshot(t, engine.currentTurn(t))
}

export function checkVersion(t: TaskRecord, expected: number): void {
  if (t.controlVersion !== expected) {
    throw new DomainError('VERSION_CONFLICT', 'Read the latest task before deciding another control action.', { taskId: t.taskId, currentControlVersion: t.controlVersion })
  }
}

/** Exact-owner fencing; null is accepted only while no exact owner is established (spec §4.2). */
export function checkOwner(t: TaskRecord, expected: OwnerRef | null): void {
  const established = t.owner.executionId !== null && t.owner.state !== 'starting' && t.owner.state !== 'none'
  if (!established) {
    if (expected && (expected.executionId !== t.owner.executionId || expected.generation !== t.owner.generation)) {
      throw new DomainError('OWNER_MISMATCH', 'expectedOwner does not match the current owner.', { currentOwner: { executionId: t.owner.executionId, generation: t.owner.generation } })
    }
    return
  }
  if (!expected || expected.executionId !== t.owner.executionId || expected.generation !== t.owner.generation) {
    throw new DomainError('OWNER_MISMATCH', 'expectedOwner does not match the current owner.', { currentOwner: { executionId: t.owner.executionId, generation: t.owner.generation } })
  }
}

function checkControl(t: TaskRecord, a: ControlBase): void {
  checkVersion(t, a.expectedControlVersion)
  checkOwner(t, a.expectedOwner)
}

function checkGrant(t: TaskRecord, auth: Authorization, now: number): number {
  const exp = parseTimestamp(auth.expiresAt)
  if (exp === null) throw new DomainError('INVALID_REQUEST', 'authorization.expiresAt must be an RFC 3339 timestamp with offset.')
  if (exp <= now) throw new DomainError('AUTHORIZATION_EXPIRED', 'The authorization has already expired.')
  if (exp > now + (LIMITS.startAuthorizationMaxSeconds + 1) * 1000) {
    throw new DomainError('INVALID_REQUEST', `authorization.expiresAt must be at most ${LIMITS.startAuthorizationMaxSeconds} seconds away.`)
  }
  if (auth.promptSha256 !== t.assignment.promptSha256 || auth.contractSha256 !== t.assignment.contractSha256 || auth.fallbackPlanSha256 !== t.fallbackPlanSha256) {
    throw new DomainError('ASSIGNMENT_MISMATCH', 'Authorization digests do not match the frozen assignment and policy.')
  }
  return exp
}

function capacityCheck(engine: Engine, t: TaskRecord): void {
  const { store, registry } = engine.deps
  const running = store.listNonClosed().filter(x => x.taskId !== t.taskId && RUNNING_PHASES.has(x.phase))
  const global = engine.deps.maxConcurrentTasks
  if (global !== undefined && running.length >= global) {
    throw new DomainError('CAPACITY_EXHAUSTED', 'The task service is at its configured concurrency limit.', { retryAfterMs: 5000 }, { sideEffects: 'none' })
  }
  const perKind = registry.cap(t.backend.kind)
  if (perKind !== undefined && running.filter(x => (x.actualBackend ?? x.backend).kind === t.backend.kind).length >= perKind) {
    throw new DomainError('CAPACITY_EXHAUSTED', `Backend ${t.backend.kind} is at its configured concurrency limit.`, { retryAfterMs: 5000 }, { sideEffects: 'none' })
  }
}

export function startTask(engine: Engine, a: { taskId: string; expectedControlVersion: number; authorization: Authorization }): MutationOutcome {
  const { clock, committer } = engine.deps
  const t = loadTask(engine, a.taskId)
  if (t.sealed) throw new DomainError('TASK_SEALED', 'The task is sealed.')
  checkVersion(t, a.expectedControlVersion)
  if (t.phase !== 'PREPARED') throw new DomainError('TASK_BUSY', 'Only a PREPARED task can be started.', { phase: t.phase })
  const now = clock.now()
  const exp = checkGrant(t, a.authorization, now)
  capacityCheck(engine, t)
  committer.commit(t.taskId, cur => {
    const attempt = newAttempt(cur, 0, { ordinal: 0, generation: 0, inputSha256: cur.assignment.promptSha256, triggerCode: null, evidenceDigest: null, isStartupRetry: false, now })
    const turn = newTurn(cur, attempt, '')
    const grant: Grant = {
      kind: 'start', revision: a.authorization.revision, expiresAtMs: exp, promptSha256: a.authorization.promptSha256,
      contractSha256: a.authorization.contractSha256, fallbackPlanSha256: a.authorization.fallbackPlanSha256,
      transitionSha256: null, transitionRequestId: null, state: 'valid',
    }
    return {
      task: {
        ...cur, phase: 'STARTING', grant, currentExecutionAttemptId: attempt.executionAttemptId, currentTurnId: turn.turnId,
        executionAttemptCount: 1, owner: ownerFor(attempt, 'starting'),
        budgets: { ...cur.budgets, startedAtMs: now, runDeadlineAtMs: now + cur.policy.runTimeoutSeconds * 1000 },
      },
      attempts: [attempt], turns: [turn], control: true,
      events: [taskEvent('task.starting', { authorizationRevision: a.authorization.revision, executionAttemptId: attempt.executionAttemptId, turnId: turn.turnId })],
    }
  })
  return { data: { accepted: true, task: snapshotOf(engine, t.taskId) }, after: () => engine.kick(t.taskId) }
}

export function replyPermission(engine: Engine, a: ControlBase & { turnId: string; permissionRequestId: string; optionId: string; authorizationRevision: string }): MutationOutcome {
  const { clock, committer, store } = engine.deps
  const t = loadTask(engine, a.taskId)
  checkControl(t, a)
  const p = t.permissions.find(x => x.permissionRequestId === a.permissionRequestId)
  const now = clock.now()
  if (!p || p.turnId !== a.turnId || a.turnId !== t.currentTurnId || p.executionId !== t.owner.executionId
    || p.state !== 'pending' || p.expiresAtMs <= now) {
    throw new DomainError('PERMISSION_STALE', 'The permission request is not pending for this exact task, turn and owner.')
  }
  const option = p.options.find(o => o.optionId === a.optionId)
  if (!option) throw new DomainError('INVALID_OPTION', 'Unknown or unsupported permission option.', { options: p.options })
  committer.commit(t.taskId, cur => ({
    task: { ...cur, permissions: cur.permissions.map(x => x.permissionRequestId === p.permissionRequestId ? { ...x, state: 'decided' as const, decision: option.kind } : x) },
  }))
  const after = () => {
    const task = store.getTask(t.taskId)!
    const attempt = engine.currentAttempt(task)
    if (!attempt) return
    const backend = engine.backendFor(attempt)
    const turn = engine.currentTurn(task)
    const ctx = engine.attemptContext(task, attempt, turn?.turnId ?? '')
    void backend.replyPermission(ctx, engine.handleOf(attempt, turn), p.backendRequestId, option.kind)
      .catch(() => 'unknown' as const)
      .then(result => recordPermissionResult(engine, t.taskId, attempt, p.permissionRequestId, option.kind, a.authorizationRevision, result))
      .catch(e => engine.deps.log(`task-service: recording permission reply for ${t.taskId} failed: ${e instanceof Error ? e.message : String(e)}`))
  }
  return { data: { accepted: true, task: snapshotOf(engine, t.taskId) }, after }
}

function recordPermissionResult(engine: Engine, taskId: string, attempt: AttemptRecord, permissionRequestId: string, decision: string, revision: string, result: 'confirmed' | 'unknown') {
  engine.commitForAttempt(taskId, attempt.executionAttemptId, (t, a) => {
    const p = t.permissions.find(x => x.permissionRequestId === permissionRequestId)
    if (!p || p.state !== 'decided') return null
    const confirmed = result === 'confirmed'
    const permissions = t.permissions.map(x => x === p ? { ...x, state: confirmed ? 'resolved' as const : 'unresolved_unknown' as const, backendConfirmed: confirmed } : x)
    const stillPending = permissions.some(x => x.turnId === p.turnId && ['pending', 'decided', 'unresolved_unknown'].includes(x.state))
    const events = confirmed
      ? [attemptEvent('permission.resolved', a, p.turnId, { permissionRequestId, decision, backendConfirmed: true, authorizationRevision: revision })]
      : [attemptEvent('backend.diagnostic', a, p.turnId, { detail: 'permission reply acknowledgement unknown; awaiting backend evidence', permissionRequestId })]
    return {
      task: { ...t, permissions, phase: t.phase === 'WAITING_PERMISSION' && !stillPending ? 'ACTIVE' : t.phase },
      events,
    }
  })
}

export function sealTask(engine: Engine, a: ControlBase & { reason: string }): MutationOutcome {
  const t = loadTask(engine, a.taskId)
  checkControl(t, a)
  if (!t.sealed) {
    engine.deps.committer.commit(t.taskId, cur => ({
      task: {
        ...cur, sealed: true, pendingAuthorization: null,
        grant: cur.grant && cur.grant.state === 'valid' ? { ...cur.grant, state: 'void' } : cur.grant,
        budgets: { ...cur.budgets, retryWakeAtMs: null },
      },
      control: true,
      events: [taskEvent('task.sealed', { reason: a.reason })],
    }))
  }
  // Nothing can ever advance a sealed task waiting for a retry/grant: finalize it now (prior outcome preserved).
  const latest = loadTask(engine, t.taskId)
  if (['FALLBACK_PENDING', 'WAITING_RETRY', 'WAITING_AUTHORIZATION'].includes(latest.phase)) {
    engine.deps.committer.commit(t.taskId, cur => sealAndFinalize(cur, { kind: 'terminate', reason: 'SEALED_BY_CLIENT', graceSeconds: null }))
  }
  return { data: { task: snapshotOf(engine, t.taskId) }, after: () => engine.kick(t.taskId) }
}

export function closeTask(engine: Engine, a: ControlBase & { reason: string }): MutationOutcome {
  const t = loadTask(engine, a.taskId)
  checkControl(t, a)
  if (t.phase !== 'QUIESCENT') throw new DomainError('TASK_NOT_QUIESCENT', 'Only a QUIESCENT task can be closed.', { phase: t.phase })
  engine.deps.committer.commit(t.taskId, cur => sealAndFinalize(cur, { kind: 'close', reason: a.reason, graceSeconds: null }))
  return { data: { accepted: true, task: snapshotOf(engine, t.taskId) }, after: () => engine.kick(t.taskId) }
}

export function cancelTask(engine: Engine, a: ControlBase & { reason: string; graceSeconds: number }): MutationOutcome {
  const t = loadTask(engine, a.taskId)
  checkVersion(t, a.expectedControlVersion)
  if (t.phase === 'CLOSED') return { data: { accepted: true, task: snapshotOf(engine, t.taskId) } }
  checkOwner(t, a.expectedOwner)
  if (t.phase === 'UNKNOWN') {
    const attempt = engine.currentAttempt(t)
    const verified = !!attempt && (attempt.delivery === 'not_sent' || !!(attempt.owner.backendSessionId || attempt.owner.pid || Object.keys(attempt.owner.extra).length))
    if (!verified) throw new DomainError('OWNER_UNVERIFIED', 'The task owner cannot be verified precisely enough to cancel it.')
  }
  if (t.phase !== 'FINALIZING') {
    engine.deps.committer.commit(t.taskId, cur => sealAndFinalize(cur, { kind: 'cancel', reason: a.reason, graceSeconds: a.graceSeconds }))
  }
  return { data: { accepted: true, task: snapshotOf(engine, t.taskId) }, after: () => engine.kick(t.taskId) }
}

export function addTurn(engine: Engine, a: ControlBase): MutationOutcome {
  const t = loadTask(engine, a.taskId)
  checkVersion(t, a.expectedControlVersion)
  throw new DomainError('UNSUPPORTED_CAPABILITY', 'Same-primary additional turns are not supported in this version.', { capability: 'samePrimaryTurns' })
}

export function authorizeTask(engine: Engine, a: ControlBase & { transitionRequestId: string; decision: 'allow' | 'deny'; authorization: TransitionAuthorization | null }): MutationOutcome {
  const { clock, committer } = engine.deps
  const t = loadTask(engine, a.taskId)
  checkControl(t, a)
  const now = clock.now()
  const pending = t.pendingAuthorization
  const stale = () => new DomainError('AUTHORIZATION_STALE', 'No matching pending transition request.', { transitionRequestId: a.transitionRequestId }, { sideEffects: 'none' })
  if (!pending || pending.transitionRequestId !== a.transitionRequestId || pending.expiresAtMs <= now || t.phase !== 'WAITING_AUTHORIZATION') throw stale()
  if (t.sealed) throw new DomainError('TASK_SEALED', 'The task is sealed.')

  if (a.decision === 'deny') {
    if (a.authorization !== null) throw new DomainError('INVALID_REQUEST', 'A deny decision must carry authorization: null.')
    committer.commit(t.taskId, cur => {
      const fin = sealAndFinalize({ ...cur, pendingAuthorization: null }, { kind: 'deny', reason: 'AUTHORIZATION_DENIED', graceSeconds: null })!
      return { ...fin, events: [taskEvent('authorization.resolved', { transitionRequestId: pending.transitionRequestId, decision: 'deny' }), ...fin.events] }
    })
    return { data: { accepted: true, task: snapshotOf(engine, t.taskId) }, after: () => engine.kick(t.taskId) }
  }
  const auth = a.authorization
  if (!auth) throw new DomainError('INVALID_REQUEST', 'An allow decision requires the complete authorization object.')
  if (auth.transitionSha256 !== pending.transitionSha256) throw stale()
  const exp = checkGrant(t, auth, now)
  committer.commit(t.taskId, cur => ({
    task: {
      ...cur, pendingAuthorization: null,
      grant: {
        kind: 'transition', revision: auth.revision, expiresAtMs: exp, promptSha256: auth.promptSha256, contractSha256: auth.contractSha256,
        fallbackPlanSha256: auth.fallbackPlanSha256, transitionSha256: auth.transitionSha256, transitionRequestId: pending.transitionRequestId, state: 'valid',
      },
    },
    control: true,
    events: [taskEvent('authorization.resolved', { transitionRequestId: pending.transitionRequestId, decision: 'allow', authorizationRevision: auth.revision })],
  }))
  return { data: { accepted: true, task: snapshotOf(engine, t.taskId) }, after: () => proceedToDispatch(engine, t.taskId, false) }
}
