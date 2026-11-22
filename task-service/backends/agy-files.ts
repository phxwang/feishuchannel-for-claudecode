/**
 * File-level evidence for an agy task attempt (design doc §11.6): the
 * persisted handle extras, the attempt's own hook signal files and the
 * conversation's transcript. Pure reads — safe to repeat after a restart.
 */
import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import type { BackgroundWait } from '../../background-tasks'
import { agyTranscriptPath, parseAgyProgressLines, parseAgyTextLines, readAgyStop } from '../../tmux/profiles/agy'
import type { BackendHandle } from './backend'

/** Durable per-attempt facts stored in BackendHandle.extra. */
export interface AgyExtra {
  sessionName: string
  signalDir: string
  conversationId: string | null
  /** `<conversationId>:<USER_INPUT step index>` once delivery is proven, else 'pending'. */
  backendTurnId: string
  /** sha256 of the whitespace-normalized prompt, set at submit. */
  promptSha256: string | null
  submittedAtMs: number | null
  /** Stop.json mtime right before the prompt was sent (0 = no Stop.json yet). */
  stopBaselineMs: number
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function readExtra(handle: BackendHandle, fallback: { sessionName: string; signalDir: string }): AgyExtra {
  const x = handle.extra
  return {
    sessionName: str(x.sessionName) ?? fallback.sessionName,
    signalDir: str(x.signalDir) ?? fallback.signalDir,
    conversationId: str(x.conversationId),
    backendTurnId: str(x.backendTurnId) ?? 'pending',
    promptSha256: str(x.promptSha256),
    submittedAtMs: num(x.submittedAtMs),
    stopBaselineMs: num(x.stopBaselineMs) ?? 0,
  }
}

export function handleFrom(base: BackendHandle, extra: AgyExtra): BackendHandle {
  return {
    ...base,
    backendSessionId: extra.sessionName,
    backendTurnId: extra.backendTurnId,
    extra: { ...extra },
  }
}

export function promptDigest(prompt: string): string {
  return createHash('sha256').update(prompt.replace(/\s+/g, ' ').trim()).digest('hex')
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Conversation id the hook plugin reported into this attempt's own signal dir, if any. */
export function readConversationId(signalDir: string): string | null {
  return str(readJson(join(signalDir, 'last.json'))?.conversationId)
}

export function stopSignalMtime(signalDir: string): number {
  const path = join(signalDir, 'Stop.json')
  return existsSync(path) ? statSync(path).mtimeMs : 0
}

export interface StopState {
  mtimeMs: number
  wait: BackgroundWait
  error: string | null
  terminationReason: string | null
}

/** Latest Stop hook payload of this attempt, or null when none was written after `baselineMs`. */
export function readStopAfter(signalDir: string, baselineMs: number): StopState | null {
  const mtimeMs = stopSignalMtime(signalDir)
  if (!mtimeMs || mtimeMs <= baselineMs) return null
  const path = join(signalDir, 'Stop.json')
  const outcome = readAgyStop(path)
  return { mtimeMs, wait: outcome.wait, error: outcome.error ?? null, terminationReason: str(readJson(path)?.terminationReason) }
}

export interface ToolSeen { id: string; name: string; summary: string }

export interface TurnScan {
  /** step_index of this prompt's USER_INPUT step; null until it appears. */
  inputStep: number | null
  /** True when the step was attributed by position (first USER_INPUT) because its text didn't match the prompt digest. */
  positional: boolean
  texts: string[]
  tools: ToolSeen[]
}

const EMPTY_SCAN: TurnScan = { inputStep: null, positional: false, texts: [], tools: [] }
const USER_REQUEST_RE = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/

interface Step { index: number; type: string | null; content: unknown; line: string }

function parseSteps(text: string): Step[] {
  const out: Step[] = []
  const lines = text.split('\n')
  // The last element is either '' or a half-written line; only complete lines count.
  lines.slice(0, -1).forEach((line, i) => {
    try {
      const p = JSON.parse(line) as Record<string, unknown>
      out.push({ index: num(p.step_index) ?? i, type: str(p.type), content: p.content, line })
    } catch { /* not a complete JSON step */ }
  })
  return out
}

function matchesPrompt(step: Step, promptSha: string | null): boolean {
  if (!promptSha || typeof step.content !== 'string') return false
  const m = step.content.match(USER_REQUEST_RE)
  return promptDigest(m ? m[1] : step.content) === promptSha
}

/**
 * Reads the conversation's transcript. The attempt's session is fresh and
 * exclusive, so its first USER_INPUT step is this prompt; the digest match
 * is a cross-check, and `positional` reports when it didn't hold.
 */
export function scanTranscript(brainDir: string, conversationId: string, promptSha: string | null): TurnScan {
  const path = agyTranscriptPath(conversationId, brainDir)
  if (!existsSync(path)) return EMPTY_SCAN
  const steps = parseSteps(readFileSync(path, 'utf8'))
  const inputs = steps.filter(s => s.type === 'USER_INPUT')
  if (!inputs.length) return EMPTY_SCAN
  const matched = inputs.find(s => matchesPrompt(s, promptSha))
  const input = matched ?? inputs[0]
  const after = steps.filter(s => s.index > input.index)
  const tools = after.flatMap(s => parseAgyProgressLines([s.line]).map((e, i) => ({ id: `agy:${s.index}:${i}`, name: e.tool, summary: e.summary })))
  return { inputStep: input.index, positional: !matched, texts: parseAgyTextLines(after.map(s => s.line)), tools }
}

export function transcriptSize(brainDir: string, conversationId: string): number {
  const path = agyTranscriptPath(conversationId, brainDir)
  return existsSync(path) ? statSync(path).size : 0
}
