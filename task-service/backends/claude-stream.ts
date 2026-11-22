/**
 * Pure mapping from `claude -p --output-format stream-json` lines to task
 * backend events (design doc §11.4). The reducer never mutates its input
 * state, so a replay of the same file from byte 0 rebuilds the same state.
 *
 * Text identity:
 *  - partial `stream_event` deltas → `append` on `<messageId>:<blockIndex>`
 *  - an `assistant` message that was not streamed → `snapshot` on
 *    `<messageId>:L<lineEndOffset>:<i>` (stable across replays of the file)
 */
import type { BackendEvent } from './backend'

export interface ResultInfo {
  outcome: 'completed' | 'failed'
  finalText: string | null
  stopReason: string | null
  detail: string | null
}

export interface StreamState {
  sessionId: string
  init: 'none' | 'ours' | 'foreign'
  /** Top-level message currently being streamed through `stream_event`s. */
  messageId: string | null
  /** Accumulated text per stream id (needed to re-snapshot after a resume). */
  blocks: ReadonlyMap<string, string>
  streamedMessages: ReadonlySet<string>
  openTools: ReadonlyMap<string, string>
  toolsSeen: ReadonlySet<string>
  result: ResultInfo | null
}

export interface Reduced { state: StreamState; events: BackendEvent[] }

type Json = Record<string, any>

export function initialStreamState(sessionId: string): StreamState {
  return {
    sessionId, init: 'none', messageId: null, blocks: new Map(), streamedMessages: new Set(),
    openTools: new Map(), toolsSeen: new Set(), result: null,
  }
}

export function reduceLine(state: StreamState, line: string, lineEndOffset: number): Reduced {
  let obj: Json
  try { obj = JSON.parse(line) } catch {
    return { state, events: [{ type: 'diagnostic', detail: `unparseable stream-json line at byte ${lineEndOffset}` }] }
  }
  if (!obj || typeof obj !== 'object') return { state, events: [] }
  switch (obj.type) {
    case 'system': return reduceSystem(state, obj)
    case 'stream_event': return reduceStreamEvent(state, obj)
    case 'assistant': return reduceAssistant(state, obj, lineEndOffset)
    case 'user': return reduceUser(state, obj)
    case 'result': return reduceResult(state, obj)
    default: return { state, events: [] }
  }
}

function reduceSystem(state: StreamState, obj: Json): Reduced {
  if (obj.subtype !== 'init' || state.init !== 'none') return { state, events: [] }
  if (obj.session_id === state.sessionId) {
    return { state: { ...state, init: 'ours' }, events: [{ type: 'delivery', status: 'accepted' }] }
  }
  return {
    state: { ...state, init: 'foreign' },
    events: [{ type: 'delivery', status: 'unknown', detail: `init reported session ${String(obj.session_id)}, expected ${state.sessionId}` }],
  }
}

function isTopLevel(obj: Json): boolean {
  return !obj.parent_tool_use_id
}

function reduceStreamEvent(state: StreamState, obj: Json): Reduced {
  const ev: Json = obj.event ?? {}
  if (!isTopLevel(obj)) return { state, events: [{ type: 'activity', label: 'subagent' }] }
  if (ev.type === 'message_start') {
    const id = typeof ev.message?.id === 'string' ? ev.message.id : null
    const streamedMessages = id ? new Set([...state.streamedMessages, id]) : state.streamedMessages
    return { state: { ...state, messageId: id, streamedMessages }, events: [{ type: 'activity', label: 'message' }] }
  }
  if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string' && state.messageId) {
    const streamId = `${state.messageId}:${Number(ev.index ?? 0)}`
    const blocks = new Map(state.blocks).set(streamId, (state.blocks.get(streamId) ?? '') + ev.delta.text)
    return { state: { ...state, blocks }, events: [{ type: 'text', streamId, text: ev.delta.text, mode: 'append' }] }
  }
  return { state, events: [{ type: 'activity', label: String(ev.delta?.type ?? ev.type ?? 'stream') }] }
}

function reduceAssistant(state: StreamState, obj: Json, lineEndOffset: number): Reduced {
  const msg: Json = obj.message ?? {}
  const content: Json[] = Array.isArray(msg.content) ? msg.content : []
  const msgId = typeof msg.id === 'string' ? msg.id : `line${lineEndOffset}`
  const streamed = state.streamedMessages.has(msgId)
  const events: BackendEvent[] = []
  let blocks = state.blocks
  let openTools = state.openTools
  let toolsSeen = state.toolsSeen
  content.forEach((block, i) => {
    if (block?.type === 'text' && typeof block.text === 'string' && isTopLevel(obj) && !streamed && block.text) {
      const streamId = `${msgId}:L${lineEndOffset}:${i}`
      blocks = new Map(blocks).set(streamId, block.text)
      events.push({ type: 'text', streamId, text: block.text, mode: 'snapshot' })
    }
    if ((block?.type === 'tool_use' || block?.type === 'server_tool_use') && typeof block.id === 'string' && !toolsSeen.has(block.id)) {
      const name = typeof block.name === 'string' ? block.name : 'tool'
      openTools = new Map(openTools).set(block.id, name)
      toolsSeen = new Set([...toolsSeen, block.id])
      events.push({ type: 'tool', toolCallId: block.id, name, status: 'started' })
    }
  })
  return { state: { ...state, blocks, openTools, toolsSeen }, events }
}

function reduceUser(state: StreamState, obj: Json): Reduced {
  const content: Json[] = Array.isArray(obj.message?.content) ? obj.message.content : []
  const events: BackendEvent[] = []
  let openTools = state.openTools
  for (const block of content) {
    if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    const name = openTools.get(block.tool_use_id)
    if (name === undefined) continue // unknown or already completed: replay-safe
    const next = new Map(openTools)
    next.delete(block.tool_use_id)
    openTools = next
    events.push({ type: 'tool', toolCallId: block.tool_use_id, name, status: block.is_error ? 'failed' : 'completed' })
  }
  return { state: { ...state, openTools }, events }
}

function reduceResult(state: StreamState, obj: Json): Reduced {
  if (state.result) return { state, events: [] }
  const ok = obj.subtype === 'success' && obj.is_error !== true
  const errors = Array.isArray(obj.errors) ? obj.errors.map(String).join('; ') : null
  const result: ResultInfo = {
    outcome: ok ? 'completed' : 'failed',
    finalText: typeof obj.result === 'string' ? obj.result : null,
    stopReason: typeof obj.stop_reason === 'string' ? obj.stop_reason : (typeof obj.subtype === 'string' ? obj.subtype : null),
    detail: errors || (ok ? null : String(obj.subtype ?? 'error')),
  }
  const events: BackendEvent[] = !ok && result.detail ? [{ type: 'diagnostic', detail: `claude result: ${result.detail}` }] : []
  return { state: { ...state, result }, events }
}

/** Snapshot of every accumulated stream, used when observation catches up after a resume. */
export function snapshotEvents(state: StreamState): BackendEvent[] {
  return [...state.blocks].map(([streamId, text]) => ({ type: 'text', streamId, text, mode: 'snapshot' }))
}

/** Terminal event for a stream whose process is gone. */
export function endEvents(state: StreamState, exit: { code: number | null; signal: string | null } | null, stderrTail: string, groupSettled: boolean): BackendEvent[] {
  const process = { exitCode: exit?.code ?? null, signal: exit?.signal ?? null, controlledShutdown: null }
  const effects = state.toolsSeen.size === 0 ? 'none' as const : 'unknown' as const
  if (state.result) {
    const r = state.result
    return [{
      type: 'turn.ended', outcome: r.outcome, finalText: r.finalText, process, effects,
      protocol: { backendFinished: true, activeToolCount: state.openTools.size, stopReason: r.stopReason },
      ...(r.outcome === 'failed' ? { failureCode: 'execution_failed' as const } : {}),
    }]
  }
  const diag: BackendEvent[] = stderrTail ? [{ type: 'diagnostic', detail: `claude stderr: ${stderrTail}` }] : []
  if (state.init === 'ours') {
    return [...diag, {
      type: 'turn.ended', outcome: 'failed', finalText: null, process, effects, failureCode: 'execution_failed',
      protocol: { backendFinished: false, activeToolCount: state.openTools.size, stopReason: 'process exited without a result event' },
    }]
  }
  if (state.init === 'none' && exit && exit.code !== null && exit.code !== 0) {
    const detail = `claude exited with code ${exit.code} before system/init${stderrTail ? `: ${stderrTail}` : ''}`
    return [{ type: 'delivery', status: 'not_sent', failure: { kind: 'not_sent', code: 'startup_failed', detail, ownerSettled: groupSettled } }]
  }
  const why = state.init === 'foreign' ? 'init reported a different session' : 'process ended without system/init and without a known non-zero exit code'
  return [...diag, { type: 'delivery', status: 'unknown', detail: why }, { type: 'lost', detail: why }]
}

/** Cheap whole-file scan for recovery: did the stream reach init / result? */
export function scanForMarkers(content: string, sessionId: string): { init: boolean; result: boolean } {
  let init = false
  let result = false
  for (const line of content.split('\n')) {
    if (!line.includes('"type"')) continue
    let obj: Json
    try { obj = JSON.parse(line) } catch { continue }
    if (obj?.type === 'system' && obj.subtype === 'init' && obj.session_id === sessionId) init = true
    if (obj?.type === 'result') result = true
  }
  return { init, result }
}
