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
 * Wired into router.ts. Contract-tested here against a local mock
 * server (opencode-adapter.test.ts) built to match the verified shapes.
 */
import type {
  AgentAdapter, AgentEvent, AgentSession, AgentTarget, AgentTask,
  ConversationContext, FileDiff, FinalMessage, HealthStatus, PermissionDecision,
} from '../agent-adapter'
import type { AgentKind } from '../../routing/types'
import { SSEBuffer } from './sse'
import { belongsToSession, errorMessage, normalizeOpenCodeEvent } from './normalize'

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
  taskTimeoutSeconds: number
  passwordEnv?: string
  paths?: Partial<OpenCodeApiPaths>
  /** How often to poll `/session/status` while a turn runs (ms). Defaults to 1000. */
  pollIntervalMs?: number
  /** Called with a message when something recoverable goes wrong internally (e.g. the
   *  supplementary message-list fetch fails) — the adapter itself
   *  has no logger, so wire this to the caller's own (router.ts's `dbg`, in practice). */
  onWarn?: (msg: string) => void
}

type RawAttachment = { type?: string; mime?: string; url?: string; filename?: string }
type RawPart = { type?: string; text?: string; tool?: string; state?: { status?: string; error?: string; attachments?: RawAttachment[] } }
type RawEvent = { type?: string; properties?: Record<string, unknown> }
type RawMessage = {
  info?: { id?: string; role?: string; parentID?: string; time?: { created?: number; completed?: number }; error?: unknown; finish?: string }
  parts?: RawPart[]
}
type SessionStatus = { type?: string }

const DEFAULT_POLL_INTERVAL_MS = 1000
const STATUS_PATH = '/session/status'

// Match OpenCode v1.18.15's ascending message identifier: a six-byte
// timestamp/counter prefix plus 14 random base62 characters. Arbitrary UUIDs
// can sort before historical turns in OpenCode's message history.
let promptTimestamp = 0
let promptCounter = 0
function nextPromptId(): string {
  const now = Date.now()
  if (now !== promptTimestamp) { promptTimestamp = now; promptCounter = 0 }
  const timestamp = BigInt(now) * 0x1000n + BigInt(++promptCounter)
  const prefix = (timestamp & 0xffffffffffffn).toString(16).padStart(12, '0')
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(14)), b => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'[b % 62]).join('')
  return `msg_${prefix}${suffix}`
}

// Never infer turn identity from wall-clock time: concurrent/stale turns can
// share timestamps. OpenCode honors the caller-provided user message ID.
function selectTurnMessages(messages: RawMessage[], promptId: string): RawMessage[] {
  return messages.filter(m => m.info?.role === 'assistant' && m.info.parentID === promptId)
    .sort((a, b) => (a.info?.time?.created ?? 0) - (b.info?.time?.created ?? 0))
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
    // `directory` scopes the session to the right project workdir (confirmed
    // query param on POST /session in the live OpenAPI doc).
    const json = await this.requestJson(this.url(this.paths.createSession, { directory: ctx.workdir }), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    const sessionId = json.id
    if (!sessionId) throw new OpenCodeError(`createSession response had no id field: ${JSON.stringify(json)}`)
    this.directories.set(String(sessionId), ctx.workdir)
    return { sessionId: String(sessionId), agent: 'opencode' }
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
    const promptId = nextPromptId()
    const run = new AbortController()
    const stopTurn = () => { void this.abort(task.sessionId, task.taskId).catch(() => {}) }
    const onAbort = () => { run.abort(); stopTurn() }
    if (signal.aborted) { yield { type: 'task.aborted', taskId: task.taskId }; return }
    signal.addEventListener('abort', onAbort)
    const deadline = setTimeout(() => { run.abort(); stopTurn() }, this.config.taskTimeoutSeconds * 1000)
    const pollInterval = this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    let sseConnected = false
    const events = this.openEventStream(task, run.signal, () => { sseConnected = true }, directory)
    // Exactly one read remains pending across poll ticks. Racing a new next()
    // each tick queues reads in the generator and silently consumes events.
    let pendingEvent: Promise<IteratorResult<AgentEvent>> | undefined
    let exhausted = false
    const permissions = new Set<string>()
    let tickTimer: ReturnType<typeof setTimeout> | undefined
    let tick: Promise<'poll'> | undefined
    const cancellation = new Promise<'cancel'>(resolve => {
      run.signal.addEventListener('abort', () => resolve('cancel'), { once: true })
    })
    try {
      try {
        await this.requestJson(this.paths.promptAsync(task.sessionId), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageID: promptId, parts: [{ type: 'text', text: task.prompt }] }),
          signal: run.signal,
        }, { directory })
      } catch (error) {
        if (run.signal.aborted) {
          yield signal.aborted ? { type: 'task.aborted', taskId: task.taskId } : this.timeoutEvent(task, sseConnected)
          return
        }
        if (error instanceof OpenCodeError) {
          const reason = isMissingOpenCodeSession(error) && await this.sessionMissing(task.sessionId, run.signal, directory) ? 'session_missing'
            : error.status === 429 ? 'rate_limited' : error.status === 503 ? 'capacity_exhausted' : 'backend_unavailable'
          yield { type: 'task.failed', taskId: task.taskId, reason }; return
        }
        // Lost acknowledgement is ambiguous: the server may have accepted the
        // prompt. Observe this exact message ID, never POST the prompt twice.
        this.config.onWarn?.(`opencode: prompt acknowledgement unavailable; observing ${promptId}: ${error}`)
      }
      while (!run.signal.aborted) {
        if (!exhausted && !pendingEvent) pendingEvent = events.next().catch(() => ({ done: true, value: undefined }))
        if (!tick) tick = new Promise(resolve => { tickTimer = setTimeout(() => resolve('poll'), pollInterval) })
        const result = await Promise.race([
          ...(pendingEvent ? [pendingEvent] : []), tick, cancellation,
        ])
        if (result === 'cancel') break
        if (result !== 'poll') {
          pendingEvent = undefined
          if (result.done) { exhausted = true; continue }
          const event = result.value
          // Session-wide idle/error events have no turn identity. The message
          // list plus idle status, not these potentially stale events, decides completion.
          if (event.type === 'permission.requested' && !permissions.has(event.requestId)) {
            permissions.add(event.requestId)
            if (directory) this.permissionDirectories.set(event.requestId, directory)
            yield event
          }
          continue
        }
        tick = undefined
        // Permission polling also recovers requests missed before SSE connected
        // or during a dropped stream. Older servers may not offer /permission.
        try {
          const pending = await this.requestJson('/permission', { signal: run.signal }, { directory })
          for (const raw of Array.isArray(pending) ? pending : []) {
            if (raw.sessionID !== task.sessionId || permissions.has(raw.id)) continue
            const event = normalizeOpenCodeEvent({ type: 'permission.asked', properties: raw }, task.taskId)
            if (event?.type !== 'permission.requested') continue
            permissions.add(event.requestId)
            if (directory) this.permissionDirectories.set(event.requestId, directory)
            yield event
          }
        } catch { /* supplementary endpoint; status/message polling remains authoritative */ }
        try {
          const status = await this.requestJson(STATUS_PATH, { signal: run.signal }, { directory }) as Record<string, SessionStatus | undefined>
          if (!status?.[task.sessionId] || status[task.sessionId]?.type === 'idle') {
            const finalized = await this.finalizeFromMessages(task, directory, promptId, run.signal)
            if (finalized && !run.signal.aborted) { yield* finalized; return }
          }
        } catch (error) {
          if (isMissingOpenCodeSession(error) && error instanceof OpenCodeError && error.path === this.paths.messages(task.sessionId) && await this.sessionMissing(task.sessionId, run.signal, directory)) {
            yield { type: 'task.failed', taskId: task.taskId, reason: 'session_missing' }; return
          }
          this.config.onWarn?.(`opencode adapter: polling ${task.sessionId} failed: ${error}`)
        }
      }
      yield signal.aborted ? { type: 'task.aborted', taskId: task.taskId } : this.timeoutEvent(task, sseConnected)
    } finally {
      clearTimeout(deadline)
      clearTimeout(tickTimer)
      signal.removeEventListener('abort', onAbort)
      run.abort()
      await events.return?.(undefined).catch(() => {})
      for (const id of permissions) this.permissionDirectories.delete(id)
    }
  }

  private async sessionMissing(sessionId: string, signal: AbortSignal, directory?: string): Promise<boolean> {
    try {
      await this.requestJson(this.paths.session(sessionId), { signal }, { directory })
      return false
    } catch (error) { return isMissingOpenCodeSession(error) }
  }

  private timeoutEvent(task: AgentTask, sseConnected: boolean): AgentEvent {
    // Preserve the diagnostic distinguishing unavailable SSE; pending
    // permissions are additionally recovered through short /permission polls.
    return { type: 'task.failed', taskId: task.taskId, reason: sseConnected ? 'task_timeout' : 'task_timeout_no_event_stream' }
  }

  /**
   * Once the session is idle, the whole turn's result lives in the message
   * list — a multi-step turn creates several assistant messages sharing one
   * `parentID` (the user message id we supplied), and each carries its own
   * tool parts/attachments. Merging them is what makes earlier steps (e.g. a
   * screenshot taken before the final text summary) visible; the final text
   * specifically comes from the LAST assistant message so the user sees the
   * summary rather than intermediate reasoning.
   *
   * Returns null when the turn's messages aren't available yet (caller keeps
   * polling), and a task.failed event if the turn ended in an error.
   */
  private async finalizeFromMessages(
    task: AgentTask,
    directory: string | undefined,
    promptId: string,
    signal: AbortSignal,
  ): Promise<AgentEvent[] | null> {
    let messages: RawMessage[]
    try {
      messages = await this.requestJson(this.paths.messages(task.sessionId), { signal }, { directory }) as RawMessage[]
    } catch (e) {
      if (isMissingOpenCodeSession(e)) throw e
      this.config.onWarn?.(`opencode adapter: fetching messages for ${task.sessionId} failed: ${e}`)
      return null
    }
    const turn = selectTurnMessages(Array.isArray(messages) ? messages : [], promptId)
    if (!turn.length) return null

    const lastMessage = turn[turn.length - 1]
    const errored = turn.map(m => m.info?.error).find(Boolean)
    if (!errored && (typeof lastMessage.info?.time?.completed !== 'number' || lastMessage.info.finish === 'tool-calls')) return null
    const out: AgentEvent[] = []

    for (const part of turn.flatMap(m => m.parts ?? [])) {
      if (part?.type !== 'tool') continue
      const toolName = String(part.tool ?? 'unknown')
      const completed = part.state?.status === 'completed'
      if (completed) out.push({ type: 'tool.completed', taskId: task.taskId, toolName })
      else if (part.state?.status === 'error') out.push({ type: 'tool.failed', taskId: task.taskId, toolName, error: String(part.state.error ?? 'tool failed') })
      if (!completed) continue // a failed tool's attachments (if any) may be partial/garbage — don't forward them
      // Tools that produce a file (e.g. a browser screenshot MCP tool) attach it
      // as a `data:` URI on the tool's own state — confirmed against a real
      // opencode serve response; there's no separate top-level `file` message
      // part the way the OpenAPI FilePart schema might suggest.
      for (const att of part.state?.attachments ?? []) {
        if (att?.type === 'file' && typeof att.mime === 'string' && typeof att.url === 'string' && att.url.startsWith('data:')) {
          out.push({ type: 'attachment.completed', taskId: task.taskId, mime: att.mime, dataUrl: att.url, filename: att.filename })
        }
      }
    }

    // Already completed tool artifacts remain useful even if a later model
    // step failed; let the router flush them before reporting the error.
    if (errored) return [...out, { type: 'task.failed', taskId: task.taskId, reason: errorMessage(errored) }]
    const last = turn[turn.length - 1]
    const text = (last.parts ?? []).filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text as string).join('')
    if (text) out.push({ type: 'text.completed', taskId: task.taskId, text })
    out.push({ type: 'session.idle', taskId: task.taskId })
    return out
  }

  private async *openEventStream(
    task: AgentTask,
    signal: AbortSignal,
    onConnected: () => void,
    directory: string | undefined,
  ): AsyncGenerator<AgentEvent> {
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
          const rawEvent = raw as RawEvent
          if (!belongsToSession(rawEvent, task.sessionId)) continue
          const normalized = normalizeOpenCodeEvent(rawEvent, task.taskId)
          if (normalized) yield normalized
        }
      }
    } catch {
      // reader aborted (task finished/aborted) or connection dropped — send()'s
      // status poll is the authoritative completion path in either case.
    } finally {
      reader.cancel().catch(() => {})
    }
  }

  async abort(sessionId: string, _taskId: string): Promise<void> {
    await this.requestJson(this.paths.abort(sessionId), { method: 'POST' }, { directory: this.directories.get(sessionId) })
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    await this.requestJson(this.paths.respondPermission(requestId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reply: decision.behavior === 'allow' ? 'once' : 'reject' }),
    }, { directory: this.permissionDirectories.get(requestId) })
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
