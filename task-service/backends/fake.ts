/**
 * Scripted fault-injection backend (design doc §11.3). Each attempt consumes
 * the next script for its candidate model; every submit is recorded so tests
 * can assert that no input is ever delivered twice.
 */
import type {
  AttemptContext, BackendCapabilities, BackendEvent, BackendHandle, LocateResult, NotSentCode, OpenResult, ReleaseResult, SubmitResult, TaskBackend,
} from './backend'
import { notSent } from './backend'

export interface FakeScript {
  preflight?: 'ok' | NotSentCode
  open?: 'ok' | NotSentCode
  submit?: 'accepted' | 'pending' | 'unknown' | NotSentCode
  /** Events emitted by observe() in order; `delayMs` entries pause. */
  events?: (BackendEvent | { delayMs: number })[]
  /** After the scripted events, keep observing until interrupted (then end as cancelled). */
  hang?: boolean
  release?: 'ok' | 'fail'
  locate?: LocateResult
  permissionReply?: 'confirmed' | 'unknown'
}

export interface FakeLog {
  submits: { taskId: string; attemptId: string; prompt: string }[]
  interrupts: string[]
  releases: string[]
  permissionReplies: { backendRequestId: string; decision: string }[]
}

const ALL_TRIGGERS: BackendCapabilities['fallback']['supportedFallbackTriggers'] = [
  { code: 'backend_unavailable', stage: 'before_delivery' },
  { code: 'capability_unavailable', stage: 'before_delivery' },
  { code: 'authentication_invalid', stage: 'before_delivery' },
  { code: 'authentication_invalid', stage: 'clean_failure' },
  { code: 'startup_failed', stage: 'before_delivery' },
  { code: 'rate_limited', stage: 'before_delivery' },
  { code: 'rate_limited', stage: 'clean_failure' },
  { code: 'rate_limited', stage: 'checkpoint_handoff' },
  { code: 'provider_unavailable', stage: 'before_delivery' },
  { code: 'model_unavailable', stage: 'before_delivery' },
  { code: 'execution_failed', stage: 'clean_failure' },
  { code: 'execution_failed', stage: 'checkpoint_handoff' },
  { code: 'idle_timeout', stage: 'clean_failure' },
]

export class FakeBackend implements TaskBackend {
  readonly kind = 'fake' as const
  readonly mode = 'exec' as const
  readonly scripts = new Map<string, FakeScript[]>()
  readonly log: FakeLog = { submits: [], interrupts: [], releases: [], permissionReplies: [] }
  private active = new Map<string, FakeScript>()
  private interrupted = new Set<string>()
  available = true

  script(model: string, ...s: FakeScript[]): this {
    this.scripts.set(model, [...(this.scripts.get(model) ?? []), ...s])
    return this
  }

  private scriptFor(ctx: AttemptContext): FakeScript {
    const existing = this.active.get(ctx.executionAttemptId)
    if (existing) return existing
    const queue = this.scripts.get(ctx.candidate.model) ?? []
    const s = queue.shift() ?? {}
    this.active.set(ctx.executionAttemptId, s)
    return s
  }

  async capabilities(): Promise<BackendCapabilities> {
    return {
      kind: 'fake', mode: 'exec', available: this.available, availabilityReason: this.available ? null : 'disabled',
      features: { isolatedSession: true, samePrimaryTurns: false, recoverAcceptedTurn: true, permissionReply: true, cancel: true, eventReplay: true },
      permissionModes: ['broker', 'backend_policy'],
      fallback: { orderedFallback: true, supportedFallbackTriggers: ALL_TRIGGERS, cleanFailureFallback: true, checkpointHandoff: true, sameOwnerResetRecovery: false, nativeGoal: false },
    }
  }

  async preflight(ctx: AttemptContext): Promise<{ kind: 'ok' } | ReturnType<typeof notSent>> {
    const s = this.scriptFor(ctx)
    return !s.preflight || s.preflight === 'ok' ? { kind: 'ok' } : notSent(s.preflight, `scripted preflight ${s.preflight}`)
  }

  async open(ctx: AttemptContext): Promise<OpenResult> {
    const s = this.scriptFor(ctx)
    if (s.open && s.open !== 'ok') return notSent(s.open, `scripted open ${s.open}`)
    return { kind: 'opened', handle: { backendSessionId: `fake-session-${ctx.executionAttemptId}`, backendTurnId: `fake-turn-${ctx.turnId}`, pid: null, pgid: null, processStartIdentity: null, extra: {} } }
  }

  async submit(ctx: AttemptContext, _h: BackendHandle, input: { prompt: string }): Promise<SubmitResult> {
    const s = this.scriptFor(ctx)
    const r = s.submit ?? 'accepted'
    if (r === 'accepted' || r === 'pending' || r === 'unknown') this.log.submits.push({ taskId: ctx.taskId, attemptId: ctx.executionAttemptId, prompt: input.prompt })
    if (r === 'accepted') return { kind: 'accepted' }
    if (r === 'pending') return { kind: 'pending' }
    if (r === 'unknown') return { kind: 'unknown', detail: 'scripted ack loss' }
    return notSent(r, `scripted submit ${r}`)
  }

  async *observe(ctx: AttemptContext, _h: BackendHandle, signal: AbortSignal): AsyncIterable<BackendEvent> {
    const s = this.scriptFor(ctx)
    for (const e of s.events ?? []) {
      if (signal.aborted) return
      if ('delayMs' in e) { await sleep(e.delayMs, signal); continue }
      yield e
      if (e.type === 'turn.ended' || e.type === 'lost') return
    }
    if (!s.hang) {
      if (!(s.events ?? []).length) {
        yield { type: 'turn.ended', outcome: 'completed', finalText: 'fake done', protocol: { backendFinished: true, activeToolCount: 0, stopReason: 'end_turn' }, process: { exitCode: null, signal: null, controlledShutdown: false }, effects: 'none' }
      }
      return
    }
    while (!signal.aborted && !this.interrupted.has(ctx.executionAttemptId)) await sleep(10, signal)
    if (this.interrupted.has(ctx.executionAttemptId) && !signal.aborted) {
      yield { type: 'turn.ended', outcome: 'cancelled', finalText: null, protocol: { backendFinished: true, activeToolCount: 0, stopReason: 'interrupted' }, process: { exitCode: null, signal: null, controlledShutdown: true } }
    }
  }

  async replyPermission(ctx: AttemptContext, _h: BackendHandle, backendRequestId: string, decision: string): Promise<'confirmed' | 'unknown'> {
    this.log.permissionReplies.push({ backendRequestId, decision })
    return this.scriptFor(ctx).permissionReply ?? 'confirmed'
  }

  async interrupt(ctx: AttemptContext): Promise<void> {
    this.log.interrupts.push(ctx.executionAttemptId)
    this.interrupted.add(ctx.executionAttemptId)
  }

  async release(ctx: AttemptContext): Promise<ReleaseResult> {
    this.log.releases.push(ctx.executionAttemptId)
    this.interrupted.add(ctx.executionAttemptId)
    const ok = (this.scriptFor(ctx).release ?? 'ok') === 'ok'
    return { released: ok ? true : null, backgroundWorkSettled: ok ? true : null, detail: ok ? 'fake released' : 'fake release unverified' }
  }

  async locate(ctx: AttemptContext): Promise<LocateResult> {
    return this.scriptFor(ctx).locate ?? 'running'
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}
