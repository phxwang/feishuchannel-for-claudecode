/**
 * Claude-via-tmux delivery mode.
 *
 * Alternative to the Unix-socket worker protocol (worker-link.ts / server.ts).
 * Instead of running server.ts as an MCP plugin inside a Claude Code process
 * and pushing a `notifications/claude/channel` JSON-RPC notification into it,
 * this mode keeps a real interactive `claude` CLI running in a detached tmux
 * session per workdir and feeds it messages via `tmux send-keys` — i.e. as if
 * a human had typed them at the terminal. See the design doc shared with the
 * user (2026-11-11) for the full rationale: Claude Code CLI wraps channel-
 * sourced messages received while busy in an "untrusted external data"
 * system reminder, which breaks confirm-card flows; terminal keystrokes carry
 * no such wrapper because the CLI can't tell them apart from a real user.
 *
 * Validated manually (2026-11-11): a message pasted into a tmux session
 * while Claude was mid-task (running a long Bash command) was queued and
 * answered as a normal next turn, with no "untrusted external data" framing
 * — confirming the premise this whole mode exists for.
 *
 * Honest scope for this first cut:
 *   - Attachments are not forwarded in tmux mode (no MCP channel plugin is
 *     loaded, so there's no download_attachment tool for the CLI to use).
 *   - Turn completion is detected heuristically (quiet period on the JSONL
 *     transcript), not via a Stop hook signal — the hook-based design is
 *     documented but not wired up yet, see docs/multi-agent-router-design.md
 *     follow-up list (to be added alongside this).
 *   - Permission dialogs that pop up inside the tmux session (not via the
 *     MCP channel's send_confirm_card path) are NOT handled — the CLI will
 *     sit there waiting for a keypress this code never sends. Only tool
 *     calls pre-approved via the project's settings.json should be expected
 *     to work unattended.
 *   - Each spawned session is pinned to a known --session-id so replies are
 *     read from its exact transcript file. That mapping is in-memory only:
 *     if the router restarts while a tmux session is still alive, the next
 *     message to that workdir falls back to "newest .jsonl by mtime" in
 *     findLatestTranscript(), which can pick up an unrelated session's
 *     transcript if more than one `claude` process targets the same workdir.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')

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
  message?: { role?: string; content?: unknown }
}

/**
 * Extract plain assistant text from raw JSONL transcript lines. Lines that
 * aren't valid JSON, aren't assistant messages, or carry no text content
 * (e.g. a pure tool_use turn) are skipped rather than throwing — a
 * transcript is append-only but a partially-written last line while the
 * CLI is still flushing is expected, not an error.
 */
export function parseAssistantTextLines(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    let parsed: TranscriptLine
    try { parsed = JSON.parse(line) } catch { continue }
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

/** True once `quietMs` have passed since the transcript last grew — our proxy for "turn finished". */
export function isQuietDone(lastChangeAtMs: number, nowMs: number, quietMs: number): boolean {
  return nowMs - lastChangeAtMs >= quietMs
}

async function runTmux(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['tmux', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { ok: exitCode === 0, stdout, stderr }
}

/** Deterministic transcript path once a session was spawned with a known --session-id. */
function transcriptPathForSession(workdir: string, sessionId: string): string {
  return join(CLAUDE_PROJECTS_DIR, escapeWorkdirForTranscriptDir(workdir), `${sessionId}.jsonl`)
}

/**
 * Fallback only: used when we don't know the live session's id (e.g. a tmux
 * session that outlived a router restart, so our in-memory sessionIds map
 * lost the association). Picks the jsonl with the most recent mtime at or
 * after `sinceMs`. This can pick up an unrelated session's transcript if
 * another `claude` process is also running against the same workdir —
 * acceptable as a degraded fallback, not as the primary path.
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

export interface TmuxClaudeManagerOptions {
  dbg?: (msg: string) => void
  /** Fixed pane size so the CLI's ink UI doesn't reflow mid-session. */
  cols?: number
  rows?: number
  /** How long to wait for a brand-new session's transcript file to appear before sending the first message. */
  startupTimeoutMs?: number
  /** How long with no transcript growth before a reply is considered complete. */
  quietMs?: number
  /** Hard cap on waiting for a reply, regardless of quiet period. */
  replyTimeoutMs?: number
}

export class TmuxClaudeManager {
  private readonly dbg: (msg: string) => void
  private readonly cols: number
  private readonly rows: number
  private readonly startupTimeoutMs: number
  private readonly quietMs: number
  private readonly replyTimeoutMs: number
  /** Workdirs we've confirmed a live tmux session for, to skip a has-session round-trip on every message. */
  private knownAlive = new Set<string>()
  /** workdir -> the --session-id we spawned `claude` with, so we can tail its exact transcript file instead of guessing by mtime. Lost on router restart. */
  private sessionIds = new Map<string, string>()
  /** workdir -> tail of the in-flight sendAndAwaitReply call, so a second message for the same workdir queues instead of racing the first one on the same tmux pane/transcript. */
  private queues = new Map<string, Promise<unknown>>()

  constructor(opts: TmuxClaudeManagerOptions = {}) {
    this.dbg = opts.dbg ?? (() => {})
    this.cols = opts.cols ?? 220
    this.rows = opts.rows ?? 50
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 20_000
    this.quietMs = opts.quietMs ?? 2_500
    this.replyTimeoutMs = opts.replyTimeoutMs ?? 10 * 60 * 1000
  }

  private async hasSession(name: string): Promise<boolean> {
    const r = await runTmux(['has-session', '-t', name])
    return r.ok
  }

  /** Ensure a tmux session running `claude` exists for this workdir; spawns one if missing. Returns the session name. */
  async ensureSession(workdir: string): Promise<string> {
    const name = sessionNameFor(workdir)
    if (this.knownAlive.has(workdir) && await this.hasSession(name)) return name

    if (await this.hasSession(name)) {
      this.knownAlive.add(workdir)
      return name
    }

    this.dbg(`tmux: no live session for ${workdir}, spawning ${name}`)
    const spawnStartMs = Date.now()
    const sessionId = randomUUID()
    const spawn = await runTmux([
      'new-session', '-d', '-s', name, '-c', workdir, '-x', String(this.cols), '-y', String(this.rows),
      'claude', '--session-id', sessionId,
    ])
    if (!spawn.ok) throw new Error(`tmux new-session failed: ${spawn.stderr || spawn.stdout}`)
    this.sessionIds.set(workdir, sessionId)

    await this.waitForStartup(workdir, sessionId, spawnStartMs)
    this.knownAlive.add(workdir)
    return name
  }

  /** Best-effort wait for the CLI to finish booting (its transcript file shows up) before we type into it. */
  private async waitForStartup(workdir: string, sessionId: string, spawnStartMs: number): Promise<void> {
    const path = transcriptPathForSession(workdir, sessionId)
    const deadline = spawnStartMs + this.startupTimeoutMs
    while (Date.now() < deadline) {
      if (existsSync(path)) return
      await new Promise(r => setTimeout(r, 300))
    }
    this.dbg(`tmux: startup wait timed out for ${workdir}, proceeding anyway`)
  }

  /**
   * Deliver `text` into the session as a single paste (tmux set-buffer +
   * paste-buffer), then a separate Enter keypress to submit. A plain
   * `send-keys -l` types the text byte-for-byte including any embedded
   * newline, and the pty/CLI treats each of those as its own Enter — a
   * multi-line Feishu message (e.g. a quoted-reply prefix + body) would
   * submit after its first line instead of arriving as one message.
   * paste-buffer delivers it as one bracketed-paste event instead, which
   * the CLI's input box inserts as literal newlines without submitting.
   */
  private async sendKeys(name: string, text: string): Promise<void> {
    const set = await runTmux(['set-buffer', '--', text])
    if (!set.ok) throw new Error(`tmux set-buffer failed: ${set.stderr || set.stdout}`)
    const paste = await runTmux(['paste-buffer', '-t', name, '-p'])
    if (!paste.ok) throw new Error(`tmux paste-buffer failed: ${paste.stderr || paste.stdout}`)
    const enter = await runTmux(['send-keys', '-t', name, 'Enter'])
    if (!enter.ok) throw new Error(`tmux send-keys (Enter) failed: ${enter.stderr || enter.stdout}`)
  }

  /**
   * Deliver a message to the workdir's Claude session and wait for its reply.
   * Returns the concatenation of every assistant text turn produced before
   * the transcript goes quiet for `quietMs` (or `replyTimeoutMs` elapses).
   * Calls for the same workdir are serialized — see `queues`.
   */
  async sendAndAwaitReply(workdir: string, text: string): Promise<string> {
    const previous = this.queues.get(workdir) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(() => this.doSendAndAwaitReply(workdir, text))
    this.queues.set(workdir, task)
    return task
  }

  private async doSendAndAwaitReply(workdir: string, text: string): Promise<string> {
    const name = await this.ensureSession(workdir)
    const sessionId = this.sessionIds.get(workdir)
    const beforeSendMs = Date.now()
    const transcriptBefore = sessionId ? transcriptPathForSession(workdir, sessionId) : findLatestTranscript(workdir)
    const startOffset = transcriptBefore && existsSync(transcriptBefore) ? statSync(transcriptBefore).size : 0

    await this.sendKeys(name, text)

    const deadline = beforeSendMs + this.replyTimeoutMs
    let lastChangeMs = Date.now()
    let lastSize = startOffset
    let transcriptPath = transcriptBefore
    const collected: string[] = []

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 400))
      if (!transcriptPath) transcriptPath = sessionId ? transcriptPathForSession(workdir, sessionId) : findLatestTranscript(workdir, beforeSendMs)
      if (!transcriptPath || !existsSync(transcriptPath)) continue

      // Read as a Buffer and slice by byte offset, not by string index: lastSize/size
      // come from statSync().size (bytes), but a JS string index counts UTF-16 code
      // units — any multi-byte character before the offset (e.g. CJK text, which this
      // very code sends when attachments are present) would desync the two and cut
      // the new slice mid-character.
      const buf = readFileSync(transcriptPath)
      if (buf.length > lastSize) {
        const newText = buf.subarray(lastSize).toString('utf8')
        collected.push(...parseAssistantTextLines(newText.split('\n')))
        lastSize = buf.length
        lastChangeMs = Date.now()
        continue
      }
      if (collected.length > 0 && isQuietDone(lastChangeMs, Date.now(), this.quietMs)) break
    }

    return collected.join('\n\n')
  }

  async killSession(workdir: string): Promise<void> {
    const name = sessionNameFor(workdir)
    this.knownAlive.delete(workdir)
    this.sessionIds.delete(workdir)
    await runTmux(['kill-session', '-t', name])
  }
}
