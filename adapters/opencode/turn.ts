/**
 * Pure helpers over OpenCode's message list for one turn. A turn is identified
 * by the caller-provided user message ID: every assistant message the turn
 * produces has `parentID === messageId` (verified against opencode serve
 * v1.18.15). Turn identity is never inferred from wall-clock time.
 */
import type { AgentEvent, PartIdentity } from '../agent-adapter'
import { errorMessage } from './normalize'

export type RawAttachment = { type?: string; mime?: string; url?: string; filename?: string }
export type RawPart = {
  id?: string; messageID?: string; callID?: string
  type?: string; text?: string; tool?: string
  state?: { status?: string; error?: string; attachments?: RawAttachment[] }
}
export type RawMessage = {
  info?: { id?: string; role?: string; parentID?: string; time?: { created?: number; completed?: number }; error?: unknown; finish?: string }
  parts?: RawPart[]
}
export type SessionStatus = { type?: string }
export type StatusMap = Record<string, SessionStatus | undefined>

type PermissionEvent = Extract<AgentEvent, { type: 'permission.requested' }>

/**
 * Events produced by observeTurn(). A superset of AgentEvent for task
 * consumers: `prompt.accepted` proves the user message with our ID exists,
 * and permission requests may carry the tool call they block. send() filters
 * these down to the plain AgentEvent stream chat has always seen.
 */
export type TurnEvent =
  | Exclude<AgentEvent, PermissionEvent>
  | (PermissionEvent & { callId?: string })
  | { type: 'prompt.accepted'; taskId: string; messageId: string }

export function selectTurnMessages(messages: RawMessage[], promptId: string): RawMessage[] {
  return messages.filter(m => m.info?.role === 'assistant' && m.info.parentID === promptId)
    .sort((a, b) => (a.info?.time?.created ?? 0) - (b.info?.time?.created ?? 0))
}

export function hasPromptMessage(messages: RawMessage[], promptId: string): boolean {
  return messages.some(m => m.info?.id === promptId && m.info.role === 'user')
}

export type TurnCompletion = 'complete' | 'errored' | 'incomplete'

/** A turn is over when a step errored, or the last step completed without asking for more tool calls. */
export function turnCompletion(turn: RawMessage[]): TurnCompletion {
  if (!turn.length) return 'incomplete'
  if (turn.some(m => m.info?.error)) return 'errored'
  const last = turn[turn.length - 1]
  if (typeof last.info?.time?.completed !== 'number' || last.info.finish === 'tool-calls') return 'incomplete'
  return 'complete'
}

export function isSessionBusy(status: StatusMap | null | undefined, sessionId: string): boolean {
  const entry = status?.[sessionId]
  return !!entry && entry.type !== 'idle'
}

export function hasActiveToolPart(turn: RawMessage[]): boolean {
  return turn.some(m => (m.parts ?? []).some(p => p?.type === 'tool' && (p.state?.status === 'running' || p.state?.status === 'pending')))
}

export function partIdentity(part: RawPart): PartIdentity {
  return {
    ...(typeof part.messageID === 'string' ? { messageId: part.messageID } : {}),
    ...(typeof part.id === 'string' ? { partId: part.id } : {}),
    ...(typeof part.callID === 'string' ? { callId: part.callID } : {}),
  }
}

function toolEvents(part: RawPart, taskId: string, identity: boolean): AgentEvent[] {
  const toolName = String(part.tool ?? 'unknown')
  const ids = identity ? partIdentity(part) : {}
  const completed = part.state?.status === 'completed'
  const out: AgentEvent[] = []
  if (completed) out.push({ type: 'tool.completed', taskId, toolName, ...ids })
  else if (part.state?.status === 'error') out.push({ type: 'tool.failed', taskId, toolName, error: String(part.state.error ?? 'tool failed'), ...ids })
  if (!completed) return out // a failed tool's attachments (if any) may be partial/garbage — don't forward them
  // Tools that produce a file (e.g. a browser screenshot MCP tool) attach it
  // as a `data:` URI on the tool's own state — confirmed against a real
  // opencode serve response; there's no separate top-level `file` message part.
  for (const att of part.state?.attachments ?? []) {
    if (att?.type === 'file' && typeof att.mime === 'string' && typeof att.url === 'string' && att.url.startsWith('data:')) {
      out.push({ type: 'attachment.completed', taskId, mime: att.mime, dataUrl: att.url, filename: att.filename })
    }
  }
  return out
}

function textSnapshots(turn: RawMessage[], taskId: string): TurnEvent[] {
  return turn.flatMap(m => (m.parts ?? [])
    .filter(p => p?.type === 'text' && typeof p.text === 'string' && typeof p.id === 'string')
    .map(p => ({ type: 'text.snapshot' as const, taskId, messageId: String(p.messageID ?? m.info?.id ?? ''), partId: p.id as string, text: p.text as string })))
}

/**
 * Builds the terminal events for a finished turn from the message list, or
 * null while the turn is not over yet. A multi-step turn creates several
 * assistant messages sharing one parentID; their tool parts/attachments are
 * merged, and the final text comes from the LAST assistant message so the
 * user sees the summary rather than intermediate reasoning. Completed tool
 * artifacts are kept even when a later step failed.
 *
 * With `identity`, text snapshots per part and tool part identity are added
 * for task consumers (the message list is authoritative even if SSE dropped).
 */
export function finalizeTurn(messages: RawMessage[], promptId: string, taskId: string, identity: boolean): TurnEvent[] | null {
  const turn = selectTurnMessages(messages, promptId)
  const completion = turnCompletion(turn)
  if (completion === 'incomplete') return null
  const out: TurnEvent[] = turn.flatMap(m => m.parts ?? []).filter(p => p?.type === 'tool').flatMap(p => toolEvents(p, taskId, identity))
  if (identity) out.push(...textSnapshots(turn, taskId))
  if (completion === 'errored') {
    const errored = turn.map(m => m.info?.error).find(Boolean)
    return [...out, { type: 'task.failed', taskId, reason: errorMessage(errored) }]
  }
  const last = turn[turn.length - 1]
  const text = (last.parts ?? []).filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text as string).join('')
  if (text) out.push({ type: 'text.completed', taskId, text })
  out.push({ type: 'session.idle', taskId })
  return out
}

/** Where a turn is, given a successfully fetched message list and status map. */
export function classifyTurn(messages: RawMessage[], promptId: string, busy: boolean): 'absent' | 'running' | 'ended' {
  const turn = selectTurnMessages(messages, promptId)
  if (!hasPromptMessage(messages, promptId) && !turn.length) return 'absent'
  if (busy) return 'running'
  // Idle but not finished (e.g. queued, or no reply yet) is not an end.
  return turnCompletion(turn) === 'incomplete' ? 'running' : 'ended'
}
