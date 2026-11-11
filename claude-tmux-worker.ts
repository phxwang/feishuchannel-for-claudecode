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
 * Turn completion is primarily a Stop hook: each spawned session is passed
 * `--settings` with a one-off Stop hook that touches a signal file keyed by
 * that session's --session-id (layered on top of, not replacing, the
 * project's own settings — manually verified this fires reliably). The
 * quiet-period heuristic on the JSONL transcript is kept only as a fallback
 * for the case the hook doesn't fire (e.g. a tmux session that outlived a
 * router restart, so we no longer know its session id to watch for).
 *
 * Honest scope for this first cut:
 *   - Attachments: router.ts downloads them itself (feishu-download.ts) and
 *     embeds the local path in the message text, since there's no MCP
 *     channel plugin loaded here for the CLI to call download_attachment
 *     with — see handleClaudeTmuxTask in router.ts.
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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')

/**
 * Resolve the `claude` binary once, up front, instead of letting tmux's
 * spawned shell look it up via PATH every time. Found the hard way: a
 * launchd service's PATH is whatever its plist declares, which is easy to
 * write without `~/.local/bin` (where the official installer actually puts
 * the binary) — tmux then creates the session fine, but the pane's command
 * exits immediately with "command not found", killing the session before
 * it ever renders anything, which looked indistinguishable from a slow/
 * crashed boot until traced with a non-detaching wrapper. `Bun.which` also
 * only searches the CURRENT process's PATH, so it has the exact same gap;
 * the explicit fallback candidates below are what actually fixes it.
 */
function resolveClaudeBin(): string {
  const viaPath = Bun.which('claude')
  if (viaPath) return viaPath
  const candidates = [join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  for (const c of candidates) if (existsSync(c)) return c
  return 'claude'  // let tmux surface a clear "command not found" if truly missing
}

const CLAUDE_BIN = resolveClaudeBin()
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

export interface DialogOption { number: string; label: string }
export interface Dialog { question: string; options: DialogOption[] }
/**
 * Given the parsed dialog, resolve with the chosen option's number (as sent
 * back to the pane), or `DIALOG_ESCAPE_CHOICE` for a caller-side "just press
 * Escape instead" button (e.g. router.ts adds one to every card so there's
 * always a safe way out, including for dialogs this code can detect but
 * can't map to a clean single keystroke). Any other value that doesn't
 * match a real option is treated as cancelled — see collectReply.
 */
export type DialogHandler = (dialog: Dialog) => Promise<number>
export const DIALOG_ESCAPE_CHOICE = 0
/** Called (at most once per stuck episode) with the raw ANSI pane text when the session is blocked on something that isn't a parseable dialog — e.g. a `/status`-style panel. Purely informational: the caller decides what to do with it (render+send a screenshot, etc.); this code takes no further action afterward. */
export type StuckPaneHandler = (paneAnsiText: string) => Promise<void>
export interface SendAndAwaitReplyOptions {
  model?: string
  onDialog?: DialogHandler
  onStuckPane?: StuckPaneHandler
}

const OPTION_LINE_RE = /^\s*(?:❯\s*)?(\d+)\.\s+(.+?)\s*$/
const DIVIDER_LINE_RE = /^[\s─╌│]*$/
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g

/** Strip SGR color/style escape codes so layout-based parsing (parseDialogOptions) sees plain text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '')
}

/**
 * Detect a Claude Code interactive choice menu (permission prompts, etc.)
 * in a captured tmux pane, e.g.:
 *   Do you want to allow Claude to fetch this content?
 *   ❯ 1. Yes
 *     2. Yes, and don't ask again for example.com
 *     3. No, and tell Claude what to do differently (esc)
 *
 * Deliberately conservative to avoid mistaking a numbered list inside
 * Claude's own *finished* reply text for a pending menu:
 *   - options must be numbered 1..N, consecutive, starting at 1 (a prose
 *     list numbered e.g. 1/2/4 or starting mid-sequence doesn't count)
 *   - the option block must be the last non-blank content in the pane —
 *     a real menu replaces the normal input box/status bar while it's
 *     showing; a finished reply is always followed by both.
 * Returns null if no such menu is found.
 */
export function parseDialogOptions(paneText: string): Dialog | null {
  const lines = paneText.split('\n')
  const options: DialogOption[] = []
  let firstOptionIdx = -1
  let lastOptionIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(OPTION_LINE_RE)
    if (m) {
      if (firstOptionIdx === -1) firstOptionIdx = i
      lastOptionIdx = i
      options.push({ number: m[1], label: m[2].trim() })
    } else if (firstOptionIdx !== -1) {
      break  // option block ended
    }
  }
  if (options.length === 0) return null
  if (!options.every((o, idx) => o.number === String(idx + 1))) return null
  for (let i = lastOptionIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '') return null  // something else follows — not the bottom of the screen
  }

  let question = ''
  for (let i = firstOptionIdx - 1; i >= 0; i--) {
    if (lines[i].trim() === '' || DIVIDER_LINE_RE.test(lines[i])) continue
    question = lines[i].trim()
    break
  }
  return { question: question || 'Claude 需要你的输入', options }
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

/** Where the per-session Stop hook (see buildSettingsOverride) touches a file when a turn ends. */
export function stopSignalPathFor(sessionId: string): string {
  return join(STOP_SIGNAL_DIR, `${sessionId}.stop`)
}

/**
 * `--settings` JSON passed when spawning a session: a Stop hook that touches
 * `stopSignalPathFor(sessionId)`. Layers on top of (doesn't replace) the
 * project's own settings.json — Claude Code merges hooks across scopes
 * rather than letting one scope's hooks shadow another's.
 */
export function buildSettingsOverride(sessionId: string): string {
  const signalPath = stopSignalPathFor(sessionId)
  return JSON.stringify({
    hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: `touch '${signalPath}'` }] }],
    },
  })
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
  /** After the Stop hook fires, how long to keep confirming the transcript has gone quiet before trusting it's really done. */
  postStopQuietMs?: number
  /** Hard cap on the post-Stop confirmation window. */
  postStopMaxMs?: number
  /** How long with no transcript growth before checking the pane for a pending interactive dialog (permission prompt, etc.) — shorter than quietMs since this is just "is the CLI blocked on input", not "is the turn over". */
  dialogCheckMs?: number
  /**
   * How long with no transcript growth before treating the pane as "stuck"
   * for onStuckPane purposes — deliberately much longer than dialogCheckMs.
   * dialogCheckMs only governs how often we bother looking at the pane at
   * all (cheap, and needs to be short so a real permission prompt is caught
   * promptly); this is the actual "is anything actually wrong" threshold.
   * A normal tool call routinely takes several seconds to tens of seconds
   * with zero transcript growth in between — using dialogCheckMs for this
   * too would screenshot the chat on nearly every ordinary reply.
   */
  stuckPaneCheckMs?: number
}

export class TmuxClaudeManager {
  private readonly dbg: (msg: string) => void
  private readonly cols: number
  private readonly rows: number
  private readonly startupTimeoutMs: number
  private readonly quietMs: number
  private readonly replyTimeoutMs: number
  private readonly postStopQuietMs: number
  private readonly postStopMaxMs: number
  private readonly dialogCheckMs: number
  private readonly stuckPaneCheckMs: number
  /** Workdirs we've confirmed a live tmux session for, to skip a has-session round-trip on every message. */
  private knownAlive = new Set<string>()
  /** workdir -> the --session-id we spawned `claude` with, so we can tail its exact transcript file instead of guessing by mtime. Lost on router restart. */
  private sessionIds = new Map<string, string>()
  /** workdir -> tail of the in-flight sendAndAwaitReply call, so a second message for the same workdir queues instead of racing the first one on the same tmux pane/transcript. */
  private queues = new Map<string, Promise<unknown>>()
  /** workdir -> last time a message was sent to it, for killIdleSessions(). */
  private lastUsedAt = new Map<string, number>()

  constructor(opts: TmuxClaudeManagerOptions = {}) {
    this.dbg = opts.dbg ?? (() => {})
    this.cols = opts.cols ?? 220
    this.rows = opts.rows ?? 50
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 20_000
    this.quietMs = opts.quietMs ?? 2_500
    this.replyTimeoutMs = opts.replyTimeoutMs ?? 10 * 60 * 1000
    this.postStopQuietMs = opts.postStopQuietMs ?? 800
    this.postStopMaxMs = opts.postStopMaxMs ?? 8_000
    this.dialogCheckMs = opts.dialogCheckMs ?? 1_500
    this.stuckPaneCheckMs = opts.stuckPaneCheckMs ?? 20_000
  }

  private async hasSession(name: string): Promise<boolean> {
    const r = await runTmux(['has-session', '-t', name])
    return r.ok
  }

  /** `-e` keeps SGR color/style escape codes — needed for onStuckPane's screenshot; parseDialogOptions strips them back out via stripAnsi() before its own layout-based parsing. */
  private async capturePane(name: string): Promise<string> {
    const r = await runTmux(['capture-pane', '-e', '-p', '-t', name])
    return r.ok ? r.stdout : ''
  }

  /** Send a bare Escape keypress — dismisses whatever modal/dialog is currently showing (a `/status`-style panel, a stuck confirmation, etc.), same as a person pressing Esc at the terminal. No-op if there's no live session. */
  async sendEscape(workdir: string): Promise<void> {
    const name = sessionNameFor(workdir)
    if (!(await this.hasSession(name))) return
    await runTmux(['send-keys', '-t', name, 'Escape'])
  }

  /** Kill and respawn the session for this workdir — a fresh `claude` process with a new session id (and conversation history, from the CLI's own perspective). */
  async restartSession(workdir: string, model?: string): Promise<string> {
    await this.killSession(workdir)
    return this.ensureSession(workdir, model)
  }

  /** Select option `number` from a currently-showing dialog (see parseDialogOptions) by typing the digit and pressing Enter — same as a person navigating the menu and confirming. */
  private async selectDialogOption(name: string, option: DialogOption): Promise<void> {
    await runTmux(['send-keys', '-t', name, '-l', option.number])
    await runTmux(['send-keys', '-t', name, 'Enter'])
  }

  /**
   * Ensure a tmux session running `claude` exists for this workdir; spawns
   * one if missing. Returns the session name. `model` (e.g. "fable", "opus",
   * "sonnet", or a full model name) is only used on a fresh spawn — it has
   * no effect on an already-running session, and an empty/undefined value
   * just lets the CLI use its own default.
   */
  async ensureSession(workdir: string, model?: string): Promise<string> {
    const name = sessionNameFor(workdir)
    if (this.knownAlive.has(workdir) && await this.hasSession(name)) return name

    if (await this.hasSession(name)) {
      this.knownAlive.add(workdir)
      return name
    }

    this.dbg(`tmux: no live session for ${workdir}, spawning ${name}${model ? ` (model: ${model})` : ''}`)
    mkdirSync(STOP_SIGNAL_DIR, { recursive: true })
    const spawnStartMs = Date.now()
    const sessionId = randomUUID()
    const spawn = await runTmux([
      'new-session', '-d', '-s', name, '-c', workdir, '-x', String(this.cols), '-y', String(this.rows),
      CLAUDE_BIN, '--session-id', sessionId, '--settings', buildSettingsOverride(sessionId),
      ...(model ? ['--model', model] : []),
    ])
    if (!spawn.ok) throw new Error(`tmux new-session failed: ${spawn.stderr || spawn.stdout}`)
    this.sessionIds.set(workdir, sessionId)

    await this.waitForStartup(name, spawnStartMs)
    this.knownAlive.add(workdir)
    return name
  }

  /**
   * Wait for the CLI to finish booting before we type into it, by polling
   * the pane for its input-box prompt character. NOT the transcript file:
   * Claude Code doesn't create the session's .jsonl until the first message
   * is actually sent, so waiting on it here would always burn the full
   * timeout on every fresh session (found by testing this against a real
   * CLI — the prompt shows up within ~500ms, well before any transcript
   * file exists).
   */
  private async waitForStartup(name: string, spawnStartMs: number): Promise<void> {
    const deadline = spawnStartMs + this.startupTimeoutMs
    while (Date.now() < deadline) {
      const r = await runTmux(['capture-pane', '-p', '-t', name])
      if (r.ok && r.stdout.includes('❯')) return
      await new Promise(res => setTimeout(res, 200))
    }
    this.dbg(`tmux: startup wait timed out for session ${name}, proceeding anyway`)
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
  async sendAndAwaitReply(workdir: string, text: string, opts: SendAndAwaitReplyOptions = {}): Promise<string> {
    const previous = this.queues.get(workdir) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(() => this.doSendAndAwaitReply(workdir, text, opts))
    this.queues.set(workdir, task)
    return task
  }

  private async doSendAndAwaitReply(workdir: string, text: string, opts: SendAndAwaitReplyOptions): Promise<string> {
    const { model, onDialog, onStuckPane } = opts
    this.lastUsedAt.set(workdir, Date.now())
    const name = await this.ensureSession(workdir, model)
    const sessionId = this.sessionIds.get(workdir)
    const beforeSendMs = Date.now()
    const transcriptBefore = sessionId ? transcriptPathForSession(workdir, sessionId) : findLatestTranscript(workdir)
    const startOffset = transcriptBefore && existsSync(transcriptBefore) ? statSync(transcriptBefore).size : 0
    // Primary completion signal (see buildSettingsOverride); falls back to the
    // quiet-period heuristic below when we don't have a sessionId to watch
    // (e.g. this tmux session outlived a router restart).
    const signalPath = sessionId ? stopSignalPathFor(sessionId) : null
    const baselineStopMs = signalPath && existsSync(signalPath) ? statSync(signalPath).mtimeMs : 0

    await this.sendKeys(name, text)
    // Everything above this line either throws (ensureSession/sendKeys failing
    // — the message never reached the CLI, so it's provably safe for a caller
    // to fall back to another backend) or succeeds (the message IS now
    // delivered). Everything below must never throw past this point: once
    // delivery has happened, a caller falling back to e.g. OpenCode on a
    // later error here would risk running the same task twice. Any
    // unexpected failure while waiting for the reply is swallowed and
    // whatever text was collected so far (possibly none) is returned instead.
    try {
      return await this.collectReply(workdir, sessionId, beforeSendMs, transcriptBefore, startOffset, signalPath, baselineStopMs, onDialog, onStuckPane)
    } catch (e) {
      this.dbg(`tmux: error while waiting for ${workdir}'s reply (message was already delivered, not retryable): ${e}`)
      return ''
    }
  }

  private async collectReply(
    workdir: string, sessionId: string | undefined, beforeSendMs: number,
    transcriptBefore: string | null, startOffset: number, signalPath: string | null, baselineStopMs: number,
    onDialog?: DialogHandler, onStuckPane?: StuckPaneHandler,
  ): Promise<string> {
    let deadline = beforeSendMs + this.replyTimeoutMs
    let lastChangeMs = Date.now()
    let lastDialogCheckMs = Date.now()
    let stuckPaneNotified = false
    let lastSize = startOffset
    let transcriptPath = transcriptBefore
    const collected: string[] = []

    // Read as a Buffer and slice by byte offset, not by string index: lastSize/size
    // come from statSync().size (bytes), but a JS string index counts UTF-16 code
    // units — any multi-byte character before the offset (e.g. CJK text, which this
    // very code sends when attachments are present) would desync the two and cut
    // the new slice mid-character. Returns true if anything new was read.
    //
    // Only consumes up to the last newline in the new bytes, not the whole
    // chunk: a poll can land mid-write of the CLI's trailing JSONL line, and
    // advancing lastSize past that partial line would permanently lose it —
    // the next poll's "new bytes" would start after it instead of including
    // its now-completed remainder.
    const readGrowth = (): boolean => {
      if (!transcriptPath) transcriptPath = sessionId ? transcriptPathForSession(workdir, sessionId) : findLatestTranscript(workdir, beforeSendMs)
      if (!transcriptPath || !existsSync(transcriptPath)) return false
      const buf = readFileSync(transcriptPath)
      if (buf.length <= lastSize) return false
      const newBytes = buf.subarray(lastSize)
      const lastNewline = newBytes.lastIndexOf(0x0a)
      if (lastNewline === -1) return false
      const completeChunk = newBytes.subarray(0, lastNewline + 1)
      collected.push(...parseAssistantTextLines(completeChunk.toString('utf8').split('\n')))
      lastSize += completeChunk.length
      lastChangeMs = Date.now()
      stuckPaneNotified = false  // real progress — any earlier "stuck" episode is over
      return true
    }

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 400))
      if (readGrowth()) continue
      const stopFired = !!signalPath && existsSync(signalPath) && statSync(signalPath).mtimeMs > baselineStopMs
      if (stopFired) {
        // The Stop hook can fire before the final transcript line(s) are
        // flushed to disk — found by testing: with only a fixed grace delay
        // here, the last assistant message sometimes showed up as "new
        // growth" on the *next* call instead of this one, especially when
        // other Stop hooks in the same chain are still running. So instead
        // of trusting one delayed read, keep reading until growth itself
        // goes quiet for a (short) beat, capped at POST_STOP_MAX_MS.
        const postStopDeadline = Date.now() + this.postStopMaxMs
        let lastGrowthMs = Date.now()
        while (Date.now() < postStopDeadline) {
          await new Promise(r => setTimeout(r, 300))
          if (readGrowth()) { lastGrowthMs = Date.now(); continue }
          if (isQuietDone(lastGrowthMs, Date.now(), this.postStopQuietMs)) break
        }
        break
      }
      // Quiet-period fallback is for when we have no Stop-hook signal to
      // watch at all (signalPath === null, e.g. a tmux session that outlived
      // a router restart) — not a general "give up early" escape hatch.
      // Gating it behind signalPath matters: otherwise a turn with a short
      // text preamble followed by a long-running tool call (quiet for more
      // than quietMs before the tool produces output) would get cut off
      // after just the preamble, well before the real Stop hook fires.
      if (!signalPath && collected.length > 0 && isQuietDone(lastChangeMs, Date.now(), this.quietMs)) break

      // No growth and no Stop — the CLI might just be mid-tool-call with
      // nothing to write yet, OR it might be blocked on a permission prompt
      // waiting for a keypress this code never sends. dialogCheckMs is much
      // shorter than quietMs/replyTimeoutMs specifically to catch the latter
      // promptly instead of burning the whole reply-timeout on it.
      if ((onDialog || onStuckPane) && isQuietDone(lastDialogCheckMs, Date.now(), this.dialogCheckMs)) {
        lastDialogCheckMs = Date.now()
        const name = sessionNameFor(workdir)
        const rawPane = await this.capturePane(name)
        const dialog = onDialog ? parseDialogOptions(stripAnsi(rawPane)) : null
        if (dialog && onDialog) {
          this.dbg(`tmux: ${workdir} is showing a dialog ("${dialog.question}"), asking caller for a choice`)
          // Keep this workdir looking "in use" for the whole wait — it's
          // paced by a human clicking a Feishu card, not by anything this
          // loop controls, so killIdleSessions must not reap the session
          // out from under an answer that's about to arrive.
          this.lastUsedAt.set(workdir, Date.now())
          const chosenNumber = await onDialog(dialog)
          this.lastUsedAt.set(workdir, Date.now())
          if (chosenNumber === DIALOG_ESCAPE_CHOICE) {
            if (await this.hasSession(name)) await runTmux(['send-keys', '-t', name, 'Escape'])
            deadline = Date.now() + this.replyTimeoutMs
            lastChangeMs = Date.now()
            continue
          }
          const option = dialog.options.find(o => Number(o.number) === chosenNumber)
          if (!option) {
            // No match — either the caller explicitly cancelled (e.g. /restart
            // or /esc invalidating a stale dialog, see router.ts) or something
            // genuinely unexpected happened. Either way, guessing an option
            // (the previous behavior defaulted to options[0], effectively
            // auto-picking "Yes" on an unanswered permission prompt) is worse
            // than just giving up on this reply.
            this.dbg(`tmux: dialog choice for ${workdir} didn't resolve to a real option (cancelled or invalid) — not sending a keystroke`)
            break
          }
          if (!(await this.hasSession(name))) {
            // The session this dialog belonged to is gone (e.g. restarted
            // while the card was still pending) — sending the chosen digit
            // now would hit a different, unrelated session under the same
            // name. router.ts is expected to have already cancelled this
            // dialog in that case, but check directly too rather than rely
            // solely on that.
            this.dbg(`tmux: ${workdir}'s session is gone by the time a dialog choice came back — not sending a keystroke`)
            break
          }
          await this.selectDialogOption(name, option)
          // The user's click can take any amount of time — don't let that
          // count against the reply deadline, and give the chosen action a
          // fresh window to actually run and produce output.
          deadline = Date.now() + this.replyTimeoutMs
          lastChangeMs = Date.now()
        } else if (onStuckPane && !stuckPaneNotified && isQuietDone(lastChangeMs, Date.now(), this.stuckPaneCheckMs)) {
          // Not a dialog we know how to act on (or no onDialog configured at
          // all) — just hand the raw pane to the caller once per stuck
          // episode. Purely informational: this code doesn't wait for or
          // act on anything afterward, so it can't deadlock the way an
          // unanswered dialog could.
          stuckPaneNotified = true
          try { await onStuckPane(rawPane) } catch (e) { this.dbg(`tmux: onStuckPane failed for ${workdir}: ${e}`) }
        }
      }
    }

    return collected.join('\n\n')
  }

  async killSession(workdir: string): Promise<void> {
    const name = sessionNameFor(workdir)
    this.knownAlive.delete(workdir)
    this.sessionIds.delete(workdir)
    this.lastUsedAt.delete(workdir)
    await runTmux(['kill-session', '-t', name])
  }

  /**
   * Kill tmux sessions idle for at least `idleMs`. Unlike the socket-worker
   * mode (whose Claude Code process exits and takes the worker down with
   * it), a tmux session just sits there forever with nothing to notice it's
   * unused — callers should run this on an interval.
   */
  async killIdleSessions(idleMs: number): Promise<void> {
    const now = Date.now()
    for (const [workdir, lastUsed] of this.lastUsedAt) {
      if (now - lastUsed >= idleMs) {
        this.dbg(`tmux: ${workdir} idle for ${Math.round((now - lastUsed) / 1000)}s, killing session`)
        await this.killSession(workdir)
      }
    }
  }
}
