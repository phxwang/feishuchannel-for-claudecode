/**
 * Execution engine: drives each task from its durable state (design doc §9.5,
 * §12.3). Every step re-reads the record, so the engine is safe to "kick"
 * repeatedly and after a restart. Async continuations are guarded by the
 * attempt id, so a stale continuation can never move a newer attempt.
 */
import { mkdirSync } from 'fs'
import { join } from 'path'
import type { AttemptContext, BackendHandle, NotSent, TaskBackend } from '../backends/backend'
import type { BackendRegistry } from '../backends/registry'
import type { ClassifiedFailure } from '../fallback/decide'
import type { AttemptRecord, TaskRecord, TurnRecord } from '../model'
import type { TaskStore } from '../store/task-store'
import type { Clock } from '../time'
import { attemptEvent, taskEvent, type Committer } from './commit'
import { applyBackendEvent, type Runtime } from './observe'
import { ownerFor } from './records'
import { TextStreams } from './text'
import { armTimer, type TimerHost } from './timers'
import { evaluateFallback, preDecide, requestAuthorization } from './fallback-runner'
import { finalizeTask, requestFinalize } from './finalize'
import { reconcileTask } from './recovery'
import { workdirUnchanged } from '../access'

export interface EngineDeps {
  store: TaskStore
  committer: Committer
  clock: Clock
  registry: BackendRegistry
  runRoot: string
  log: (msg: string) => void
  releaseGraceMs: number
  reconcileRetryMs: number
  /** Optional global cap on running tasks (unset = no cap). */
  maxConcurrentTasks?: number
}

export class Engine implements TimerHost {
  readonly runtimes = new Map<string, Runtime>()
  readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private busy = new Set<string>()
  private again = new Set<string>()
  private stopped = false

  constructor(readonly deps: EngineDeps) {}

  stop(): void {
    this.stopped = true
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    for (const rt of this.runtimes.values()) rt.abort.abort()
    this.runtimes.clear()
  }

  /** Schedule a step for this task (coalesced; one step runs at a time per task). */
  kick(taskId: string): void {
    if (this.stopped) return
    queueMicrotask(() => { void this.advance(taskId) })
  }

  async advance(taskId: string): Promise<void> {
    if (this.stopped) return
    if (this.busy.has(taskId)) { this.again.add(taskId); return }
    this.busy.add(taskId)
    try {
      const task = this.deps.store.getTask(taskId)
      if (!task) return
      await this.step(task)
    } catch (e) {
      this.deps.log(`task-service: step for ${taskId} failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      this.busy.delete(taskId)
      if (!this.stopped) {
        try {
          const latest = this.deps.store.getTask(taskId)
          if (latest) armTimer(this, latest)
        } catch (e) {
          this.deps.log(`task-service: re-arming timer for ${taskId} failed: ${e instanceof Error ? e.message : String(e)}`)
        }
        if (this.again.delete(taskId)) this.kick(taskId)
      }
    }
  }

  private async step(task: TaskRecord): Promise<void> {
    const attempt = this.currentAttempt(task)
    switch (task.phase) {
      case 'STARTING':
        if (attempt && attempt.state === 'planned') await this.dispatch(task, attempt)
        else if (attempt && observable(attempt) && !this.runtimes.has(task.taskId) && attempt.delivery !== 'not_sent') this.startObserve(task, attempt)
        return
      case 'ACTIVE': case 'WAITING_PERMISSION': case 'WAITING_INPUT':
        if (attempt && observable(attempt) && !this.runtimes.has(task.taskId)) this.startObserve(task, attempt)
        return
      case 'FALLBACK_PENDING':
        await evaluateFallback(this, task)
        return
      case 'FINALIZING':
        await finalizeTask(this, task)
        return
      case 'UNKNOWN':
        await reconcileTask(this, task)
        return
      default:
        return
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────
  currentAttempt(task: TaskRecord): AttemptRecord | undefined {
    return task.currentExecutionAttemptId ? this.deps.store.getAttempt(task.currentExecutionAttemptId) : undefined
  }

  currentTurn(task: TaskRecord): TurnRecord | undefined {
    return task.currentTurnId ? this.deps.store.getTurn(task.currentTurnId) : undefined
  }

  backendFor(attempt: AttemptRecord): TaskBackend {
    const b = this.deps.registry.get(attempt.backend)
    if (!b) throw new Error(`no backend for ${attempt.backend.kind}/${attempt.backend.mode}`)
    return b
  }

  attemptContext(task: TaskRecord, attempt: AttemptRecord, turnId: string): AttemptContext {
    const runDir = join(this.deps.runRoot, attempt.executionAttemptId)
    mkdirSync(runDir, { recursive: true, mode: 0o700 })
    return {
      taskId: task.taskId,
      executionAttemptId: attempt.executionAttemptId,
      executionId: attempt.executionId,
      turnId,
      candidate: attempt.backend,
      workdir: task.workdir,
      permissionMode: task.policy.permissionMode,
      runDir,
    }
  }

  handleOf(attempt: AttemptRecord, turn: TurnRecord | undefined): BackendHandle {
    return {
      backendSessionId: attempt.owner.backendSessionId,
      backendTurnId: turn?.backendTurnId ?? '',
      pid: attempt.owner.pid,
      pgid: attempt.owner.pgid,
      processStartIdentity: attempt.owner.processStartIdentity,
      extra: attempt.owner.extra,
    }
  }

  /** Guarded commit for an attempt-bound continuation. */
  commitForAttempt(taskId: string, attemptId: string, fn: (task: TaskRecord, attempt: AttemptRecord) => ReturnType<Parameters<Committer['commit']>[1]>) {
    return this.deps.committer.commit(taskId, task => {
      if (task.currentExecutionAttemptId !== attemptId || task.phase === 'CLOSED') return null
      const attempt = this.deps.store.getAttempt(attemptId)
      if (!attempt) return null
      return fn(task, attempt)
    })
  }

  // ── dispatch (design doc §9.5) ─────────────────────────────────────────
  private async dispatch(task: TaskRecord, planned: AttemptRecord): Promise<void> {
    const { clock, store } = this.deps
    const backend = this.backendFor(planned)
    const turn = this.currentTurn(task)
    if (!turn) throw new Error(`task ${task.taskId} has no current turn`)
    const attemptId = planned.executionAttemptId

    const grantProblem = this.grantProblem(task, clock.now())
    if (grantProblem) { await this.grantExpiredBeforeDispatch(task, planned, grantProblem); return }
    if (!workdirUnchanged(task.workdir)) { requestFinalize(this, task.taskId, { kind: 'terminate', reason: 'WORKDIR_CHANGED', graceSeconds: null }); return }

    const started = this.commitForAttempt(task.taskId, attemptId, (t, a) => {
      if (t.phase !== 'STARTING' || a.state !== 'planned' || t.sealed) return null
      const next = { ...a, state: 'starting' as const, startedAtMs: clock.now() }
      return {
        task: { ...t, owner: ownerFor(next, 'starting'), actualBackend: next.backend, selectedCandidateIndex: next.candidateIndex },
        attempts: [next], control: true,
        events: [attemptEvent('execution_attempt.started', next, turn.turnId, { backend: next.backend, isStartupRetry: next.isStartupRetry, inputSha256: next.inputSha256 })],
      }
    })
    if (!started) return
    let attempt = store.getAttempt(attemptId)!
    const ctx = this.attemptContext(task, attempt, turn.turnId)
    const abort = new AbortController()

    const pre = await backend.preflight(ctx, abort.signal).catch(e => notSentFrom('backend_unavailable', e))
    if (pre.kind === 'not_sent') { this.failNotSent(task.taskId, attemptId, pre); return }

    const opened = await backend.open(ctx, abort.signal).catch(e => notSentFrom('startup_failed', e, false))
    if (opened.kind === 'not_sent') { this.failNotSent(task.taskId, attemptId, opened); return }

    // Persist the owner identity unconditionally (even if cancelled meanwhile) so release can find it.
    const established = this.commitForAttempt(task.taskId, attemptId, (t, a) => {
      const next = { ...a, owner: { ...a.owner, ...ownerFacts(opened.handle) } }
      const tu = store.getTurn(turn.turnId)!
      const nextTurn = { ...tu, backendTurnId: opened.handle.backendTurnId, evidence: { ...tu.evidence, backendSessionId: opened.handle.backendSessionId, backendTurnId: opened.handle.backendTurnId } }
      return {
        task: { ...t, owner: ownerFor(next, 'live') }, attempts: [next], turns: [nextTurn], control: true,
        events: [attemptEvent('owner.established', next, turn.turnId, { backendSessionId: opened.handle.backendSessionId, generation: next.generation })],
      }
    })
    if (!established) return
    attempt = store.getAttempt(attemptId)!

    // Final gate, atomically with marking the input in flight (spec §12.4 step 5).
    const inFlight = this.commitForAttempt(task.taskId, attemptId, (t, a) => {
      if (t.phase !== 'STARTING' || t.sealed || this.grantProblem(t, clock.now()) || !workdirUnchanged(t.workdir)) return null
      const tu = store.getTurn(turn.turnId)!
      return {
        task: { ...t, grant: t.grant ? { ...t.grant, state: 'consumed' as const } : null },
        attempts: [{ ...a, delivery: 'in_flight' as const }],
        turns: [{ ...tu, state: 'submitted' as const }],
      }
    })
    if (!inFlight) {
      const latest = store.getTask(task.taskId)!
      if (latest.phase === 'STARTING' && !latest.sealed) {
        const problem = this.grantProblem(latest, clock.now()) ?? (workdirUnchanged(latest.workdir) ? null : 'workdir_changed')
        if (problem === 'workdir_changed') requestFinalize(this, task.taskId, { kind: 'terminate', reason: 'WORKDIR_CHANGED', graceSeconds: null })
        else if (problem) await this.grantExpiredBeforeDispatch(latest, attempt, problem)
      } else this.kick(task.taskId)
      return
    }

    const prompt = store.getPrompt(task.taskId) ?? ''
    const handle = this.handleOf(attempt, store.getTurn(turn.turnId))
    const submitted = await backend.submit(ctx, handle, { inputKind: task.assignment.inputKind, prompt }, abort.signal)
      .catch(e => ({ kind: 'unknown' as const, detail: `submit threw: ${e instanceof Error ? e.message : String(e)}` }))

    if (submitted.kind === 'not_sent') {
      this.commitForAttempt(task.taskId, attemptId, (t, a) => ({
        task: { ...t, grant: t.grant ? { ...t.grant, state: 'valid' as const } : null }, attempts: [{ ...a, delivery: 'not_sent' as const }],
      }))
      this.failNotSent(task.taskId, attemptId, submitted)
      return
    }
    if ((submitted.kind === 'accepted' || submitted.kind === 'pending') && submitted.handle) this.updateHandle(task.taskId, attemptId, submitted.handle)
    if (submitted.kind === 'accepted') this.markAccepted(task.taskId, attemptId)
    if (submitted.kind === 'unknown') {
      this.commitForAttempt(task.taskId, attemptId, (t, a) => {
        const tu = store.getTurn(turn.turnId)!
        return {
          task: t, attempts: [{ ...a, delivery: 'unknown' as const }], turns: [{ ...tu, delivery: 'unknown' as const }],
          events: [attemptEvent('backend.diagnostic', a, turn.turnId, { detail: submitted.detail })],
        }
      })
    }
    const fresh = store.getTask(task.taskId)!
    this.startObserve(fresh, store.getAttempt(attemptId)!)
  }

  /** Why the current grant cannot authorize a dispatch right now (null = fine). */
  grantProblem(task: TaskRecord, now: number): string | null {
    const g = task.grant
    if (!g || g.state !== 'valid') return 'no_valid_grant'
    if (g.expiresAtMs <= now) return 'grant_expired'
    if (g.promptSha256 !== task.assignment.promptSha256 || g.contractSha256 !== task.assignment.contractSha256 || g.fallbackPlanSha256 !== task.fallbackPlanSha256) return 'grant_mismatch'
    return null
  }

  private async grantExpiredBeforeDispatch(task: TaskRecord, attempt: AttemptRecord, problem: string): Promise<void> {
    if (attempt.ordinal === 0) {
      requestFinalize(this, task.taskId, { kind: 'terminate', reason: 'AUTHORIZATION_EXPIRED', graceSeconds: null })
      return
    }
    requestAuthorization(this, task.taskId, attempt.executionAttemptId, 'grant_expired', problem)
  }

  updateHandle(taskId: string, attemptId: string, handle: BackendHandle): void {
    this.commitForAttempt(taskId, attemptId, (t, a) => {
      const next = { ...a, owner: { ...a.owner, ...ownerFacts(handle), extra: { ...a.owner.extra, ...handle.extra } } }
      const tu = t.currentTurnId ? this.deps.store.getTurn(t.currentTurnId) : undefined
      const turns = tu && handle.backendTurnId && handle.backendTurnId !== tu.backendTurnId
        ? [{ ...tu, backendTurnId: handle.backendTurnId, evidence: { ...tu.evidence, backendTurnId: handle.backendTurnId, backendSessionId: handle.backendSessionId ?? tu.evidence.backendSessionId } }]
        : []
      return { task: { ...t, owner: { ...ownerFor(next, t.owner.state) } }, attempts: [next], turns }
    })
  }

  markAccepted(taskId: string, attemptId: string): void {
    const { clock, store } = this.deps
    this.commitForAttempt(taskId, attemptId, (t, a) => {
      const tu = t.currentTurnId ? store.getTurn(t.currentTurnId) : undefined
      if (!tu || tu.delivery === 'accepted') return null
      const now = clock.now()
      const phase = t.phase === 'STARTING' ? 'ACTIVE' as const : t.phase
      return {
        task: { ...t, phase, budgets: { ...t.budgets, lastActivityAtMs: now } },
        attempts: [{ ...a, delivery: 'accepted' as const, state: 'running' as const }],
        turns: [{ ...tu, delivery: 'accepted' as const, state: tu.state === 'ended' ? tu.state : 'running' as const, startedAtMs: tu.startedAtMs ?? now }],
        events: [attemptEvent('turn.accepted', a, tu.turnId, { backendTurnId: tu.backendTurnId })],
      }
    })
  }

  /** Positive not-sent proof: record the attempt end, then evaluate fallback or finalize. */
  failNotSent(taskId: string, attemptId: string, ns: NotSent): void {
    const failure: ClassifiedFailure = {
      code: ns.code, stage: 'before_delivery', uncertain: false, ownerSettled: ns.ownerSettled, effectStatus: 'none', detail: ns.detail,
    }
    this.endAttemptWithFailure(taskId, attemptId, failure, 'not_started')
  }

  endAttemptWithFailure(taskId: string, attemptId: string, failure: ClassifiedFailure, outcome: AttemptRecord['outcome']): void {
    const { clock } = this.deps
    const res = this.commitForAttempt(taskId, attemptId, (t, a) => {
      const now = clock.now()
      const ended: AttemptRecord = {
        ...a, state: a.delivery === 'not_sent' ? 'skipped' : 'ended', outcome, endedAtMs: now,
        effectStatus: failure.effectStatus,
        ownerReleased: failure.ownerSettled ? true : a.ownerReleased,
        failure: { code: failure.code ?? 'other', stage: failure.stage, detail: failure.detail, evidenceDigest: null },
      }
      const events = [attemptEvent('execution_attempt.ended', ended, t.currentTurnId, { outcome, failure: ended.failure, delivery: ended.delivery })]
      // A sealed task still needs a terminal path: decide() returns terminate(sealed) → QUIESCENT/FINALIZING.
      if (t.phase === 'FINALIZING') return { task: t, attempts: [ended], events }
      const pre = preDecide(this, t, ended, failure)
      const delivered = ended.delivery !== 'not_sent'
      let phase: TaskRecord['phase']
      if (pre === 'fallback') phase = 'FALLBACK_PENDING'
      else if (pre === 'unknown') phase = 'UNKNOWN'
      else phase = delivered ? 'QUIESCENT' : 'FINALIZING'
      const intent = phase === 'FINALIZING' ? { kind: 'terminate' as const, reason: 'BACKEND_FAILED', graceSeconds: null } : t.intent
      return {
        task: {
          ...t, phase, intent,
          owner: failure.ownerSettled ? { ...t.owner, state: 'released' as const } : t.owner,
          needsAttention: phase === 'UNKNOWN' ? true : t.needsAttention,
          budgets: phase === 'QUIESCENT' ? { ...t.budgets, quiescentDeadlineAtMs: now + t.policy.quiescentTimeoutSeconds * 1000 }
            : phase === 'FALLBACK_PENDING' ? { ...t.budgets, recoveryEnteredAtMs: now } : t.budgets,
          fallbackState: phase === 'FALLBACK_PENDING' ? 'evaluating' as const : t.fallbackState,
        },
        attempts: [ended], events, control: true,
      }
    })
    if (res) this.kick(taskId)
  }

  // ── observation ────────────────────────────────────────────────────────
  startObserve(task: TaskRecord, attempt: AttemptRecord): void {
    if (this.runtimes.has(task.taskId)) return
    const turn = this.currentTurn(task)
    if (!turn) return
    const backend = this.backendFor(attempt)
    const rt: Runtime = {
      attemptId: attempt.executionAttemptId,
      turnId: turn.turnId,
      abort: new AbortController(),
      ...restoreTurnState(this.deps.store, task.taskId, turn.turnId),
      lastActivityCommitMs: 0,
      caps: null,
    }
    this.runtimes.set(task.taskId, rt)
    const ctx = this.attemptContext(task, attempt, turn.turnId)
    const handle = this.handleOf(attempt, turn)
    void (async () => {
      let finished = false
      try {
        rt.caps = await backend.capabilities()
        for await (const ev of backend.observe(ctx, handle, rt.abort.signal)) {
          if (applyBackendEvent(this, task.taskId, rt, ev)) { finished = true; break }
        }
      } catch (e) {
        this.deps.log(`task-service: observe ${task.taskId} failed: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        if (this.runtimes.get(task.taskId) === rt) this.runtimes.delete(task.taskId)
      }
      try {
        if (!finished && !rt.abort.signal.aborted && !this.stopped) {
          this.markUnknown(task.taskId, rt.attemptId, 'observation ended without a turn end')
        }
      } catch (e) {
        this.deps.log(`task-service: marking ${task.taskId} UNKNOWN failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      this.kick(task.taskId)
    })().catch(e => this.deps.log(`task-service: observer for ${task.taskId} crashed: ${e instanceof Error ? e.message : String(e)}`))
  }

  markUnknown(taskId: string, attemptId: string, reason: string): void {
    this.commitForAttempt(taskId, attemptId, t => {
      if (t.phase === 'UNKNOWN' || t.phase === 'FINALIZING' || t.phase === 'QUIESCENT') return null
      return {
        task: { ...t, phase: 'UNKNOWN', needsAttention: true, owner: { ...t.owner, state: 'unknown' }, terminalReason: 'DELIVERY_UNKNOWN' },
        events: [taskEvent('task.unknown', { reason })],
      }
    })
  }

  stopObserving(taskId: string): void {
    const rt = this.runtimes.get(taskId)
    if (rt) { rt.abort.abort(); this.runtimes.delete(taskId) }
  }
}

/** An attempt that already ended is never observed again (prevents re-observe loops). */
function observable(a: AttemptRecord): boolean {
  return a.state !== 'ended' && a.state !== 'skipped'
}

function ownerFacts(h: BackendHandle) {
  return { backendSessionId: h.backendSessionId, pid: h.pid, pgid: h.pgid, processStartIdentity: h.processStartIdentity, extra: h.extra }
}

function notSentFrom(code: NotSent['code'], e: unknown, settled = true): NotSent {
  return { kind: 'not_sent', code, detail: e instanceof Error ? e.message : String(e), ownerSettled: settled }
}

/** Rebuild per-turn observation state from committed events, so a re-attached observer never duplicates them. */
function restoreTurnState(store: TaskStore, taskId: string, turnId: string): Pick<Runtime, 'streams' | 'activeTools' | 'seenTools'> {
  const streams = new TextStreams()
  const texts = new Map<string, string>()
  const seenTools = new Set<string>()
  const activeTools = new Set<string>()
  let after = 0
  for (;;) {
    const page = store.readEvents(taskId, after, 500, 8 * 1024 * 1024)
    if (!page.length) break
    for (const e of page) {
      if (e.turnId !== turnId) continue
      const id = String(e.data.streamId ?? '')
      if (e.type === 'text.reset') texts.set(id, '')
      if (e.type === 'text.delta') texts.set(id, (texts.get(id) ?? '') + String(e.data.text ?? ''))
      if (e.type.startsWith('tool.')) {
        const call = String(e.data.toolCallId ?? '')
        seenTools.add(`${call}:${e.data.status}`)
        if (e.data.status === 'started') activeTools.add(call); else activeTools.delete(call)
      }
    }
    after = page[page.length - 1].seq
  }
  for (const [id, text] of texts) streams.restore(id, text)
  return { streams, activeTools, seenTools }
}
