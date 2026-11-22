/**
 * OpenCode task backend (`opencode` / `http_sse`, design doc §11.2). Wraps
 * the router's existing OpenCodeAdapter instance — all HTTP/SSE handling
 * lives there; this file only maps it onto the TaskBackend contract.
 *
 * Owner = one OpenCode session created per execution attempt (chat sessions
 * are never reused). Turn identity = the prompt message ID, generated in
 * open() so the engine persists it before submit(). Release is
 * session-scoped only: it never stops `opencode serve`, never touches other
 * sessions and keeps the session for audit (no delete).
 */
import { parseModel, type OpenCodeModel } from '../../adapters/opencode/model'
import { nextPromptId, type OpenCodeAdapter, type TurnEvent } from '../../adapters/opencode/opencode-adapter'
import { hasActiveToolPart, isSessionBusy, selectTurnMessages } from '../../adapters/opencode/turn'
import type {
  AttemptContext, BackendCapabilities, BackendEvent, BackendHandle, LocateResult, NotSent, OpenResult,
  ReleaseResult, SubmitResult, TaskBackend, TurnProcess,
} from './backend'
import { notSent } from './backend'

export interface OpenCodeTaskBackendOptions {
  /** How long a capabilities() health probe stays valid. Default 10 s (design §9.2). */
  healthTtlMs?: number
  /** Status poll interval while release waits for the session to settle. Default 200 ms. */
  releasePollMs?: number
  /** Consecutive failed polls before observe() reports `lost`. Default 120. */
  maxConsecutivePollFailures?: number
  now?: () => number
}

const DEFAULT_HEALTH_TTL_MS = 10_000
const DEFAULT_RELEASE_POLL_MS = 200
const DEFAULT_MAX_POLL_FAILURES = 120
const NO_PROCESS: TurnProcess = { exitCode: null, signal: null, controlledShutdown: null }

const TRIGGERS: BackendCapabilities['fallback']['supportedFallbackTriggers'] = [
  { code: 'backend_unavailable', stage: 'before_delivery' },
  { code: 'startup_failed', stage: 'before_delivery' },
  { code: 'rate_limited', stage: 'before_delivery' },
  { code: 'provider_unavailable', stage: 'before_delivery' },
]

interface HealthCache { atMs: number; healthy: boolean; detail: string | null }

export class OpenCodeTaskBackend implements TaskBackend {
  readonly kind = 'opencode' as const
  readonly mode = 'http_sse' as const
  private health: HealthCache | null = null
  private readonly healthTtlMs: number
  private readonly releasePollMs: number
  private readonly maxPollFailures: number
  private readonly now: () => number

  constructor(private readonly adapter: OpenCodeAdapter, opts: OpenCodeTaskBackendOptions = {}) {
    this.healthTtlMs = opts.healthTtlMs ?? DEFAULT_HEALTH_TTL_MS
    this.releasePollMs = opts.releasePollMs ?? DEFAULT_RELEASE_POLL_MS
    this.maxPollFailures = opts.maxConsecutivePollFailures ?? DEFAULT_MAX_POLL_FAILURES
    this.now = opts.now ?? Date.now
  }

  async capabilities(): Promise<BackendCapabilities> {
    const fresh = this.health && this.now() - this.health.atMs < this.healthTtlMs ? this.health : await this.probe()
    return {
      kind: this.kind, mode: this.mode, available: fresh.healthy, availabilityReason: fresh.healthy ? null : (fresh.detail ?? 'unhealthy'),
      features: { isolatedSession: true, samePrimaryTurns: false, recoverAcceptedTurn: true, permissionReply: true, cancel: true, eventReplay: true },
      permissionModes: ['broker', 'backend_policy'],
      fallback: {
        orderedFallback: true, supportedFallbackTriggers: TRIGGERS,
        cleanFailureFallback: false, checkpointHandoff: false, sameOwnerResetRecovery: false, nativeGoal: false,
      },
    }
  }

  async preflight(ctx: AttemptContext, _signal?: AbortSignal): Promise<{ kind: 'ok' } | NotSent> {
    const h = await this.probe(ctx.workdir.canonicalPath)
    return h.healthy ? { kind: 'ok' } : notSent('backend_unavailable', `OpenCode health check failed: ${h.detail ?? 'unhealthy'}`)
  }

  async open(ctx: AttemptContext, signal: AbortSignal): Promise<OpenResult> {
    const directory = ctx.workdir.canonicalPath
    try {
      const sessionId = await this.adapter.createSessionIn(directory, signal)
      const handle: BackendHandle = {
        backendSessionId: sessionId, backendTurnId: nextPromptId(),
        pid: null, pgid: null, processStartIdentity: null, extra: { directory },
      }
      return { kind: 'opened', handle }
    } catch (e) {
      // No session id came back, so nothing exists that this attempt owns.
      return notSent('startup_failed', `OpenCode session creation failed: ${errorText(e)}`, true)
    }
  }

  async submit(
    ctx: AttemptContext, handle: BackendHandle, input: { inputKind: 'text' | 'native_goal'; prompt: string }, signal: AbortSignal,
  ): Promise<SubmitResult> {
    if (input.inputKind === 'native_goal') return notSent('capability_unavailable', 'OpenCode has no native goal input', false)
    if (!handle.backendSessionId || !handle.backendTurnId) return notSent('startup_failed', 'no OpenCode session or message id recorded', !handle.backendSessionId)
    let model: OpenCodeModel | undefined
    try { model = parseModel(ctx.candidate.model) } catch (e) { return notSent('model_unavailable', errorText(e), false) }
    const r = await this.adapter.submitPrompt(handle.backendSessionId, directoryOf(ctx, handle), handle.backendTurnId, input.prompt, model, signal)
    switch (r.kind) {
      case 'accepted': return { kind: 'accepted' }
      // Either may have reached the server: observe the message id, never post again.
      case 'aborted': return { kind: 'unknown', detail: 'prompt request aborted before an acknowledgement' }
      case 'ambiguous': return { kind: 'unknown', detail: `prompt acknowledgement lost: ${r.detail}` }
      case 'http_error':
        if (r.reason === 'rate_limited') return notSent('rate_limited', r.detail, false)
        if (r.reason === 'capacity_exhausted') return notSent('provider_unavailable', r.detail, false)
        // A vanished session leaves nothing to release; any other rejection leaves the empty session.
        return notSent('startup_failed', r.detail, r.reason === 'session_missing')
    }
  }

  async *observe(ctx: AttemptContext, handle: BackendHandle, signal: AbortSignal): AsyncIterable<BackendEvent> {
    if (!handle.backendSessionId || !handle.backendTurnId) {
      yield { type: 'lost', detail: 'no OpenCode session or message id recorded for this attempt' }
      return
    }
    const mapper = new TurnEventMapper()
    const events = this.adapter.observeTurn(handle.backendSessionId, directoryOf(ctx, handle), handle.backendTurnId, signal, {
      watchdog: false, identity: true, taskId: ctx.taskId, maxConsecutivePollFailures: this.maxPollFailures,
    })
    for await (const ev of events) {
      for (const out of mapper.map(ev)) {
        yield out
        if (out.type === 'turn.ended' || out.type === 'lost') return
      }
      if (ev.type === 'task.aborted') return
    }
    if (!signal.aborted) yield { type: 'lost', detail: 'OpenCode observation ended without a turn end' }
  }

  async replyPermission(ctx: AttemptContext, handle: BackendHandle, backendRequestId: string, decision: 'allow_once' | 'deny_once'): Promise<'confirmed' | 'unknown'> {
    try {
      await this.adapter.replyPermission(backendRequestId, decision === 'allow_once' ? 'once' : 'reject', directoryOf(ctx, handle))
      return 'confirmed'
    } catch {
      return 'unknown'
    }
  }

  async interrupt(ctx: AttemptContext, handle: BackendHandle): Promise<void> {
    if (handle.backendSessionId) await this.adapter.abortSession(handle.backendSessionId, directoryOf(ctx, handle))
  }

  async release(ctx: AttemptContext, handle: BackendHandle, graceMs: number): Promise<ReleaseResult> {
    const sessionId = handle.backendSessionId
    if (!sessionId) return { released: true, backgroundWorkSettled: true, detail: 'no OpenCode session was created' }
    const directory = directoryOf(ctx, handle)
    try {
      if (isSessionBusy(await this.adapter.sessionStatus(directory), sessionId)) {
        await this.adapter.abortSession(sessionId, directory)
        if (!(await this.waitIdle(sessionId, directory, graceMs))) {
          return { released: false, backgroundWorkSettled: false, detail: `session ${sessionId} still busy after ${graceMs} ms` }
        }
      }
      const turn = handle.backendTurnId ? selectTurnMessages(await this.adapter.listMessages(sessionId, directory), handle.backendTurnId) : []
      if (hasActiveToolPart(turn)) return { released: false, backgroundWorkSettled: false, detail: `session ${sessionId} idle but a tool part is still running` }
      return { released: true, backgroundWorkSettled: true, detail: `session ${sessionId} idle; no running tool (session kept)` }
    } catch (e) {
      return { released: null, backgroundWorkSettled: null, detail: `could not verify session ${sessionId}: ${errorText(e)}` }
    }
  }

  async locate(ctx: AttemptContext, handle: BackendHandle): Promise<LocateResult> {
    if (!handle.backendSessionId || !handle.backendTurnId) return 'absent'
    return this.adapter.locateTurn(handle.backendSessionId, directoryOf(ctx, handle), handle.backendTurnId)
  }

  private async probe(workdir?: string): Promise<HealthCache> {
    const h = await this.adapter.health({ workdir: workdir ?? '' })
    this.health = { atMs: this.now(), healthy: h.healthy, detail: h.detail ?? null }
    return this.health
  }

  /** Polls /session/status until the session is no longer busy, up to graceMs (at least one check). */
  private async waitIdle(sessionId: string, directory: string, graceMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, graceMs)
    for (;;) {
      if (!isSessionBusy(await this.adapter.sessionStatus(directory), sessionId)) return true
      if (Date.now() >= deadline) return false
      await new Promise(r => setTimeout(r, Math.min(this.releasePollMs, Math.max(1, deadline - Date.now()))))
    }
  }
}

/**
 * Stateful mapping of one observation's TurnEvents to BackendEvents:
 * acceptance is reported once, identical text snapshots and repeated tool
 * status updates are dropped, and the final text is remembered for turn.ended.
 */
export class TurnEventMapper {
  private delivered = false
  private readonly texts = new Map<string, string>()
  private readonly tools = new Map<string, 'started' | 'completed' | 'failed'>()
  private finalText: string | null = null

  map(ev: TurnEvent): BackendEvent[] {
    switch (ev.type) {
      case 'prompt.accepted':
        if (this.delivered) return []
        this.delivered = true
        return [{ type: 'delivery', status: 'accepted' }]
      case 'text.snapshot':
        if (this.texts.get(ev.partId) === ev.text) return []
        this.texts.set(ev.partId, ev.text)
        return [{ type: 'text', streamId: ev.partId, text: ev.text, mode: 'snapshot' }]
      case 'tool.started': return this.tool(ev.callId ?? ev.partId, ev.toolName, 'started')
      case 'tool.completed': return this.tool(ev.callId ?? ev.partId, ev.toolName, 'completed')
      case 'tool.failed': return this.tool(ev.callId ?? ev.partId, ev.toolName, 'failed', ev.error)
      case 'permission.requested':
        return [{ type: 'permission.requested', backendRequestId: ev.requestId, toolCallId: ev.callId ?? null, toolName: ev.toolName, description: ev.description }]
      case 'text.completed':
        this.finalText = ev.text
        return []
      case 'session.idle': return [this.ended('completed', null)]
      case 'task.failed': return [this.failed(ev.reason, ev.detail)]
      default: return []
    }
  }

  private tool(id: string | undefined, name: string, status: 'started' | 'completed' | 'failed', detail?: string): BackendEvent[] {
    const toolCallId = id ?? `tool:${name}`
    if (this.tools.get(toolCallId) === status) return []
    this.tools.set(toolCallId, status)
    return [{ type: 'tool', toolCallId, name, status, ...(detail ? { detail } : {}) }]
  }

  private failed(reason: string, detail?: string): BackendEvent {
    if (reason === 'session_missing') return { type: 'lost', detail: 'OpenCode session disappeared during the turn' }
    if (reason === 'observation_lost') return { type: 'lost', detail: `OpenCode observation lost: ${detail ?? 'polling failed'}` }
    return this.ended('failed', reason)
  }

  private ended(outcome: 'completed' | 'failed', error: string | null): BackendEvent {
    const activeToolCount = [...this.tools.values()].filter(s => s === 'started').length
    return {
      type: 'turn.ended', outcome,
      finalText: outcome === 'completed' ? this.finalText : null,
      protocol: { backendFinished: true, activeToolCount, stopReason: error ?? 'completed' },
      process: NO_PROCESS,
      ...(outcome === 'failed' ? { failureCode: 'execution_failed' as const } : {}),
      // An errored turn's message list can omit unfinished tool parts, so only a clean, tool-free completion proves no effects.
      effects: outcome === 'completed' && !this.tools.size ? 'none' : 'unknown',
    }
  }
}

function directoryOf(ctx: AttemptContext, handle: BackendHandle): string {
  const d = handle.extra.directory
  return typeof d === 'string' && d ? d : ctx.workdir.canonicalPath
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
