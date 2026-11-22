/**
 * Codex rollout transcripts: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local
 * start time>-<thread id>.jsonl`, one JSON record per line (verified on
 * codex-cli 0.169.1, see docs/codex-tmux-profile.md):
 *
 *   {"type":"session_meta","payload":{"id","cwd","originator":"codex-tui","source":"cli",…}}   first line
 *   {"type":"event_msg","payload":{"type":"task_started","turn_id",…}}                        turn start
 *   {"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text"}]}}
 *   {"type":"response_item","payload":{"type":"message","role":"assistant","phase":"commentary"|"final_answer",
 *                                      "content":[{"type":"output_text","text"}]}}
 *   {"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":…}"}}
 *   {"type":"response_item","payload":{"type":"custom_tool_call","name","input"}}
 *   {"type":"event_msg","payload":{"type":"task_complete","last_agent_message","error"?:{"message"}}}  turn end
 *   {"type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}                        turn end (Esc)
 *
 * The file is created on the first submitted message (not at startup) and
 * `codex resume <id>` appends to the same file, even on a later day.
 */
import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'fs'
import { join } from 'path'
import type { ProgressEvent } from '../profile'
import { summarizeToolInput } from './claude'

export interface CodexRecord {
  type?: string
  payload?: Record<string, unknown>
}

export function parseRecord(line: string): CodexRecord | null {
  if (!line.trim()) return null
  try {
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as CodexRecord : null
  } catch {
    return null
  }
}

const eventType = (r: CodexRecord | null) => r?.type === 'event_msg' ? r.payload?.type : undefined

export function isCodexTurnStartLine(line: string): boolean {
  return line.includes('"task_started"') && eventType(parseRecord(line)) === 'task_started'
}

export function isCodexTurnEndLine(line: string): boolean {
  if (!line.includes('"task_complete"') && !line.includes('"turn_aborted"')) return false
  const t = eventType(parseRecord(line))
  return t === 'task_complete' || t === 'turn_aborted'
}

function contentText(content: unknown, kind: string): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && b.type === kind && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
}

/** Reply text: every assistant message (commentary and final answer), in order. Each message is recorded twice (event_msg AgentMessage and response_item); only the response_item copy is read. */
export function parseCodexTextLines(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const r = parseRecord(line)
    if (r?.type !== 'response_item' || r.payload?.type !== 'message' || r.payload.role !== 'assistant') continue
    const text = contentText(r.payload.content, 'output_text')
    if (text.trim()) out.push(text)
  }
  return out
}

const CODEX_PROGRESS_FIELDS = ['cmd', 'command', 'path', 'file_path', 'pattern', 'url', 'query']
const MAX_SUMMARY = 80

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return {} }
}

/** Arguments whose `command` is an argv array (["bash","-lc","ls"]) are flattened to a string first. */
function summarizeCodexArgs(args: unknown): string {
  if (args && typeof args === 'object' && Array.isArray((args as Record<string, unknown>).command)) {
    const cmd = ((args as Record<string, unknown>).command as unknown[]).filter(s => typeof s === 'string').join(' ')
    return summarizeToolInput({ ...(args as object), command: cmd }, CODEX_PROGRESS_FIELDS)
  }
  return summarizeToolInput(args, CODEX_PROGRESS_FIELDS)
}

/** One event per tool call the model makes: `function_call` (exec_command, …) and `custom_tool_call` (free-form input). */
export function parseCodexProgressLines(lines: string[]): ProgressEvent[] {
  const out: ProgressEvent[] = []
  for (const line of lines) {
    const r = parseRecord(line)
    if (r?.type !== 'response_item' || typeof r.payload?.name !== 'string') continue
    if (r.payload.type === 'function_call') {
      out.push({ tool: r.payload.name, summary: summarizeCodexArgs(parseArgs(r.payload.arguments)) })
    } else if (r.payload.type === 'custom_tool_call') {
      const input = typeof r.payload.input === 'string' ? r.payload.input.split('\n')[0].trim() : ''
      out.push({ tool: r.payload.name, summary: input.length > MAX_SUMMARY ? input.slice(0, MAX_SUMMARY) + '…' : input })
    }
  }
  return out
}

/** Last `maxBytes` of a file as complete lines (a partial first line is dropped). Missing file → []. */
export function readTailLines(path: string, maxBytes = 256 * 1024): string[] {
  if (!existsSync(path)) return []
  const size = statSync(path).size
  const start = Math.max(0, size - maxBytes)
  const buf = Buffer.alloc(size - start)
  const fd = openSync(path, 'r')
  try { readSync(fd, buf, 0, buf.length, start) } finally { closeSync(fd) }
  const lines = buf.toString('utf8').split('\n')
  return start > 0 ? lines.slice(1) : lines
}

export interface CodexTurnEnd {
  kind: 'complete' | 'aborted'
  error?: string
}

/** The last turn end recorded in the rollout, or null if none is found in its tail. */
export function lastTurnEnd(path: string): CodexTurnEnd | null {
  const lines = readTailLines(path)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isCodexTurnEndLine(lines[i])) continue
    const p = parseRecord(lines[i])!.payload!
    if (p.type === 'turn_aborted') return { kind: 'aborted' }
    const err = p.error as { message?: unknown } | null | undefined
    const message = err && typeof err === 'object' && typeof err.message === 'string' ? err.message : undefined
    return message ? { kind: 'complete', error: message } : { kind: 'complete' }
  }
  return null
}

const ROLLOUT_RE = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

export function rolloutIdFromPath(path: string): string | undefined {
  return path.split('/').pop()?.match(ROLLOUT_RE)?.[1]
}

function sortedDesc(dir: string, re: RegExp): string[] {
  try { return readdirSync(dir).filter(n => re.test(n)).sort().reverse() } catch { return [] }
}

/** Day directories under sessions/, newest first (YYYY/MM/DD). */
export function dayDirs(sessionsDir: string, limit = Infinity): string[] {
  const out: string[] = []
  for (const y of sortedDesc(sessionsDir, /^\d{4}$/)) {
    for (const m of sortedDesc(join(sessionsDir, y), /^\d{2}$/)) {
      for (const d of sortedDesc(join(sessionsDir, y, m), /^\d{2}$/)) {
        out.push(join(sessionsDir, y, m, d))
        if (out.length >= limit) return out
      }
    }
  }
  return out
}

/** The rollout file of a thread id, searching day dirs newest first. Null if it doesn't exist (yet). */
export function findRollout(sessionsDir: string, threadId: string): string | null {
  const suffix = `-${threadId}.jsonl`
  for (const day of dayDirs(sessionsDir)) {
    const name = sortedDesc(day, /\.jsonl$/).find(n => n.startsWith('rollout-') && n.endsWith(suffix))
    if (name) return join(day, name)
  }
  return null
}

export interface SessionMeta { id?: string; cwd?: string; originator?: string; source?: unknown }

export function readSessionMeta(path: string): SessionMeta | null {
  let first = ''
  try {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(64 * 1024)
      const n = readSync(fd, buf, 0, buf.length, 0)
      first = buf.subarray(0, n).toString('utf8').split('\n')[0]
    } finally { closeSync(fd) }
  } catch {
    return null
  }
  const r = parseRecord(first)
  return r?.type === 'session_meta' && r.payload ? r.payload as SessionMeta : null
}

function samePath(a: string | undefined, b: string): boolean {
  if (!a) return false
  if (a === b) return true
  try { return realpathSync(a) === realpathSync(b) } catch { return false }
}

/** An interactive top-level session in this workdir: not a sub-agent thread, not `codex exec`. */
export function isOwnTuiSession(meta: SessionMeta | null, workdir: string): boolean {
  if (!meta || !samePath(meta.cwd, workdir)) return false
  if (meta.originator !== 'codex-tui') return false
  return typeof meta.source !== 'object' || meta.source === null
}

/**
 * Rollouts of interactive sessions in `workdir` whose file was created at or
 * after `sinceMs`, from the two newest day dirs (a session started just
 * before midnight still counts).
 */
export function rolloutsCreatedSince(sessionsDir: string, workdir: string, sinceMs: number): string[] {
  const out: string[] = []
  for (const day of dayDirs(sessionsDir, 2)) {
    for (const name of sortedDesc(day, ROLLOUT_RE)) {
      const path = join(day, name)
      let born: number
      // birthtime is 0 on filesystems that don't record it; ctime is the closest stand-in.
      try { const st = statSync(path); born = st.birthtimeMs || st.ctimeMs } catch { continue }
      if (born < sinceMs) continue
      if (isOwnTuiSession(readSessionMeta(path), workdir)) out.push(path)
    }
  }
  return out
}
