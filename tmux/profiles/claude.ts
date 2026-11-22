/**
 * Claude Code CLI profile for the tmux manager. Moved verbatim from
 * claude-tmux-worker.ts (behavior unchanged): `--session-id` known up front,
 * a per-session Stop hook injected through `--settings` that touches a
 * signal file, transcript under ~/.claude/projects/<escaped workdir>/,
 * numbered menus answered with digit + Enter.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'
import { backgroundWaitAfterStop, pendingBackgroundTaskIds } from '../../background-tasks'
import { parseClaudeGoalSignal } from './claude-goal'
import { parseDialogOptions, parseRunningShellCount, parseTabBar, type DialogOption } from '../dialog'
import { resolveBin, type ProgressEvent, type SpawnOptions, type SpawnPlan, type StopContext, type StopOutcome, type TmuxCliProfile } from '../profile'

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const STOP_SIGNAL_DIR = join(tmpdir(), 'feishu-claude-tmux-stop')

/** Deterministic tmux session name for a workdir — stable across router restarts. */
export function sessionNameFor(workdir: string): string {
  const hash = createHash('sha1').update(workdir).digest('hex').slice(0, 10)
  return `feishu-claude-${hash}`
}

/** Mirrors how Claude Code CLI names its per-project transcript directory under ~/.claude/projects. */
export function escapeWorkdirForTranscriptDir(workdir: string): string {
  return workdir.replace(/\//g, '-')
}

export interface TranscriptLine {
  type?: string
  subtype?: string
  content?: unknown
  message?: { role?: string; content?: unknown }
}

/**
 * Pulls the text out of a `<local-command-stdout>...</local-command-stdout>`
 * (or `-stderr`) wrapper, or null if `value` isn't a string containing one.
 * The closing tag is a backreference to the opener so a malformed
 * interleaved pair is rejected rather than extracted.
 */
const LOCAL_COMMAND_OUTPUT_RE = /<local-command-(std(?:out|err))>([\s\S]*?)<\/local-command-\1>/
function extractLocalCommandOutput(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = value.match(LOCAL_COMMAND_OUTPUT_RE)
  return m ? m[2].trim() || null : null
}

/**
 * True for the record a local-only slash command leaves when it finishes
 * (`/model` → "Kept model as X", `/cost` …): no assistant turn and no Stop
 * hook follow it. Both recorded shapes count — a `system/local_command` line
 * or a `user` line wrapping the `<local-command-stdout|stderr>` tag.
 */
export function isLocalCommandResultLine(line: string): boolean {
  if (!line.includes('local-command-std')) return false
  let parsed: TranscriptLine
  try { parsed = JSON.parse(line) } catch { return false }
  if (parsed.type === 'system' && parsed.subtype === 'local_command') return LOCAL_COMMAND_OUTPUT_RE.test(String(parsed.content ?? ''))
  if (parsed.type === 'user') return typeof parsed.message?.content === 'string' && LOCAL_COMMAND_OUTPUT_RE.test(parsed.message.content)
  return false
}

/**
 * Extract plain reply text from raw JSONL transcript lines. Invalid or
 * text-less lines are skipped (a partially-flushed last line is expected).
 *
 * Besides real assistant turns, also surfaces a slash command's own output
 * when it resolves with nothing to pick (e.g. a repeat `/model` prints
 * "Kept model as X" with no assistant turn and no Stop hook) — recorded as
 * either a `type: 'system', subtype: 'local_command'` line or a `type:
 * 'user'` line wrapping the same `<local-command-stdout>` tag.
 */
export function parseAssistantTextLines(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    let parsed: TranscriptLine
    try { parsed = JSON.parse(line) } catch { continue }
    if (parsed.type === 'system' && parsed.subtype === 'local_command') {
      const stdout = extractLocalCommandOutput(parsed.content)
      if (stdout) out.push(stdout)
      continue
    }
    if (parsed.type === 'user') {
      const stdout = extractLocalCommandOutput(parsed.message?.content)
      if (stdout) out.push(stdout)
      continue
    }
    if (parsed.type !== 'assistant') continue
    const content = parsed.message?.content
    if (typeof content === 'string') {
      if (content) out.push(content)
    } else if (Array.isArray(content)) {
      const text = content
        .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text)
        .join('')
      if (text) out.push(text)
    }
  }
  return out
}

/** Tool-input fields worth surfacing as a one-line progress summary, tried in order; the first string value wins. */
const PROGRESS_SUMMARY_FIELDS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']
export const PROGRESS_SUMMARY_MAX_LEN = 80

export function summarizeToolInput(input: unknown, fields: readonly string[] = PROGRESS_SUMMARY_FIELDS): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  for (const key of fields) {
    const v = obj[key]
    if (typeof v === 'string' && v) {
      return v.length > PROGRESS_SUMMARY_MAX_LEN ? v.slice(0, PROGRESS_SUMMARY_MAX_LEN) + '…' : v
    }
  }
  return ''
}

/**
 * Pulls tool_use blocks out of raw JSONL transcript lines — the only
 * "something is happening" signal before a turn finishes. Only surfaces the
 * tool name plus a short, truncated summary of one input field, never the
 * raw input object.
 */
export function parseProgressLines(lines: string[]): ProgressEvent[] {
  const out: ProgressEvent[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    let parsed: TranscriptLine
    try { parsed = JSON.parse(line) } catch { continue }
    if (parsed.type !== 'assistant') continue
    const content = parsed.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block && typeof block === 'object' && (block as any).type === 'tool_use' && typeof (block as any).name === 'string') {
        out.push({ tool: (block as any).name, summary: summarizeToolInput((block as any).input) })
      }
    }
  }
  return out
}

/** Where the per-session Stop hook (see buildSettingsOverride) touches a file when a turn ends. */
export function stopSignalPathFor(sessionId: string): string {
  return join(STOP_SIGNAL_DIR, `${sessionId}.stop`)
}

/**
 * `--settings` JSON passed when spawning a session: a Stop hook that touches
 * `stopSignalPathFor(sessionId)`. Layers on top of (doesn't replace) the
 * project's own settings.json — Claude Code merges hooks across scopes.
 */
export function buildSettingsOverride(sessionId: string): string {
  const signalPath = stopSignalPathFor(sessionId)
  return JSON.stringify({
    hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: `touch '${signalPath}'` }] }],
    },
  })
}

function transcriptPathForSession(workdir: string, sessionId: string): string {
  return join(CLAUDE_PROJECTS_DIR, escapeWorkdirForTranscriptDir(workdir), `${sessionId}.jsonl`)
}

/**
 * Fallback only, for when the live session's id is unknown (e.g. a tmux
 * session that outlived a router restart with no persisted id). Picks the
 * jsonl with the most recent mtime at or after `sinceMs` — can pick up an
 * unrelated session's transcript if another `claude` targets the same dir.
 */
function findLatestTranscript(workdir: string, sinceMs?: number): string | null {
  const dir = join(CLAUDE_PROJECTS_DIR, escapeWorkdirForTranscriptDir(workdir))
  if (!existsSync(dir)) return null
  let best: { path: string; mtimeMs: number } | null = null
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(dir, name)
    const mtimeMs = statSync(path).mtimeMs
    if (sinceMs !== undefined && mtimeMs < sinceMs) continue
    if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs }
  }
  return best?.path ?? null
}

/**
 * Background tasks the session started and hasn't heard back from yet
 * (see background-tasks.ts). Reads the whole transcript so a task started
 * during an earlier message still counts. Unreadable → empty set.
 */
function pendingBackgroundTasks(transcriptPath: string | null): Set<string> {
  if (!transcriptPath || !existsSync(transcriptPath)) return new Set()
  try {
    return pendingBackgroundTaskIds(readFileSync(transcriptPath, 'utf8').split('\n'))
  } catch {
    return new Set()
  }
}

const CLAUDE_BIN = resolveBin('claude', [join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'])

export const claudeProfile: TmuxCliProfile = {
  kind: 'claude',
  label: 'Claude',
  midTurn: 'absorb',
  resumable: false,

  sessionName: sessionNameFor,

  prepareSpawn() {
    mkdirSync(STOP_SIGNAL_DIR, { recursive: true })
  },

  planSpawn(_workdir: string, opts: SpawnOptions): SpawnPlan {
    const sessionId = randomUUID()
    return {
      argv: [CLAUDE_BIN, '--session-id', sessionId, '--settings', buildSettingsOverride(sessionId), ...(opts.model ? ['--model', opts.model] : [])],
      env: {},
      sessionId,
    }
  },

  /**
   * Polls for the input-box prompt character — NOT the transcript file:
   * Claude Code doesn't create the .jsonl until the first message is sent.
   */
  isReady: (plainPane: string) => plainPane.includes('❯'),

  transcriptPath: transcriptPathForSession,
  findLatestTranscript,

  stopSignalPath: (_workdir: string, sessionId: string | undefined) => sessionId ? stopSignalPathFor(sessionId) : null,

  /**
   * A Stop doesn't always end the whole reply: the CLI auto-continues into a
   * fresh turn once a background shell/agent it started finishes. The
   * footer's "N shells" covers bash; the transcript's start/end records
   * cover async agents too (found live: "← 2 agents" with no shell count).
   */
  afterStop(ctx: StopContext): StopOutcome {
    const pending = pendingBackgroundTasks(ctx.transcriptPath)
    const runningShells = parseRunningShellCount(ctx.plainPane)
    return { wait: backgroundWaitAfterStop(pending.size, runningShells) }
  },

  isLocalCommandResult: isLocalCommandResultLine,
  parseGoalSignal: parseClaudeGoalSignal,
  parseText: parseAssistantTextLines,
  parseProgress: parseProgressLines,
  parseDialog: (plainPane: string) => parseDialogOptions(plainPane) ?? parseTabBar(plainPane),
  /** Type the digit, then Enter — Claude's menus need the confirmation keypress. */
  optionKeys: (option: DialogOption) => [['-l', option.number], ['Enter']],
}
