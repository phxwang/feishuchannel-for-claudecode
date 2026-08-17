/**
 * OpenCode Adapter — talks to a local `opencode serve` over HTTP + SSE.
 *
 * See adapters/opencode/normalize.ts for the important caveat: endpoint
 * paths and event field names here are a best-effort mapping, NOT verified
 * against a live OpenCode server in this environment. `apiPaths` is
 * deliberately overridable so this can be pointed at whatever a real
 * instance actually exposes without touching the adapter logic itself.
 *
 * Not wired into router.ts yet — see docs/multi-agent-router-design.md's
 * implementation steps 4-5. Contract-tested here against a local mock
 * server (adapters/opencode/opencode-adapter.test.ts) that implements
 * exactly the paths below, which validates this client's request/response
 * and SSE-parsing logic but is NOT proof of real OpenCode compatibility.
 */
import type {
  AgentAdapter, AgentEvent, AgentSession, AgentTarget, AgentTask,
  ConversationContext, FileDiff, FinalMessage, HealthStatus, PermissionDecision,
} from '../agent-adapter'
import type { AgentKind } from '../../routing/types'
import { SSEBuffer } from './sse'
import { belongsToSession, normalizeOpenCodeEvent } from './normalize'

export class OpenCodeError extends Error {}

export interface OpenCodeApiPaths {
  health: string
  createSession: string
  session: (id: string) => string
  sendMessage: (id: string) => string
  abort: (id: string) => string
  events: string
  respondPermission: (sessionId: string, requestId: string) => string
}

export const DEFAULT_OPENCODE_PATHS: OpenCodeApiPaths = {
  health: '/doc',
  createSession: '/session',
  session: (id) => `/session/${id}`,
  sendMessage: (id) => `/session/${id}/message`,
  abort: (id) => `/session/${id}/abort`,
  events: '/event',
  respondPermission: (sessionId, requestId) => `/session/${sessionId}/permissions/${requestId}`,
}

export interface OpenCodeAdapterConfig {
  baseUrl: string
  requestTimeoutSeconds: number
  taskTimeoutSeconds: number
  passwordEnv?: string
  paths?: Partial<OpenCodeApiPaths>
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly kind: AgentKind = 'opencode'
  private paths: OpenCodeApiPaths

  constructor(
    private config: OpenCodeAdapterConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.paths = { ...DEFAULT_OPENCODE_PATHS, ...config.paths }
  }

  private url(path: string): string {
    return new URL(path, this.config.baseUrl).toString()
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
        return { healthy: res.ok, detail: res.ok ? undefined: `HTTP ${res.status}`, checkedAt: new Date().toISOString() }
      } finally { clearTimeout(timer) }
    } catch (e) {
      return { healthy: false, detail: String(e), checkedAt: new Date().toISOString() }
    }
  }

  async createSession(_ctx: ConversationContext): Promise<AgentSession> {
    const json = await this.requestJson(this.paths.createSession, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const sessionId = json.id ?? json.sessionID ?? json.session_id
    if (!sessionId) throw new OpenCodeError(`createSession response had no id field: ${JSON.stringify(json)}`)
    return { sessionId: String(sessionId), agent: 'opencode' }
  }

  async resumeSession(sessionId: string): Promise<AgentSession> {
    await this.requestJson(this.paths.session(sessionId))
    return { sessionId, agent: 'opencode' }
  }

  async *send(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent> {
    yield { type: 'task.started', taskId: task.taskId }

    let sendRes: Response
    try {
      const controller = new AbortController()
      const onAbort = () => controller.abort()
      signal.addEventListener('abort', onAbort)
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutSeconds * 1000)
      try {
        sendRes = await this.fetchImpl(this.url(this.paths.sendMessage(task.sessionId)), {
          method: 'POST',
          headers: { ...this.authHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ parts: [{ type: 'text', text: task.prompt }] }),
          signal: controller.signal,
        })
      } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
    } catch (e) {
      yield { type: 'task.failed', taskId: task.taskId, reason: signal.aborted ? 'startup_timeout' : 'backend_unavailable' }
      return
    }

    if (!sendRes.ok) {
      const reason = sendRes.status === 429 ? 'rate_limited' : sendRes.status === 503 ? 'capacity_exhausted' : 'backend_unavailable'
      yield { type: 'task.failed', taskId: task.taskId, reason }
      return
    }

    yield* this.streamEvents(task, signal)
  }

  private async *streamEvents(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort)
    const deadline = setTimeout(() => controller.abort(), this.config.taskTimeoutSeconds * 1000)

    try {
      const res = await this.fetchImpl(this.url(this.paths.events), { headers: this.authHeaders(), signal: controller.signal })
      if (!res.ok || !res.body) {
        yield { type: 'task.failed', taskId: task.taskId, reason: 'backend_unavailable' }
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const buf = new SSEBuffer()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const raw of buf.push(decoder.decode(value, { stream: true }))) {
          const rawEvent = raw as { type?: string; properties?: Record<string, unknown> }
          if (!belongsToSession(rawEvent, task.sessionId)) continue
          const normalized = normalizeOpenCodeEvent(rawEvent, task.taskId)
          if (!normalized) continue
          yield normalized
          if (normalized.type === 'session.idle' || normalized.type === 'task.failed' || normalized.type === 'task.aborted') {
            reader.cancel().catch(() => {})
            return
          }
        }
      }
    } catch {
      yield { type: 'task.aborted', taskId: task.taskId }
    } finally {
      clearTimeout(deadline)
      signal.removeEventListener('abort', onAbort)
    }
  }

  async abort(sessionId: string, _taskId: string): Promise<void> {
    await this.requestJson(this.paths.abort(sessionId), { method: 'POST' })
  }

  async respondPermission(requestId: string, decision: PermissionDecision, sessionId?: string): Promise<void> {
    if (!sessionId) throw new OpenCodeError('OpenCode respondPermission requires the sessionId (design doc: adapters normalize their own correlation)')
    await this.requestJson(this.paths.respondPermission(sessionId, requestId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response: decision.behavior }),
    })
  }

  async getFinalMessage(sessionId: string, taskId: string): Promise<FinalMessage> {
    const json = await this.requestJson(this.paths.session(sessionId))
    return { taskId, text: String(json.lastMessage ?? json.text ?? '') }
  }

  async getDiff(_sessionId: string, _taskId?: string): Promise<FileDiff[]> {
    // Not yet backed by a real endpoint — no OpenCode diff API confirmed. Fail
    // closed rather than return an empty array that would look like "no changes".
    throw new OpenCodeError('getDiff is not implemented — OpenCode diff endpoint not yet confirmed')
  }
}
