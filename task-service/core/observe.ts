/**
 * Applies one normalized backend event to the durable ledger (design doc
 * §9.6–9.8). Returns true when observation of this turn is finished.
 */
import { safeSummary } from '../../adapters/opencode/presentation'
import type { BackendCapabilities, BackendEvent } from '../backends/backend'
import type { ClassifiedFailure } from '../fallback/decide'
import { newId } from '../ids'
import { sha256Hex } from '../jcs'
import type { PermissionRecord, TaskRecord, TurnRecord } from '../model'
import { LIMITS } from '../schema/tools'
import type { NewEvent } from '../store/task-store'
import { attemptEvent } from './commit'
import type { Engine } from './engine'
import { interruptedOutcome, requestFinalize } from './finalize'
import type { TextStreams } from './text'

export interface Runtime {
  attemptId: string
  turnId: string
  abort: AbortController
  streams: TextStreams
  activeTools: Set<string>
  /** `${toolCallId}:${status}` already recorded for this turn (dedupes replays after re-attach). */
  seenTools: Set<string>
  lastActivityCommitMs: number
  caps: BackendCapabilities | null
}

/** Keep the last 1 MiB of the per-task event budget for control/terminal facts. */
const EVENT_CAP_BYTES = 256 * 1024 * 1024
const CONTROL_RESERVE_BYTES = 1024 * 1024
const ACTIVITY_COMMIT_INTERVAL_MS = 2000

export function applyBackendEvent(engine: Engine, taskId: string, rt: Runtime, ev: BackendEvent): boolean {
  const { clock, store } = engine.deps
  const now = clock.now()
  switch (ev.type) {
    case 'delivery':
      if (ev.status === 'accepted') { engine.markAccepted(taskId, rt.attemptId); return false }
      if (ev.status === 'not_sent') {
        engine.commitForAttempt(taskId, rt.attemptId, (t, a) => ({
          task: { ...t, grant: t.grant ? { ...t.grant, state: 'valid' as const } : null }, attempts: [{ ...a, delivery: 'not_sent' as const }],
        }))
        engine.failNotSent(taskId, rt.attemptId, ev.failure)
        return true
      }
      engine.commitForAttempt(taskId, rt.attemptId, (t, a) => ({
        task: t, attempts: [{ ...a, delivery: 'unknown' as const }],
        events: [attemptEvent('backend.diagnostic', a, rt.turnId, { detail: safeSummary(ev.detail) })],
      }))
      return false

    case 'handle':
      engine.updateHandle(taskId, rt.attemptId, ev.handle)
      return false

    case 'text': {
      const ops = rt.streams.apply(ev.streamId, ev.text, ev.mode)
      if (rt.streams.bytes() > LIMITS.maxTurnTextBytes) {
        requestFinalize(engine, taskId, { kind: 'terminate', reason: 'OUTPUT_LIMIT_EXCEEDED', graceSeconds: null })
        return true
      }
      engine.commitForAttempt(taskId, rt.attemptId, (t, a) => {
        if (t.eventBytes > EVENT_CAP_BYTES - CONTROL_RESERVE_BYTES) return null
        const events: NewEvent[] = ops.map(op => op.kind === 'reset'
          ? attemptEvent('text.reset', a, rt.turnId, { streamId: op.streamId })
          : attemptEvent('text.delta', a, rt.turnId, { streamId: op.streamId, text: op.text }))
        return { task: touch(t, now), events }
      })
      if ((store.getTask(taskId)?.eventBytes ?? 0) > EVENT_CAP_BYTES - CONTROL_RESERVE_BYTES) {
        requestFinalize(engine, taskId, { kind: 'terminate', reason: 'EVENT_LIMIT_EXCEEDED', graceSeconds: null })
        return true
      }
      return false
    }

    case 'tool': {
      const key = `${ev.toolCallId}:${ev.status}`
      if (rt.seenTools.has(key)) return false
      rt.seenTools.add(key)
      if (ev.status === 'started') rt.activeTools.add(ev.toolCallId)
      else rt.activeTools.delete(ev.toolCallId)
      engine.commitForAttempt(taskId, rt.attemptId, (t, a) => ({
        task: touch(t, now),
        attempts: [{ ...a, effectStatus: a.effectStatus === 'none' ? 'unknown' as const : a.effectStatus }],
        events: [attemptEvent(`tool.${ev.status}`, a, rt.turnId, {
          toolCallId: ev.toolCallId, name: ev.name, status: ev.status, ...(ev.detail ? { detail: safeSummary(ev.detail) } : {}),
        })],
      }))
      return false
    }

    case 'permission.requested':
      onPermissionRequested(engine, taskId, rt, ev, now)
      return false

    case 'permission.cleared':
      engine.commitForAttempt(taskId, rt.attemptId, (t, a) => {
        const p = t.permissions.find(x => x.backendRequestId === ev.backendRequestId && x.turnId === rt.turnId && x.state !== 'resolved')
        if (!p) return null
        const permissions = t.permissions.map(x => x === p ? { ...x, state: 'resolved' as const } : x)
        const stillPending = permissions.some(x => x.turnId === rt.turnId && (x.state === 'pending' || x.state === 'decided' || x.state === 'unresolved_unknown'))
        return {
          task: { ...touch(t, now), permissions, phase: t.phase === 'WAITING_PERMISSION' && !stillPending ? 'ACTIVE' as const : t.phase },
          events: [attemptEvent('permission.resolved', a, rt.turnId, {
            permissionRequestId: p.permissionRequestId, decision: p.decision, backendConfirmed: p.backendConfirmed, cleared: true,
          })],
        }
      })
      return false

    case 'interaction.required':
      engine.commitForAttempt(taskId, rt.attemptId, (t, a) => ({
        task: { ...t, phase: t.phase === 'ACTIVE' || t.phase === 'STARTING' ? 'WAITING_INPUT' as const : t.phase },
        events: [attemptEvent('interaction.required', a, rt.turnId, { detail: safeSummary(ev.detail) })],
      }))
      return false

    case 'activity':
      if (now - rt.lastActivityCommitMs >= ACTIVITY_COMMIT_INTERVAL_MS) {
        rt.lastActivityCommitMs = now
        engine.commitForAttempt(taskId, rt.attemptId, t => ({ task: touch(t, now) }))
      }
      return false

    case 'diagnostic':
      engine.commitForAttempt(taskId, rt.attemptId, (t, a) => ({
        task: t, events: [attemptEvent('backend.diagnostic', a, rt.turnId, { detail: safeSummary(ev.detail) })],
      }))
      return false

    case 'turn.ended':
      onTurnEnded(engine, taskId, rt, ev, now)
      return true

    case 'lost':
      engine.markUnknown(taskId, rt.attemptId, ev.detail)
      return true
  }
}

function touch(t: TaskRecord, now: number): TaskRecord {
  return { ...t, budgets: { ...t.budgets, lastActivityAtMs: now } }
}

function onPermissionRequested(engine: Engine, taskId: string, rt: Runtime, ev: Extract<BackendEvent, { type: 'permission.requested' }>, now: number) {
  const task = engine.deps.store.getTask(taskId)
  if (!task) return
  if (task.policy.permissionMode !== 'broker') {
    // backend_policy: nobody may approve. Deny the exact request and record it.
    const attempt = engine.deps.store.getAttempt(rt.attemptId)
    if (attempt) {
      const backend = engine.backendFor(attempt)
      const ctx = engine.attemptContext(task, attempt, rt.turnId)
      void backend.replyPermission(ctx, engine.handleOf(attempt, engine.currentTurn(task)), ev.backendRequestId, 'deny_once').catch(() => 'unknown')
    }
    engine.commitForAttempt(taskId, rt.attemptId, (t, a) => ({
      task: t, events: [attemptEvent('tool.failed', a, rt.turnId, { toolCallId: ev.toolCallId, name: ev.toolName, status: 'failed', detail: 'denied by backend_policy' })],
    }))
    return
  }
  engine.commitForAttempt(taskId, rt.attemptId, (t, a) => {
    if (t.permissions.some(p => p.backendRequestId === ev.backendRequestId && p.turnId === rt.turnId && p.state !== 'expired')) return null
    const rec: PermissionRecord = {
      permissionRequestId: newId('perm'),
      backendRequestId: ev.backendRequestId,
      turnId: rt.turnId,
      executionAttemptId: a.executionAttemptId,
      executionId: a.executionId,
      generation: t.owner.generation,
      toolCallId: ev.toolCallId,
      toolName: safeSummary(ev.toolName),
      description: safeSummary(ev.description),
      options: [{ optionId: 'allow_once', kind: 'allow_once' }, { optionId: 'deny_once', kind: 'deny_once' }],
      expiresAtMs: now + t.policy.permissionTimeoutSeconds * 1000,
      state: 'pending',
      decision: null,
      backendConfirmed: false,
    }
    const phase = t.phase === 'ACTIVE' || t.phase === 'STARTING' ? 'WAITING_PERMISSION' as const : t.phase
    return {
      task: { ...touch(t, now), phase, permissions: [...t.permissions, rec] },
      control: true,
      events: [attemptEvent('permission.requested', a, rt.turnId, {
        permissionRequestId: rec.permissionRequestId, toolCallId: rec.toolCallId, toolName: rec.toolName,
        description: rec.description, options: rec.options, expiresAt: new Date(rec.expiresAtMs).toISOString(),
      })],
    }
  })
}

function onTurnEnded(engine: Engine, taskId: string, rt: Runtime, ev: Extract<BackendEvent, { type: 'turn.ended' }>, now: number) {
  const { store } = engine.deps
  const full = ev.finalText
  let stored: { bytes: number; sha: string; complete: boolean } | null = null
  if (full !== null) {
    const buf = Buffer.from(full, 'utf8')
    let text = full
    let complete = true
    if (buf.byteLength > LIMITS.maxTurnTextBytes) {
      let end = LIMITS.maxTurnTextBytes
      while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
      text = buf.subarray(0, end).toString('utf8')
      complete = false
    }
    const sha = sha256Hex(text)
    store.putTurnText(rt.turnId, text, sha)
    stored = { bytes: Buffer.byteLength(text, 'utf8'), sha, complete }
  }

  const caps = rt.caps
  const failure: ClassifiedFailure | null = ev.outcome === 'completed' ? null : {
    code: ev.failureCode && ev.failureCode !== 'execution_failed' ? ev.failureCode : 'execution_failed',
    stage: caps?.fallback.cleanFailureFallback ? 'clean_failure' : (caps?.fallback.checkpointHandoff ? 'checkpoint_handoff' : null),
    uncertain: false,
    ownerSettled: false,
    effectStatus: ev.effects ?? 'unknown',
    detail: ev.protocol.stopReason ?? ev.outcome,
  }

  const res = engine.commitForAttempt(taskId, rt.attemptId, (t, a) => {
    const tu = store.getTurn(rt.turnId)
    if (!tu) return null
    // A non-completed end while we are terminating is the interruption we asked for.
    const outcome = t.phase === 'FINALIZING' && ev.outcome !== 'completed' ? interruptedOutcome(t.intent) : ev.outcome
    const turn: TurnRecord = {
      ...tu,
      state: 'ended',
      outcome,
      delivery: tu.delivery === 'not_sent' || tu.delivery === 'unknown' ? 'accepted' : tu.delivery,
      startedAtMs: tu.startedAtMs ?? now,
      endedAtMs: now,
      finalTextSha256: stored?.sha ?? null,
      finalTextBytes: stored?.bytes ?? null,
      finalTextComplete: stored?.complete ?? false,
      protocol: { ...ev.protocol, activeToolCount: ev.protocol.activeToolCount ?? rt.activeTools.size },
      process: ev.process,
    }
    const attempt = {
      ...a, delivery: 'accepted' as const, effectStatus: ev.effects ?? (a.effectStatus === 'none' && rt.activeTools.size === 0 ? a.effectStatus : 'unknown' as const),
    }
    const events = [attemptEvent('turn.ended', a, rt.turnId, {
      outcome, delivery: 'accepted', finalTextSha256: turn.finalTextSha256, finalTextBytes: turn.finalTextBytes,
    })]
    if (ev.outcome === 'completed') {
      const ended = { ...attempt, state: 'ended' as const, outcome: 'completed' as const, endedAtMs: now }
      const phase = t.phase === 'FINALIZING' || t.phase === 'UNKNOWN' ? t.phase : 'QUIESCENT' as const
      return {
        task: { ...t, phase, budgets: { ...t.budgets, quiescentDeadlineAtMs: now + t.policy.quiescentTimeoutSeconds * 1000 } },
        attempts: [ended], turns: [turn], events,
      }
    }
    return { task: t, attempts: [attempt], turns: [turn], events }
  })
  if (res && failure) {
    engine.endAttemptWithFailure(taskId, rt.attemptId, failure, ev.outcome === 'timed_out' ? 'timed_out' : ev.outcome === 'cancelled' ? 'cancelled' : 'failed')
  }
}
