/**
 * OpenCode Adapter — talks to a local `opencode serve` over HTTP + SSE.
 *
 * Endpoint paths and payload shapes below were verified against a real
 * `opencode serve` v1.18.15 running locally: its own OpenAPI doc (`GET
 * /doc`) plus live-captured event streams from actual prompts. Notably:
 *   - `POST /session/{id}/prompt_async` returns 204 immediately and runs the
 *     turn in the background. This adapter deliberately does NOT use the
 *     SYNCHRONOUS `POST /session/{id}/message` variant: that request only
 *     resolves when the whole turn finishes, and real multi-minute turns
 *     (75+ steps) were being killed by the HTTP transport at ~4-5 minutes,
 *     surfacing as `connection_failed: The operation timed out.` while
 *     `opencode serve` kept working and the result was lost.
 *   - Completion and the final `{info, parts}` are read from
 *     `GET /session/{id}/message` once a `/session/status` poll confirms idle.
 *     Session-wide SSE idle is not sufficient turn-completion proof. Polling the
 *     small status map first means a long turn does not need any single HTTP
 *     request to stay open for its whole duration.
 *   - Both `/event` and `/session/status` are scoped by `directory`, so the
 *     adapter passes the project workdir (AgentTask.directory) to them —
 *     without it the global stream silently never carries this session's
 *     events (an earlier version of this adapter hit exactly that).
 *   - A permission request mid-task blocks the session; it is observed on the
 *     SSE stream and answered via `POST /permission/{requestID}/reply`
 *     (confirmed in the schema; the sessionID-scoped
 *     `/session/{id}/permissions/{id}` variant is marked `deprecated`).
 * `apiPaths` stays overridable in case a different OpenCode version's
 * layout drifts from what was verified here.
 *
 * The turn is split into submitPrompt() + observeTurn() so the task service
 * (task-service/backends/opencode.ts) can persist the message ID before
 * submitting and re-attach observation after a restart. send() composes
 * the two with the chat watchdog on, exactly as before.
 *
 * Wired into router.ts. Contract-tested here against a local mock
 * server (opencode-adapter.test.ts) built to match the verified shapes.
 */
import type {
  AgentAdapter, AgentEvent, AgentSession, AgentTarget, AgentTask,
  ConversationContext, FileDiff, FinalMessage, HealthStatus, PermissionDecision,
} from '../agent-adapter'
import type { AgentKind } from '../../routing/types'
import type { OpenCodeModel } from './model'
import { SSEBuffer } from './sse'
import { belongsToSession, normalizeOpenCodeEvent, normalizeTurnIdentityEvent, type RawOpenCodeEvent } from './normalize'
import {
  classifyTurn, finalizeTurn, hasPromptMessage, isSessionBusy,
  type RawMessage, type RawPart, type StatusMap, type TurnEvent,
} from './turn'
import { describeTaskTimeout, TurnWatchdog, type TimeoutSnapshot } from './watchdog'

export { describeTaskTimeout, formatTaskDuration, type TaskTimeoutKind } from './watchdog'
export type { RawMessage, StatusMap, TurnEvent } from './turn'

export class OpenCodeError extends Error {
  constructor(message: string, readonly status?: number, readonly path?: string) { super(message) }
}
export function isMissingOpenCodeSession(error: unknown): boolean {
  return error instanceof OpenCodeError && (error.status === 404 || error.status === 410)
}

export interface OpenCodeApiPaths {
  health: string
  createSession: string
  session: (id: string) => string
  promptAsync: (id: string) => string
  abort: (id: string) => string
  events: string
  respondPermission: (requestId: string) => string
  messages: (sessionId: string) => string
  diff: (sessionId: string) => string
}

export const DEFAULT_OPENCODE_PATHS: OpenCodeApiPaths = {
  health: '/session/status',
  createSession: '/session',
  session: (id) => `/session/${id}`,
  promptAsync: (id) => `/session/${id}/prompt_async`,
  abort: (id) => `/session/${id}/abort`,
  events: '/event',
  respondPermission: (requestId) => `/permission/${requestId}/reply`,
  messages: (sessionId) => `/session/${sessionId}/message`,
  diff: (sessionId) => `/session/${sessionId}/diff`,
}

export interface OpenCodeAdapterConfig {
  baseUrl: string
  requestTimeoutSeconds: number
  /** No-progress timeout: a turn is aborted only after this long without any observed
   *  tool/text/permission activity. Progress re-arms the timer, so legitimate long
   *  turns are not cut off just for exceeding a fixed wall-clock duration. */
  taskTimeoutSeconds: number
  /** Absolute cap regardless of progress (seconds). Defaults to 8 hours. */
  taskHardCapSeconds?: number
  passwordEnv?: string
  paths?: Partial<OpenCodeApiPaths>
  /** How often to poll `/session/status` while a turn runs (ms). Defaults to 1000. */
  pollIntervalMs?: number
  /** Called with a message when something recoverable goes wrong internally (e.g. the
   *  supplementary message-list fetch fails) — the adapter itself
   *  has no logger, so wire this to the caller's own (router.ts's `dbg`, in practice). */
  onWarn?: (msg: string) => void
}

/** Outcome of the single prompt_async POST. `ambiguous`/`aborted` mean the server may have accepted it. */
export type SubmitPromptResult =
  | { kind: 'accepted' }
  | { kind: 'http_error'; status: number; reason: 'rate_limited' | 'capacity_exhausted' | 'session_missing' | 'rejected'; detail: string }
  | { kind: 'ambiguous'; detail: string }
  | { kind: 'aborted' }

export interface ObserveTurnOptions {
  /** Chat no-progress/hard-cap watchdog. The task path passes false: the task engine owns time limits. */
  watchdog: boolean
  /** Label for emitted events' `taskId`; defaults to the message ID. */
  taskId?: string
  /** Emit text.snapshot, tool part identity, permission callId and prompt.accepted. Only sound for a session that runs this turn alone. */
  identity?: boolean
  /** End with task.failed `observation_lost` after this many consecutive failed polls (unset = keep polling). */
  maxConsecutivePollFailures?: number
}

export type TurnLocation = 'absent' | 'running' | 'ended' | 'missing' | 'unreachable'

const DEFAULT_POLL_INTERVAL_MS = 1000
const DEFAULT_TASK_HARD_CAP_SECONDS = 8 * 60 * 60
const STATUS_PATH = '/session/status'

// Match OpenCode v1.18.15's ascending message identifier: a six-byte
// timestamp/counter prefix plus 14 random base62 characters. Arbitrary UUIDs
// can sort before historical turns in OpenCode's message history.
let promptTimestamp = 0
let promptCounter = 0
export function nextPromptId(): string {
  const now = Date.now()
  if (now !== promptTimestamp) { promptTimestamp = now; promptCounter = 0 }
  const timestamp = BigInt(now) * 0x1000n + BigInt(++promptCounter)
  const prefix = (timestamp & 0xffffffffffffn).toString(16).padStart(12, '0')
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(14)), b => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'[b % 62]).join('')
  return `msg_${prefix}${suffix}`
}

/** Mutable per-observation bookkeeping, local to one observeLoop() call. */
interface LoopState {
  readonly sessionId: string
  readonly directory: string | undefined
  readonly promptId: string
  readonly taskId: string
  readonly identity: boolean
  readonly watchdog: TurnWatchdog | undefined
  readonly permissions: Set<string>
  readonly foreign: Set<string>
  promptSeen: boolean
  pollFailures: number
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly kind: AgentKind = 'opencode'
  private paths: OpenCodeApiPaths
  /** sessionId -> project workdir, needed because OpenCode scopes /event and /session/status by directory. */
  private directories = new Map<string, string>()
  private permissionDirectories = new Map<string, string>()

  constructor(
    private config: OpenCodeAdapterConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.paths = { ...DEFAULT_OPENCODE_PATHS, ...config.paths }
  }

  private url(path: string, query?: Record<string, string | undefined>): string {
    const u = new URL(path, this.config.baseUrl)
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, v)
    return u.toString()
  }

  private authHeaders(): Record<string, string> {
    if (!this.config.passwordEnv) return {}
    const password = process.env[this.config.passwordEnv]
    return password ? { Authorization: `Bearer ${password}` } : {}
  }

  private async requestJson(path: string, init: RequestInit = {}, query?: Record<string, string | undefined>): Promise<any> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutSeconds * 1000)
    const cancel = () => controller.abort()
    if (init.signal?.aborted) cancel()
    init.signal?.addEventListener('abort', cancel, { once: true })
    try {
      const res = await this.fetchImpl(this.url(path, query), {
        ...init,
        signal: controller.signal,
        headers: { ...this.authHeaders(), ...(init.headers ?? {}) },
      })
      if (!res.ok) throw new OpenCodeError(`OpenCode ${init.method ?? 'GET'} ${path} -> HTTP ${res.status}`, res.status, path)
      const text = await res.text()
      return text ? JSON.parse(text) : {}
    } finally {
      clearTimeout(timer)
      init.signal?.removeEventListener('abort', cancel)
    }
  }

  async health(_target: AgentTarget): Promise<HealthStatus> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutSeconds * 1000)
      try {
        const res = await this.fetchImpl(this.url(this.paths.health), { headers: this.authHeaders(), signal: controller.signal })
        return { healthy: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}`, checkedAt: new Date().toISOString() }
      } finally { clearTimeout(timer) }
    } catch (e) {
      return { healthy: false, detail: String(e), checkedAt: new Date().toISOString() }
    }
  }

  async createSession(ctx: ConversationContext): Promise<AgentSession> {
    return { sessionId: await this.createSessionIn(ctx.workdir), agent: 'opencode' }
  }

  /** Creates a new session scoped to `directory` (confirmed query param on POST /session in the live OpenAPI doc). */
  async createSessionIn(directory: string, signal?: AbortSignal): Promise<string> {
    const json = await this.requestJson(this.url(this.paths.createSession, { directory }), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal,
    })
    const sessionId = json.id
    if (!sessionId) throw new OpenCodeError(`createSession response had no id field: ${JSON.stringify(json)}`)
    this.directories.set(String(sessionId), directory)
    return String(sessionId)
  }

  async resumeSession(sessionId: string, directory?: string): Promise<AgentSession> {
    if (directory) this.directories.set(sessionId, directory)
    await this.requestJson(this.paths.session(sessionId), {}, { directory: this.directories.get(sessionId) })
    return { sessionId, agent: 'opencode' }
  }

  async *send(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent> {
    yield { type: 'task.started', taskId: task.taskId }

    const directory = task.directory ?? this.directories.get(task.sessionId)
    if (directory) this.directories.set(task.sessionId, directory)

    // prompt_async accepts our own user-message id. Every assistant message the
    // turn produces has parentID === this id, so finalization can pick out
    // exactly this turn's messages even when earlier turns share the session.
    const promptId = task.messageId ?? nextPromptId()
    const run = new AbortController()
    const stopTurn = () => { void this.abort(task.sessionId, task.taskId).catch(() => {}) }
    const onAbort = () => { run.abort(); stopTurn() }
    if (signal.aborted) { yield { type: 'task.aborted', taskId: task.taskId }; return }
    signal.addEventListener('abort', onAbort)
    // Armed before the POST so a hung prompt request is also bounded by the task deadline.
    const watchdog = this.newWatchdog(run, stopTurn)
    watchdog.start()
    try {
      const submitted = await this.submitPrompt(task.sessionId, directory, promptId, task.prompt, undefined, run.signal)
      if (submitted.kind === 'aborted') {
        yield signal.aborted ? { type: 'task.aborted', taskId: task.taskId } : this.timeoutEvent(task.taskId, false, watchdog.snapshot())
        return
      }
      if (submitted.kind === 'http_error') {
        yield { type: 'task.failed', taskId: task.taskId, reason: submitted.reason === 'rejected' ? 'backend_unavailable' : submitted.reason }
        return
      }
      // Lost acknowledgement is ambiguous: the server may have accepted the
      // prompt. Observe this exact message ID, never POST the prompt twice.
      if (submitted.kind === 'ambiguous') this.config.onWarn?.(`opencode: prompt acknowledgement unavailable; observing ${promptId}: ${submitted.detail}`)
      const opts = { watchdog: true, taskId: task.taskId, identity: false }
      for await (const event of this.observeLoop(task.sessionId, directory, promptId, signal, run, opts, watchdog)) {
        if (event.type !== 'prompt.accepted') yield event
      }
    } finally {
      watchdog.stop()
      signal.removeEventListener('abort', onAbort)
      run.abort()
    }
  }

  /**
   * The single prompt_async POST for `messageId`. Never retried here: an
   * `ambiguous` result must be resolved by observing the message ID.
   */
  async submitPrompt(
    sessionId: string, directory: string | undefined, messageId: string, text: string,
    model: OpenCodeModel | undefined, signal: AbortSignal,
  ): Promise<SubmitPromptResult> {
    const body = {
      messageID: messageId,
      ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
      parts: [{ type: 'text', text }],
    }
    try {
      await this.requestJson(this.paths.promptAsync(sessionId), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
      }, { directory })
      return { kind: 'accepted' }
    } catch (error) {
      if (signal.aborted) return { kind: 'aborted' }
      if (!(error instanceof OpenCodeError)) return { kind: 'ambiguous', detail: String(error) }
      const status = error.status ?? 0
      const reason = isMissingOpenCodeSession(error) && await this.sessionMissing(sessionId, signal, directory) ? 'session_missing'
        : status === 429 ? 'rate_limited' : status === 503 ? 'capacity_exhausted' : 'rejected'
      return { kind: 'http_error', status, reason, detail: error.message }
    }
  }

  /**
   * Observes the turn started by `messageId` to its end: SSE (progress,
   * permissions) + `/permission` + `/session/status` polling + message-list
   * finalization. A caller abort only stops observing — it never aborts the
   * session (send() does that itself); only the chat watchdog does.
   */
  async *observeTurn(
    sessionId: string, directory: string | undefined, messageId: string, signal: AbortSignal, opts: ObserveTurnOptions,
  ): AsyncGenerator<TurnEvent> {
    const taskId = opts.taskId ?? messageId
    if (signal.aborted) { yield { type: 'task.aborted', taskId }; return }
    const run = new AbortController()
    const onAbort = () => run.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const watchdog = opts.watchdog
      ? this.newWatchdog(run, () => { void this.abortSession(sessionId, directory).catch(() => {}) })
      : undefined
    watchdog?.start()
    try {
      yield* this.observeLoop(sessionId, directory, messageId, signal, run, opts, watchdog)
    } finally {
      watchdog?.stop()
      signal.removeEventListener('abort', onAbort)
      run.abort()
    }
  }

  private newWatchdog(run: AbortController, onExpire: () => void): TurnWatchdog {
    const idleTimeoutMs = this.config.taskTimeoutSeconds * 1000
    const hardCapMs = (this.config.taskHardCapSeconds ?? DEFAULT_TASK_HARD_CAP_SECONDS) * 1000
    return new TurnWatchdog(idleTimeoutMs, hardCapMs, run, onExpire)
  }

  private async *observeLoop(
    sessionId: string, directory: string | undefined, promptId: string, signal: AbortSignal,
    run: AbortController, opts: ObserveTurnOptions, watchdog: TurnWatchdog | undefined,
  ): AsyncGenerator<TurnEvent> {
    const st: LoopState = {
      sessionId, directory, promptId, taskId: opts.taskId ?? promptId, identity: !!opts.identity, watchdog,
      permissions: new Set(), foreign: new Set(), promptSeen: false, pollFailures: 0,
    }
    const pollInterval = this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    let sseConnected = false
    const sse = new AbortController()
    const stopSse = () => sse.abort()
    run.signal.addEventListener('abort', stopSse, { once: true })
    const events = this.openEventStream(sessionId, sse.signal, () => { sseConnected = true }, directory)
    // Exactly one read remains pending across poll ticks. Racing a new next()
    // each tick queues reads in the generator and silently consumes events.
    let pendingEvent: Promise<IteratorResult<RawOpenCodeEvent>> | undefined
    let exhausted = false
    let tickTimer: ReturnType<typeof setTimeout> | undefined
    let tick: Promise<'poll'> | undefined
    const cancellation = new Promise<'cancel'>(resolve => {
      if (run.signal.aborted) resolve('cancel')
      run.signal.addEventListener('abort', () => resolve('cancel'), { once: true })
    })
    try {
      while (!run.signal.aborted) {
        if (!exhausted && !pendingEvent) pendingEvent = events.next().catch(() => ({ done: true, value: undefined }))
        if (!tick) tick = new Promise(resolve => { tickTimer = setTimeout(() => resolve('poll'), pollInterval) })
        const result = await Promise.race([...(pendingEvent ? [pendingEvent] : []), tick, cancellation])
        if (result === 'cancel') break
        if (result !== 'poll') {
          pendingEvent = undefined
          if (result.done) { exhausted = true; continue }
          yield* this.fromSse(result.value, st)
          continue
        }
        tick = undefined
        yield* this.permissionPoll(st, run.signal)
        const terminal = yield* this.statusPoll(st, run.signal, opts.maxConsecutivePollFailures)
        if (terminal) return
      }
      yield signal.aborted || !watchdog
        ? { type: 'task.aborted', taskId: st.taskId }
        : this.timeoutEvent(st.taskId, sseConnected, watchdog.snapshot())
    } finally {
      clearTimeout(tickTimer)
      sse.abort()
      run.signal.removeEventListener('abort', stopSse)
      await events.return?.(undefined).catch(() => {})
      for (const id of st.permissions) this.permissionDirectories.delete(id)
    }
  }

  /** Turns one SSE event into loop output. Chat only forwards permissions; identity mode adds snapshots/tools/acceptance. */
  private *fromSse(raw: RawOpenCodeEvent, st: LoopState): Generator<TurnEvent> {
    const event = normalizeOpenCodeEvent(raw, st.taskId)
    // Liveness: any tool/text activity in this directory-scoped stream proves
    // the turn is still moving, so the no-progress timeout must not fire.
    // Session-wide idle/error events have no turn identity; the message list
    // plus idle status, not these potentially stale events, decides completion.
    if (event?.type === 'tool.started') st.watchdog?.markProgress(`工具 ${event.toolName}`)
    else if (event?.type === 'tool.completed') st.watchdog?.markProgress(`工具 ${event.toolName} 完成`)
    else if (event?.type === 'tool.failed') st.watchdog?.markProgress(`工具 ${event.toolName} 失败`)
    else if (event?.type === 'text.delta') st.watchdog?.markProgress('文本输出')
    const identified = st.identity ? normalizeTurnIdentityEvent(raw, st.promptId, st.taskId, st.foreign) : null
    if (identified?.type === 'prompt.accepted') {
      if (!st.promptSeen) { st.promptSeen = true; yield identified }
      return
    }
    if (identified && identified.type !== 'permission.requested') { yield identified; return }
    const permission = identified ?? event
    if (permission?.type === 'permission.requested') yield* this.newPermission(permission, st)
  }

  private *newPermission(event: Extract<TurnEvent, { type: 'permission.requested' }>, st: LoopState): Generator<TurnEvent> {
    if (st.permissions.has(event.requestId)) return
    st.watchdog?.markProgress(`授权请求：${event.toolName}`)
    st.permissions.add(event.requestId)
    if (st.directory) this.permissionDirectories.set(event.requestId, st.directory)
    yield event
  }

  /** Permission polling also recovers requests missed before SSE connected or during a dropped stream. */
  private async *permissionPoll(st: LoopState, signal: AbortSignal): AsyncGenerator<TurnEvent> {
    let pending: unknown
    try {
      pending = await this.requestJson('/permission', { signal }, { directory: st.directory })
    } catch { return /* supplementary endpoint (older servers lack it); status/message polling remains authoritative */ }
    for (const raw of Array.isArray(pending) ? pending : []) {
      if (raw?.sessionID !== st.sessionId || st.permissions.has(raw.id)) continue
      const asRaw = { type: 'permission.asked', properties: raw }
      const event = st.identity ? normalizeTurnIdentityEvent(asRaw, st.promptId, st.taskId, st.foreign) : normalizeOpenCodeEvent(asRaw, st.taskId)
      if (event?.type === 'permission.requested') yield* this.newPermission(event, st)
    }
  }

  /** One status/message poll. Returns true once a terminal event has been yielded. */
  private async *statusPoll(st: LoopState, signal: AbortSignal, maxFailures: number | undefined): AsyncGenerator<TurnEvent, boolean> {
    try {
      const status = await this.requestJson(STATUS_PATH, { signal }, { directory: st.directory }) as StatusMap
      const busy = isSessionBusy(status, st.sessionId)
      // Chat only reads messages once idle; identity mode also looks for its own prompt message while busy.
      if (busy && !(st.identity && !st.promptSeen)) { st.pollFailures = 0; return false }
      const messages = await this.fetchMessagesForPoll(st, signal)
      if (!messages) return yield* this.pollFailed(st, maxFailures, 'message list unavailable')
      st.pollFailures = 0
      if (st.identity && !st.promptSeen && hasPromptMessage(messages, st.promptId)) {
        st.promptSeen = true
        yield { type: 'prompt.accepted', taskId: st.taskId, messageId: st.promptId }
      }
      if (busy) return false
      const finalized = finalizeTurn(messages, st.promptId, st.taskId, st.identity)
      if (!finalized || signal.aborted) return false
      yield* finalized
      return true
    } catch (error) {
      if (isMissingOpenCodeSession(error) && error instanceof OpenCodeError && error.path === this.paths.messages(st.sessionId) && await this.sessionMissing(st.sessionId, signal, st.directory)) {
        yield { type: 'task.failed', taskId: st.taskId, reason: 'session_missing' }
        return true
      }
      this.config.onWarn?.(`opencode adapter: polling ${st.sessionId} failed: ${error}`)
      return yield* this.pollFailed(st, maxFailures, String(error))
    }
  }

  private async *pollFailed(st: LoopState, maxFailures: number | undefined, detail: string): AsyncGenerator<TurnEvent, boolean> {
    st.pollFailures++
    if (!maxFailures || st.pollFailures < maxFailures) return false
    yield { type: 'task.failed', taskId: st.taskId, reason: 'observation_lost', detail }
    return true
  }

  /** Message list for a poll; null on a transient failure. A missing session is rethrown. */
  private async fetchMessagesForPoll(st: LoopState, signal: AbortSignal): Promise<RawMessage[] | null> {
    try {
      return await this.listMessages(st.sessionId, st.directory, signal)
    } catch (e) {
      if (isMissingOpenCodeSession(e)) throw e
      this.config.onWarn?.(`opencode adapter: fetching messages for ${st.sessionId} failed: ${e}`)
      return null
    }
  }

  private async sessionMissing(sessionId: string, signal: AbortSignal, directory?: string): Promise<boolean> {
    try {
      await this.requestJson(this.paths.session(sessionId), { signal }, { directory })
      return false
    } catch (error) { return isMissingOpenCodeSession(error) }
  }

  private timeoutEvent(taskId: string, sseConnected: boolean, timeout: TimeoutSnapshot): AgentEvent {
    // Preserve the diagnostic distinguishing unavailable SSE; pending
    // permissions are additionally recovered through short /permission polls.
    // `detail` tells the user *why* the turn was reclaimed (no progress vs the
    // absolute ceiling) and what it was doing last, instead of a bare reason.
    return {
      type: 'task.failed',
      taskId,
      reason: sseConnected ? 'task_timeout' : 'task_timeout_no_event_stream',
      detail: describeTaskTimeout(timeout),
    }
  }

  private async *openEventStream(
    sessionId: string,
    signal: AbortSignal,
    onConnected: () => void,
    directory: string | undefined,
  ): AsyncGenerator<RawOpenCodeEvent> {
    let res: Response
    try {
      // /event is directory-scoped: without ?directory= it silently never
      // carries this project's session events (confirmed live).
      res = await this.fetchImpl(this.url(this.paths.events, { directory }), { headers: this.authHeaders(), signal })
    } catch { return }
    if (!res.ok || !res.body) return
    onConnected()
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const buf = new SSEBuffer()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        for (const raw of buf.push(decoder.decode(value, { stream: true }))) {
          const rawEvent = raw as RawOpenCodeEvent
          if (belongsToSession(rawEvent, sessionId)) yield rawEvent
        }
      }
    } catch {
      // reader aborted (turn finished/aborted) or connection dropped — the
      // status poll is the authoritative completion path in either case.
    } finally {
      reader.cancel().catch(() => {})
    }
  }

  /** GET /session/{id}/message. Throws OpenCodeError (404/410 = missing session) or a network error. */
  async listMessages(sessionId: string, directory: string | undefined, signal?: AbortSignal): Promise<RawMessage[]> {
    const messages = await this.requestJson(this.paths.messages(sessionId), { signal }, { directory })
    return Array.isArray(messages) ? messages as RawMessage[] : []
  }

  /** GET /session/status for `directory`: sessionId -> status; sessions absent from the map are idle. */
  async sessionStatus(directory: string | undefined, signal?: AbortSignal): Promise<StatusMap> {
    const status = await this.requestJson(STATUS_PATH, { signal }, { directory })
    return status && typeof status === 'object' ? status as StatusMap : {}
  }

  /** Where is the turn started by `messageId`? Read-only; never sends input. */
  async locateTurn(sessionId: string, directory: string | undefined, messageId: string, signal?: AbortSignal): Promise<TurnLocation> {
    try {
      await this.requestJson(this.paths.session(sessionId), { signal }, { directory })
      const messages = await this.listMessages(sessionId, directory, signal)
      const status = await this.sessionStatus(directory, signal)
      return classifyTurn(messages, messageId, isSessionBusy(status, sessionId))
    } catch (error) {
      return isMissingOpenCodeSession(error) ? 'missing' : 'unreachable'
    }
  }

  async abort(sessionId: string, _taskId: string): Promise<void> {
    await this.abortSession(sessionId, this.directories.get(sessionId))
  }

  /** POST /session/{id}/abort for exactly this session. */
  async abortSession(sessionId: string, directory: string | undefined): Promise<void> {
    await this.requestJson(this.paths.abort(sessionId), { method: 'POST' }, { directory })
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    await this.replyPermission(requestId, decision.behavior === 'allow' ? 'once' : 'reject', this.permissionDirectories.get(requestId))
  }

  /** POST /permission/{id}/reply. Throws on a non-2xx response or a network error. */
  async replyPermission(requestId: string, reply: 'once' | 'reject', directory: string | undefined): Promise<void> {
    await this.requestJson(this.paths.respondPermission(requestId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reply }),
    }, { directory })
  }

  async getFinalMessage(sessionId: string, taskId: string): Promise<FinalMessage> {
    const messages = await this.requestJson(this.paths.messages(sessionId), {}, { directory: this.directories.get(sessionId) }) as Array<{ info?: { role?: string }; parts?: RawPart[] }>
    const lastAssistant = [...(Array.isArray(messages) ? messages : [])].reverse().find(m => m.info?.role === 'assistant')
    const text = (lastAssistant?.parts ?? []).filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text as string).join('')
    return { taskId, text }
  }

  async getDiff(sessionId: string, taskId?: string): Promise<FileDiff[]> {
    const raw = await this.requestJson(this.url(this.paths.diff(sessionId), { messageID: taskId, directory: this.directories.get(sessionId) })) as Array<{ file?: string; patch?: string }>
    return (Array.isArray(raw) ? raw : []).map(d => ({ path: String(d.file ?? ''), diff: String(d.patch ?? '') }))
  }
}
