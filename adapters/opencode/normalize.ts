/**
 * Normalizes a raw OpenCode SSE event into the shared AgentEvent shape.
 *
 * Verified against a real `opencode serve` (v1.18.15) running locally: its
 * OpenAPI doc (`GET /doc`) and a live captured event stream from an actual
 * prompt both confirm the shapes used below — `{id, type, properties}`
 * envelopes, `session.idle`/`session.error` with `properties.sessionID`,
 * `message.part.updated` with `properties.part` (TextPart/ToolPart), and
 * ToolState's `status` enum (pending/running/completed/error). See
 * docs/multi-agent-router-design.md for how this fits into the Adapter
 * layer. Two things intentionally NOT modeled here, both confirmed absent
 * from the real API:
 *   - AssistantMessage (`message.updated`) never carries the full response
 *     text or a `finished` boolean — text only exists in TextPart deltas
 *     from message.part.updated. There is no reliable "text.completed with
 *     full text" source from events alone; callers should treat
 *     session.idle as task completion and concatenate the text.delta
 *     events they've already seen if they need the full text.
 *   - `message.part.delta` (an actual incremental-delta event distinct
 *     from message.part.updated's snapshot-style updates) was observed
 *     once in a live capture but isn't in the OpenAPI schema list checked
 *     here — left unhandled (falls through to null) until confirmed.
 * Still unrecognized/future event types are dropped (return null) rather
 * than guessed at, so a schema drift fails silently-safe instead of
 * crashing the router.
 */
import type { AgentEvent } from '../agent-adapter'

export interface RawOpenCodeEvent {
  type?: string
  properties?: Record<string, unknown>
}

export function belongsToSession(raw: RawOpenCodeEvent, sessionId: string): boolean {
  const p = raw.properties ?? {}
  const candidates = [p.sessionID, p.sessionId, p.session_id]
  return candidates.some(c => c === sessionId)
}

/** OpenCode error union (APIError/UnknownError/ProviderAuthError/...) is always `{name, data:{message,...}}`. */
export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const data = (err as any).data
    if (data && typeof data.message === 'string') return data.message
    if (typeof (err as any).name === 'string') return (err as any).name
  }
  return 'unknown'
}

export function normalizeOpenCodeEvent(raw: RawOpenCodeEvent, taskId: string): AgentEvent | null {
  const type = raw.type ?? ''
  const p = raw.properties ?? {}

  if (type === 'session.idle') return { type: 'session.idle', taskId }
  if (type === 'session.error') return { type: 'task.failed', taskId, reason: errorMessage(p.error) }

  if (type === 'message.part.updated') {
    const part = (p.part ?? {}) as Record<string, unknown>
    if (part.type === 'text' && typeof part.text === 'string') {
      return { type: 'text.delta', taskId, text: part.text }
    }
    if (part.type === 'tool') {
      const toolName = String(part.tool ?? 'unknown')
      const state = part.state as Record<string, unknown> | undefined
      const status = state?.status
      if (status === 'running' || status === 'pending') return { type: 'tool.started', taskId, toolName }
      if (status === 'completed') return { type: 'tool.completed', taskId, toolName }
      if (status === 'error') return { type: 'tool.failed', taskId, toolName, error: String(state?.error ?? 'tool failed') }
    }
    return null
  }

  // permission.asked (confirmed live event name — NOT "permission.updated").
  // Real payload has no title/description field; `permission` is the closest
  // thing to a human-readable label OpenCode provides at this layer.
  if (type === 'permission.asked') {
    const permission = String(p.permission ?? 'unknown')
    return {
      type: 'permission.requested',
      taskId,
      requestId: String(p.id ?? ''),
      toolName: permission,
      description: permission,
    }
  }

  return null
}
