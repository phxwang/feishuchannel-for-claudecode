/**
 * OpenCode Adapter — talks to a local `opencode serve` over HTTP + SSE.
 *
 * Endpoint paths and payload shapes below were verified against a real
 * `opencode serve` v1.18.15 running locally: its own OpenAPI doc (`GET
 * /doc`) plus a live-captured event stream from an actual prompt. Notably:
 *   - `POST /session/{id}/message` (session.prompt) is SYNCHRONOUS — it
 *     blocks until the assistant finishes and returns the full
 *     `{info, parts}` in the response body. That response is this
 *     adapter's authoritative source for the final text/tool results.
 *   - A permission request mid-task blocks that same POST until answered
 *     via `POST /permission/{requestID}/reply` (confirmed in the schema;
 *     the sessionID-scoped `/session/{id}/permissions/{id}` variant is
 *     marked `deprecated` in the live OpenAPI doc). Since the POST is
 *     blocked while this happens, `send()` watches the SSE stream
 *     concurrently — not sequentially after — so a permission.requested
 *     event can still reach the caller while the POST is in flight.
 * `apiPaths` stays overridable in case a different OpenCode version's
 * layout drifts from what was verified here.
 *
 * Not wired into router.ts yet — see docs/multi-agent-router-design.md's
 * implementation steps 4-5. Contract-tested here against a local mock
 * server (opencode-adapter.test.ts) built to match the verified shapes.
 */
import type {
  AgentAdapter, AgentEvent, AgentSession, AgentTarget, AgentTask,
  ConversationContext, FileDiff, FinalMessage, HealthStatus, PermissionDecision,
} from '../agent-adapter'
import type { AgentKind } from '../../routing/types'
import { SSEBuffer } from './sse'
import { belongsToSession, errorMessage, normalizeOpenCodeEvent } from './normalize'

export class OpenCodeError extends Error {}

export interface OpenCodeApiPaths {
  health: string
  createSession: string
  session: (id: string) => string
  sendMessage: (id: string) => string
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
  sendMessage: (id) => `/session/${id}/message`,
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
}

type RawPart = { type?: string; text?: string; tool?: string; state?: { status?: string; error?: string } }
type RawEvent = { type?: string; properties?: Record<string, unknown> }

export class OpenCodeAdapter implements AgentAdapter {
  readonly kind: AgentKind = 'opencode'
  private paths: OpenCodeApiPaths

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

  private async requestJson(path: string, init: RequestInit = {}): Promise<any> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutSeconds * 1000)
    try {
      const res = await this.fetchImpl(this.url(path), {
        ...init,
        signal: init.signal ?? controller.signal,
        headers: { ...this.authHeaders(), ...(init.headers ?? {}) },
      })
      if (!res.ok) throw new OpenCodeError(`OpenCode ${init.method ?? 'GET'} ${path} -> HTTP ${res.status}`)
      const text = await res.text()
      return text ? JSON.parse(text) : {}
    } finally {
      clearTimeout(timer)
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
    return { sessionId: String(sessionId), agent: 'opencode' }
  }

  async resumeSession(sessionId: string): Promise<AgentSession> {
    await this.requestJson(this.paths.session(sessionId))
    return { sessionId, agent: 'opencode' }
  }

  async *send(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent> {
    yield { type: 'task.started', taskId: task.taskId }

    const promptController = new AbortController()
    const onAbort = () => promptController.abort()
    signal.addEventListener('abort', onAbort)
    let timedOut = false
    const deadline = setTimeout(() => { timedOut = true; promptController.abort() }, this.config.taskTimeoutSeconds * 1000)

    const promptPromise = this.fetchImpl(this.url(this.paths.sendMessage(task.sessionId)), {
      method: 'POST',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: task.prompt }] }),
      signal: promptController.signal,
    }).then(res => ({ ok: true as const, res })).catch(err => ({ ok: false as const, err }))
    const sentTagged = promptPromise.then(r => ({ kind: 'sent' as const, r }))

    // Watch the event stream concurrently — a permission.asked mid-task blocks
    // the POST above until answered, so we can't just await it sequentially.
    // IMPORTANT: once the SSE generator is exhausted, calling .next() on it
    // again resolves immediately (not via real I/O), so racing it every loop
    // iteration after that point becomes a synchronous busy-loop that starves
    // the event loop and the POST's own I/O callback never gets to fire.
    // `eventsExhausted` switches the raced slot to a promise that never
    // resolves once that happens, so the loop only ever proceeds when
    // sentTagged (real I/O) settles.
    const sseStatus = { connected: false }
    const events = this.openEventStream(task, promptController.signal, sseStatus)
    let eventsExhausted = false
    const neverResolves = new Promise<never>(() => {})
    try {
      while (true) {
        const eventSlot: Promise<{ kind: 'event'; r: IteratorResult<AgentEvent> }> = eventsExhausted
          ? neverResolves
          : events.next().catch(() => ({ done: true as const, value: undefined as any })).then(r => ({ kind: 'event' as const, r }))
        const raced = await Promise.race([sentTagged, eventSlot])

        if (raced.kind === 'event') {
          if (raced.r.done) { eventsExhausted = true; continue }
          if (raced.r.value) yield raced.r.value
          continue
        }

        // The POST won the race. `events.return()` alone does NOT interrupt a
        // pending `reader.read()` — per the async-generator protocol, a
        // queued .return() only takes effect once that read next resolves on
        // its own, which for the real (long-lived, low-traffic) OpenCode
        // /event stream could be a long time or never within this task's
        // lifetime, hanging send() forever even though the real work is done.
        // Aborting the shared signal actually rejects the in-flight read (the
        // POST has already resolved by this point, so aborting its signal now
        // is a no-op for it) so openEventStream's catch/finally can unwind.
        promptController.abort()
        await events.return?.(undefined).catch(() => {})
        if (!raced.r.ok) {
          if (signal.aborted) {
            yield { type: 'task.aborted', taskId: task.taskId }
          } else if (timedOut) {
            // Distinguish "we watched for a permission.asked the whole time and
            // nothing came" from "we couldn't even watch" — the latter means any
            // mid-task permission request was unobservable and unanswerable from
            // here, which reads very differently in the logs/user-facing message.
            yield { type: 'task.failed', taskId: task.taskId, reason: sseStatus.connected ? 'task_timeout' : 'task_timeout_no_event_stream' }
          } else {
            const err = raced.r.err
            yield { type: 'task.failed', taskId: task.taskId, reason: `connection_failed: ${err instanceof Error ? err.message : String(err)}` }
          }
          return
        }
        yield* this.finalizeFromResponse(task, raced.r.res)
        return
      }
    } finally {
      clearTimeout(deadline)
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async *finalizeFromResponse(task: AgentTask, res: Response): AsyncGenerator<AgentEvent> {
    if (!res.ok) {
      const reason = res.status === 429 ? 'rate_limited' : res.status === 503 ? 'capacity_exhausted' : 'backend_unavailable'
      yield { type: 'task.failed', taskId: task.taskId, reason }
      return
    }
    let body: { info?: { error?: unknown }; parts?: RawPart[] }
    try { body = await res.json() } catch { yield { type: 'task.failed', taskId: task.taskId, reason: 'backend_unavailable' }; return }

    for (const part of body.parts ?? []) {
      if (part?.type !== 'tool') continue
      const toolName = String(part.tool ?? 'unknown')
      if (part.state?.status === 'completed') yield { type: 'tool.completed', taskId: task.taskId, toolName }
      else if (part.state?.status === 'error') yield { type: 'tool.failed', taskId: task.taskId, toolName, error: String(part.state.error ?? 'tool failed') }
    }

    if (body.info?.error) {
      yield { type: 'task.failed', taskId: task.taskId, reason: errorMessage(body.info.error) }
      return
    }

    const text = (body.parts ?? []).filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text as string).join('')
    if (text) yield { type: 'text.completed', taskId: task.taskId, text }
    yield { type: 'session.idle', taskId: task.taskId }
  }

  private async *openEventStream(task: AgentTask, signal: AbortSignal, status: { connected: boolean }): AsyncGenerator<AgentEvent> {
    let res: Response
    try {
      res = await this.fetchImpl(this.url(this.paths.events), { headers: this.authHeaders(), signal })
    } catch { return }
    if (!res.ok || !res.body) return
    status.connected = true
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
      // reader aborted (POST settled) or connection dropped — send() already
      // has the authoritative result from the POST response in either case.
    } finally {
      reader.cancel().catch(() => {})
    }
  }

  async abort(sessionId: string, _taskId: string): Promise<void> {
    await this.requestJson(this.paths.abort(sessionId), { method: 'POST' })
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    await this.requestJson(this.paths.respondPermission(requestId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reply: decision.behavior === 'allow' ? 'once' : 'reject' }),
    })
  }

  async getFinalMessage(sessionId: string, taskId: string): Promise<FinalMessage> {
    const messages = await this.requestJson(this.paths.messages(sessionId)) as Array<{ info?: { role?: string }; parts?: RawPart[] }>
    const lastAssistant = [...(Array.isArray(messages) ? messages : [])].reverse().find(m => m.info?.role === 'assistant')
    const text = (lastAssistant?.parts ?? []).filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text as string).join('')
    return { taskId, text }
  }

  async getDiff(sessionId: string, taskId?: string): Promise<FileDiff[]> {
    const raw = await this.requestJson(this.url(this.paths.diff(sessionId), { messageID: taskId })) as Array<{ file?: string; patch?: string }>
    return (Array.isArray(raw) ? raw : []).map(d => ({ path: String(d.file ?? ''), diff: String(d.patch ?? '') }))
  }
}
