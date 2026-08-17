/**
 * Normalizes a raw OpenCode SSE event into the shared AgentEvent shape.
 *
 * CAVEAT (be honest about this): the exact field names below (`type`,
 * `properties`, `sessionID`, part `type`/`state`) are a best-effort mapping
 * based on OpenCode's publicly documented event-bus shape at the time this
 * was written, NOT verified against a live `opencode serve` instance in
 * this environment. Before enabling any route with `primary: opencode` in
 * production, run this adapter against a real OpenCode server and adjust
 * this mapping (and adapters/opencode/opencode-adapter.ts's endpoint paths)
 * to match what it actually emits. Unrecognized event shapes are dropped
 * (return null) rather than guessed at, so a mismatch fails silently-safe
 * (task just looks idle) instead of crashing the router.
 */
import type { AgentEvent } from '../agent-adapter'

export interface RawOpenCodeEvent {
  type?: string
  properties?: Record<string, unknown>
}

export function belongsToSession(raw: RawOpenCodeEvent, sessionId: string): boolean {
  const p = raw.properties ?? {}
  const candidates = [p.sessionID, p.sessionId, p.session_id, (p.info as any)?.sessionID]
  return candidates.some(c => c === sessionId)
}

export function normalizeOpenCodeEvent(raw: RawOpenCodeEvent, taskId: string): AgentEvent | null {
  const type = raw.type ?? ''
  const p = raw.properties ?? {}

  if (type === 'session.idle') return { type: 'session.idle', taskId }
  if (type === 'session.error') return { type: 'task.failed', taskId, reason: String(p.error ?? 'unknown') }

  if (type === 'message.part.updated') {
    const part = (p.part ?? {}) as Record<string, unknown>
    if (part.type === 'text' && typeof part.text === 'string') {
      return { type: 'text.delta', taskId, text: part.text }
    }
    if (part.type === 'tool') {
      const toolName = String(part.tool ?? 'unknown')
      const state = (part.state as Record<string, unknown> | undefined)?.status
      if (state === 'running' || state === 'pending') return { type: 'tool.started', taskId, toolName }
      if (state === 'completed') return { type: 'tool.completed', taskId, toolName }
      if (state === 'error') return { type: 'tool.failed', taskId, toolName, error: String((part.state as any)?.error ?? 'tool failed') }
    }
    return null
  }

  if (type === 'message.updated') {
    const info = (p.info ?? {}) as Record<string, unknown>
    if (info.role === 'assistant' && typeof info.text === 'string' && info.finished) {
      return { type: 'text.completed', taskId, text: info.text as string }
    }
    return null
  }

  if (type === 'permission.updated') {
    return {
      type: 'permission.requested',
      taskId,
      requestId: String(p.id ?? p.permissionID ?? ''),
      toolName: String(p.tool ?? p.title ?? 'unknown'),
      description: String(p.description ?? p.title ?? ''),
    }
  }

  return null
}
