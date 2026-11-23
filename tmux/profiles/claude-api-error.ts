/**
 * Reads the API error, if any, that ended Claude Code's latest turn.
 *
 * Claude Code writes a failed request to the transcript as a synthetic
 * assistant entry: `isApiErrorMessage: true`, a machine-readable `error`
 * category (`verification_required`, `authentication_failed`, `rate_limit`,
 * `invalid_request`, `server_error` …) and `apiErrorStatus`. That structured
 * entry — not pane text — is the evidence.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'fs'

export interface ClaudeApiError {
  /** Claude Code's error category, e.g. "verification_required". "unknown" when absent. */
  code: string
  status: number | null
  text: string
}

/** Turns end with the error entry, so the tail of the transcript is enough. */
const TAIL_BYTES = 256 * 1024
const MAX_TEXT_CHARS = 500

function readTail(path: string): string {
  const size = statSync(path).size
  const len = Math.min(size, TAIL_BYTES)
  const buf = Buffer.alloc(len)
  const fd = openSync(path, 'r')
  try { readSync(fd, buf, 0, len, size - len) } finally { closeSync(fd) }
  return buf.toString('utf8')
}

type Entry = { type?: unknown; isApiErrorMessage?: unknown; error?: unknown; apiErrorStatus?: unknown; message?: { content?: unknown } }

function entryText(e: Entry): string {
  const c = e.message?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c.map(p => (p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' ? String((p as { text?: unknown }).text ?? '') : '')).join('')
}

/** A user entry that is a prompt (not a tool result) starts a turn. */
function isPrompt(e: Entry): boolean {
  if (e.type !== 'user') return false
  const c = e.message?.content
  if (typeof c === 'string') return true
  return Array.isArray(c) && !c.some(p => p && typeof p === 'object' && (p as { type?: unknown }).type === 'tool_result')
}

/** Pure: the API error that is the latest assistant entry of the latest turn, else null. */
export function parseLastTurnApiError(transcriptTail: string): ClaudeApiError | null {
  const lines = transcriptTail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line) continue
    let e: Entry
    try { e = JSON.parse(line) } catch { continue } // first line of a tail may be cut
    if (isPrompt(e)) return null
    if (e.type !== 'assistant') continue
    if (e.isApiErrorMessage !== true) return null
    return {
      code: typeof e.error === 'string' && e.error ? e.error : 'unknown',
      status: typeof e.apiErrorStatus === 'number' ? e.apiErrorStatus : null,
      text: entryText(e).slice(0, MAX_TEXT_CHARS),
    }
  }
  return null
}

export function lastTurnApiError(transcriptPath: string | null | undefined): ClaudeApiError | null {
  if (!transcriptPath || !existsSync(transcriptPath)) return null
  try { return parseLastTurnApiError(readTail(transcriptPath)) } catch { return null }
}
