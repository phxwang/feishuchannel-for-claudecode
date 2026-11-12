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
  subtype?: string
  content?: unknown
  message?: { role?: string; content?: unknown }
}

/**
 * Pulls the text out of a `<local-command-stdout>...</local-command-stdout>`
 * (or `-stderr`) wrapper, or null if `value` isn't a string containing one.
 * The closing tag is a backreference to the opener, not matched
 * independently — otherwise a malformed/interleaved
 * `<local-command-stdout>...</local-command-stderr>` would still match and
 * get extracted as one blob instead of being rejected.
 */
const LOCAL_COMMAND_OUTPUT_RE = /<local-command-(std(?:out|err))>([\s\S]*?)<\/local-command-\1>/
function extractLocalCommandOutput(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = value.match(LOCAL_COMMAND_OUTPUT_RE)
  return m ? m[2].trim() || null : null
}

/**
 * Extract plain reply text from raw JSONL transcript lines. Lines that
 * aren't valid JSON or carry no text content (e.g. a pure tool_use turn)
 * are skipped rather than throwing — a transcript is append-only but a
 * partially-written last line while the CLI is still flushing is expected,
 * not an error.
 *
 * Besides real assistant turns, also surfaces a slash command's own output
 * when it resolves with nothing to pick (e.g. a repeat `/model` when the
 * model is already set just prints "Kept model as X") — found live that
 * this never produces a real assistant turn or a Stop-hook signal at all,
 * so without this, sendAndAwaitReply would sit polling for the full
 * replyTimeoutMs (8 hours by default) even though the CLI already
 * answered on screen. This is recorded in the transcript as either a
 * `type: 'system', subtype: 'local_command'` line (content at the top
 * level) or, in an older/different CLI build, a `type: 'user'` line
 * wrapping the same `<local-command-stdout>` tag in message.content — never
 * matched for an ordinary `type: 'user'` line with the user's own plain
 * text, since that never contains the wrapper tag.
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

export interface ProgressEvent { tool: string; summary: string }

/** Tool-input fields worth surfacing as a one-line progress summary, tried in this order; the first string value found wins. Deliberately short-circuits on common built-in-tool shapes rather than trying to be exhaustive. */
const PROGRESS_SUMMARY_FIELDS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description']
const PROGRESS_SUMMARY_MAX_LEN = 80

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  for (const key of PROGRESS_SUMMARY_FIELDS) {
    const v = obj[key]
    if (typeof v === 'string' && v) {
      return v.length > PROGRESS_SUMMARY_MAX_LEN ? v.slice(0, PROGRESS_SUMMARY_MAX_LEN) + '…' : v
    }
  }
  return ''
}

/**
 * Pulls tool_use blocks out of raw JSONL transcript lines — the only
 * "something is happening" signal available before a turn finishes, since
 * Claude Code writes whole content blocks, not token-level deltas, to the
 * transcript. Used to drive a live "thinking…" status card; deliberately
 * only surfaces the tool name plus a short, truncated summary of one input
 * field, never the raw input object, so a large file write or command
 * doesn't get dumped onto a status card visible to the whole chat.
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

/** True once `quietMs` have passed since the transcript last grew — our proxy for "turn finished". */
export function isQuietDone(lastChangeAtMs: number, nowMs: number, quietMs: number): boolean {
  return nowMs - lastChangeAtMs >= quietMs
}

export interface DialogOption { number: string; label: string }
export interface Dialog {
  /** 'numbered': a real choice menu, option N is selected by typing N + Enter. 'tabs': a tab bar with no numbered jump target — option N is reached by (N - currentNumber) Right presses (wrapping circularly) from the known current tab. */
  kind: 'numbered' | 'tabs'
  question: string
  options: DialogOption[]
  /** `kind: 'tabs'` only: the tab believed to currently be focused — `'1'` (leftmost) on first detection, since the CLI gives no plain-text signal of which tab is actually open; updated to whichever tab was last switched to for every subsequent card in the same switching session (see collectReply), so repeated switches are relative to the real last click instead of re-assuming leftmost each time. */
  currentNumber?: string
}
/**
 * Given the parsed dialog, resolve with the chosen option's number (as sent
 * back to the pane), `DIALOG_ESCAPE_CHOICE` for a caller-side "just press
 * Escape instead" button (e.g. router.ts adds one to every card so there's
 * always a safe way out, including for dialogs this code can detect but
 * can't map to a clean single keystroke), or `DIALOG_TIMED_OUT_CHOICE` if
 * nobody answered at all. Any other value is treated as an explicit
 * cancellation (e.g. router.ts's `/esc`/`/restart` invalidating a stale
 * dialog, which already resolved the matter its own way) — see collectReply
 * for why that case alone does *not* get an automatic Escape.
 */
export type DialogHandler = (dialog: Dialog) => Promise<number>
export const DIALOG_ESCAPE_CHOICE = 0
/** Resolve a DialogHandler with this when nobody answered the card before its own timeout, as opposed to an explicit /esc or /restart cancellation (any other non-matching number) — only this value gets collectReply to send a real Escape keystroke on the caller's behalf, since unlike that cancellation case, nothing else is going to clean up the open menu. */
export const DIALOG_TIMED_OUT_CHOICE = -1
/** Called (at most once per stuck episode) with the raw ANSI pane text when the session is blocked on something that isn't a parseable dialog — e.g. a `/status`-style panel. Purely informational: the caller decides what to do with it (render+send a screenshot, etc.); this code takes no further action afterward. */
export type StuckPaneHandler = (paneAnsiText: string) => Promise<void>
/** Called with the raw ANSI pane text right after a `kind: 'tabs'` choice's Right-key presses land — since the chosen tab can't be confirmed from plain-text parsing (see parseTabBar's "assumed leftmost tab" caveat), the caller is expected to render and send a screenshot so the user can see which tab was actually reached. Purely informational, like StuckPaneHandler; the next dialog card (offering the same tab choices again) is sent automatically afterward once the still-visible tab bar is re-detected on the next poll. */
export type TabSwitchedHandler = (paneAnsiText: string) => Promise<void>
/** Called synchronously with newly-seen tool_use events as soon as they're parsed off the transcript — fire-and-forget, so this must not throw or block; the caller is expected to just update its own in-memory state and let its own throttle/timer decide when (and whether) to actually act on it (e.g. patching a status card), not do network I/O here on every single call. */
export type ProgressHandler = (events: ProgressEvent[]) => void
export interface BackgroundFollowupUpdate {
  /** How many background shells the CLI's own footer still reports running, as of this update. 0 only ever appears on the final, `done: true` update. */
  runningShells: number
  /** New assistant text collected since the primary reply (or the previous update, whichever was more recent) — empty when this update is reporting only a shell-count change with no new text yet. */
  extraText: string
  /** True once watching has ended, either because a later Stop fired with the CLI reporting zero shells left (the real end — see `giveUp`), or because watching was abandoned. */
  done: boolean
  /** Only meaningful when `done` is true. Unset/false: a Stop genuinely reported zero shells left. True: watching was abandoned instead — the overall ceiling (replyTimeoutMs) elapsed, or an unexpected error — while the CLI may still be working; callers should say so rather than reporting this as a real completion. */
  giveUp?: boolean
}
/** See `doSendAndAwaitReply`'s watchBackgroundContinuation: called after the primary reply, for as long as the CLI keeps auto-continuing into further turns on its own (a background shell finishing). Fire-and-forget, like ProgressHandler — must not throw or block. */
export type BackgroundFollowupHandler = (update: BackgroundFollowupUpdate) => void
export interface SendAndAwaitReplyOptions {
  model?: string
  onDialog?: DialogHandler
  onStuckPane?: StuckPaneHandler
  onTabSwitched?: TabSwitchedHandler
  onProgress?: ProgressHandler
  onBackgroundFollowup?: BackgroundFollowupHandler
  /**
   * Called synchronously, before delivery, if this call is being absorbed
   * into an already-in-flight turn for the same workdir instead of starting
   * its own — see `sendAndAwaitReply`. The caller can use this to finalize
   * its own status card without a duplicate reply, since the in-flight
   * call's eventual result already answers this message too.
   */
  onAbsorbed?: () => void
}

const OPTION_LINE_RE = /^\s*(?:❯\s*)?(\d+)\.\s+(.+?)\s*$/
const DIVIDER_LINE_RE = /^[\s─╌│]*$/
/** A line that's known decoration rather than further prompt content when it trails an option block — a collapsed-submenu marker (e.g. /model's "▸ More models") or an effort/mode indicator (e.g. "◐ Medium effort (default) ←/→ to adjust"). Narrow on purpose: this only has to cover known real panels, not every possible glyph. */
const TRAILING_DECORATION_RE = /^\s*[▸◐]/
/** An "Esc to <verb>" footer hint, case-insensitively (parseTabBar's own "Esc to cancel", or /model's "Enter to set as default · s to use this session only · Esc to cancel") — narrower than matching the bare word "esc" anywhere, which could otherwise wrongly tolerate ordinary reply text that happens to mention "esc" in some other context (e.g. discussing the key itself) after an option block. */
const ESC_HINT_RE = /\besc\s+to\s+\w+/i
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
 * Tolerates a wrapped description line under an option (indented prose,
 * no leading digit), a divider, or a blank separator between options —
 * found live on Claude's own multi-question AskUserQuestion dialogs,
 * which interleave these between numbered options instead of keeping
 * them in one tight block; without this the scan stopped at the first
 * option's description and the whole dialog went unrecognized (no Feishu
 * card at all). Only tolerated when a further option continuing the
 * sequence actually follows, though — otherwise this is just ordinary
 * content trailing a *finished* numbered list (quoted text, a nested
 * bullet, a code block), which still has to clear the "last content in
 * the pane" check below like before.
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
      continue
    }
    if (firstOptionIdx === -1) continue  // option block hasn't started yet
    // Tolerate this filler line only if the *nearest* upcoming option-shaped
    // line (not just any later line) continues the sequence — bounded to
    // "the next thing that looks like an option" rather than scanning
    // arbitrarily far into the rest of the pane, which could otherwise
    // match unrelated later content (e.g. a numbered sentence in prose
    // after the dialog has already closed) and wrongly swallow real
    // trailing content as if it were still part of this block.
    const nextNumber = String(options.length + 1)
    const nextOptionLine = lines.slice(i + 1).find(l => OPTION_LINE_RE.test(l))
    if (nextOptionLine && nextOptionLine.match(OPTION_LINE_RE)![1] === nextNumber) continue
    break  // option block ended
  }
  if (options.length === 0) return null
  if (!options.every((o, idx) => o.number === String(idx + 1))) return null
  for (let i = lastOptionIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || TRAILING_DECORATION_RE.test(line) || ESC_HINT_RE.test(line)) continue
    return null  // something else follows — not the bottom of the screen
  }

  let question = ''
  for (let i = firstOptionIdx - 1; i >= 0; i--) {
    if (lines[i].trim() === '' || DIVIDER_LINE_RE.test(lines[i])) continue
    question = lines[i].trim()
    break
  }
  return { kind: 'numbered', question: question || 'Claude 需要你的输入', options }
}

const RUNNING_SHELL_RE = /(\d+)\s+shells?\b/i

/**
 * Reads the CLI's own "N shell(s) [still running]" footer indicator off the
 * last non-blank line of the pane — the same signal a human watching the
 * terminal would use to tell a background bash task is still going after
 * the turn's own Stop hook has already fired. Only checked on that last
 * line (mirroring parseTabBar's lastNonBlank scan) so this can't match the
 * phrase "shell" appearing incidentally in Claude's own finished reply text
 * sitting higher up in the pane. Returns 0 (not found == none running) when
 * the line doesn't match at all.
 */
export function parseRunningShellCount(paneText: string): number {
  const lines = paneText.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '') continue
    const m = lines[i].match(RUNNING_SHELL_RE)
    return m ? parseInt(m[1], 10) : 0
  }
  return 0
}

const TAB_BAR_RE = /^\s*[A-Z][\w-]*(?:\s{2,}[A-Z][\w-]*){1,}\s*$/
const ESC_TO_CANCEL_RE = /^\s*Esc to cancel\s*$/

/**
 * Detect a plain tab bar (e.g. `/status`'s "Settings  Status   Config   Usage   Stats")
 * with no numbered jump target. Since which tab is actually focused is
 * conveyed only by color/style — invisible to this plain-text capture, and
 * not something parseDialogOptions-style parsing can recover — navigation
 * here is necessarily an *assumption*, not a measured fact: option N is
 * reached by (N-1) Right presses from an assumed starting position of the
 * leftmost tab. If that assumption is wrong (the panel didn't actually open
 * on the leftmost tab), the result lands on the wrong tab; the user can
 * just ask again (a fresh screenshot/card) rather than this code trying to
 * track real state it fundamentally can't observe.
 *
 * Only fires when the pane's last non-blank line is literally "Esc to
 * cancel" — the same "last thing on screen" guard as parseDialogOptions,
 * adapted to this panel's own bottom marker (it has no numbered options to
 * anchor on instead).
 */
export function parseTabBar(paneText: string): Dialog | null {
  const lines = paneText.split('\n')
  let lastNonBlank = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') { lastNonBlank = i; break }
  }
  if (lastNonBlank === -1 || !ESC_TO_CANCEL_RE.test(lines[lastNonBlank])) return null

  for (const line of lines) {
    if (!TAB_BAR_RE.test(line)) continue
    const tabs = line.trim().split(/\s{2,}/)
    if (tabs.length < 2) continue
    return {
      kind: 'tabs',
      question: `切换到哪个标签页？（假设当前在第 1 个「${tabs[0]}」，可能不准）`,
      options: tabs.map((label, i) => ({ number: String(i + 1), label })),
      currentNumber: '1',
    }
  }
  return null
}

/** How many Right presses (there's no Left here) get from tab `from` to tab `to`, wrapping circularly through `numTabs` tabs — e.g. from '5' to '1' with 5 tabs is a single wrapping press, not 4 backward ones. */
export function rightPressesToReach(from: string, to: string, numTabs: number): number {
  const delta = (Number(to) - Number(from)) % numTabs
  return (delta + numTabs) % numTabs
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
  /**
   * Minimum gap between successive onStuckPane screenshots within the same
   * sendAndAwaitReply call. Without this, a task that legitimately runs for
   * many minutes (several tool calls, each separated by a quiet gap over
   * stuckPaneCheckMs) would get a screenshot every single time — reported
   * live as "too frequent" for long-running tasks. The cooldown is tracked
   * independently of transcript growth, so it still caps the rate even
   * across multiple distinct stuck episodes in one long reply.
   */
  stuckPaneCooldownMs?: number
  /**
   * Durable workdir -> tmux --session-id storage, so a router restart can
   * reattach to an already-running session's exact transcript file instead
   * of falling back to "most recently modified .jsonl in this workdir" —
   * ambiguous if the user ever has another Claude Code session open in the
   * same directory outside this tmux session. The tmux session itself is
   * unaffected by a router restart (tmux is a separate daemon); only this
   * manager's in-memory sessionIds map is lost, which this backs.
   */
  persistence?: {
    get(workdir: string): string | undefined
    set(workdir: string, sessionId: string): void
    delete(workdir: string): void
  }
}

export class TmuxClaudeManager {
  private readonly dbg: (msg: string) => void
  private readonly cols: number
  private readonly rows: number
  private readonly startupTimeoutMs: number
  private readonly quietMs: number
  private readonly replyTimeoutMs: number
  private readonly postStopQuietMs: number
  private readonly dialogCheckMs: number
  private readonly stuckPaneCheckMs: number
  private readonly stuckPaneCooldownMs: number
  private readonly persistence: TmuxClaudeManagerOptions['persistence']
  /** Workdirs we've confirmed a live tmux session for, to skip a has-session round-trip on every message. */
  private knownAlive = new Set<string>()
  /** workdir -> the --session-id we spawned `claude` with, so we can tail its exact transcript file instead of guessing by mtime. Lost from memory on router restart, but recovered from `persistence` (if configured) the next time ensureSession reattaches to an already-live session. */
  private sessionIds = new Map<string, string>()
  /** workdir -> the in-flight sendAndAwaitReply call, if any, so a second message for the same workdir gets absorbed into it instead of racing it with a second collectReply loop on the same tmux pane/transcript. Deleted once the call settles (i.e. once the *primary* reply is ready — see `watching` below for the extra window after that). */
  private queues = new Map<string, Promise<string>>()
  /** workdirs currently in the post-primary-reply watchBackgroundContinuation window (see doSendAndAwaitReply) — the primary reply already went out and `queues` no longer holds this workdir, but a second collectReply loop started now would race the watcher's own tailing of the same pane/transcript. isBusy()/sendAndAwaitReply treat this the same as `queues`: absorb into the ongoing watch instead. */
  private watching = new Set<string>()
  /** workdir -> last time a message was sent to it, for killIdleSessions(). */
  private lastUsedAt = new Map<string, number>()

  constructor(opts: TmuxClaudeManagerOptions = {}) {
    this.dbg = opts.dbg ?? (() => {})
    this.cols = opts.cols ?? 220
    this.rows = opts.rows ?? 50
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 20_000
    this.quietMs = opts.quietMs ?? 2_500
    // Raised 10min -> 60min -> 8h (2026-11-12): a single long-running tool
    // call, or a chain of self-continued turns watched by
    // watchBackgroundContinuation, can legitimately run for hours — this is
    // a last-resort ceiling against a genuinely stuck session, not the
    // expected wait time for an ordinary reply.
    this.replyTimeoutMs = opts.replyTimeoutMs ?? 8 * 60 * 60 * 1000
    this.postStopQuietMs = opts.postStopQuietMs ?? 800
    this.dialogCheckMs = opts.dialogCheckMs ?? 1_500
    this.stuckPaneCheckMs = opts.stuckPaneCheckMs ?? 90_000
    this.stuckPaneCooldownMs = opts.stuckPaneCooldownMs ?? 5 * 60_000
    this.persistence = opts.persistence
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

  /**
   * Captures the pane repeatedly until two consecutive captures come back
   * identical (the redraw has settled), instead of a single fixed delay —
   * found live that a fixed 300ms wasn't enough for a tab whose content
   * loads asynchronously (e.g. /status's Usage tab briefly shows "Loading
   * your Claude Code stats…"), so the tab-switch screenshot captured that
   * loading placeholder instead of the real content.
   *
   * `baseline`, when given, must also change before a match counts — without
   * it, if the redraw hasn't even started by the first poll (tmux hasn't
   * processed the keypress yet), two early identical captures of the
   * *pre-switch* content would look "stable" and get accepted instantly,
   * returning a stale screenshot instead of waiting for the real one. Pass
   * `undefined` when no visible change is actually expected (e.g. re-picking
   * the tab already showing) so this doesn't wait out the full maxWaitMs for
   * nothing.
   *
   * Gives up and returns whatever the last capture was after maxWaitMs,
   * rather than waiting forever for a tab that never finishes loading.
   *
   * Requires `requiredStableReads` consecutive matches, not just one pair —
   * a single coincidental match (e.g. two frames of an async loading
   * animation that happen to render identically) would otherwise risk
   * accepting a still-in-flight redraw as settled, the same class of bug
   * this whole function exists to avoid.
   */
  private async captureStablePane(
    name: string, baseline?: string, pollMs = 250, maxWaitMs = 4_000, requiredStableReads = 2,
  ): Promise<string> {
    const deadline = Date.now() + maxWaitMs
    let previous = await this.capturePane(name)
    let stableStreak = 0
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollMs))
      const current = await this.capturePane(name)
      if (current === previous && (baseline === undefined || current !== baseline)) {
        stableStreak++
        if (stableStreak >= requiredStableReads) return current
      } else {
        stableStreak = 0
      }
      previous = current
    }
    return previous
  }

  /** Send a bare Escape keypress — dismisses whatever modal/dialog is currently showing (a `/status`-style panel, a stuck confirmation, etc.), same as a person pressing Esc at the terminal. No-op if there's no live session. */
  async sendEscape(workdir: string): Promise<void> {
    const name = sessionNameFor(workdir)
    if (!(await this.hasSession(name))) return
    await runTmux(['send-keys', '-t', name, 'Escape'])
  }

  /**
   * Manual fallback for `/select <n>`: type the digit and press Enter,
   * same as clicking option `n` on a Feishu dialog card — for when a
   * pending dialog's layout isn't one `parseDialogOptions`/`parseTabBar`
   * recognizes yet, so no card ever got sent, but the dialog is still
   * genuinely there and a plain numbered selection is enough to answer it.
   * Returns false (without sending anything) if there's no live session,
   * so the caller can tell the user it didn't actually do anything instead
   * of reporting a false success.
   */
  async selectOption(workdir: string, number: string): Promise<boolean> {
    const name = sessionNameFor(workdir)
    if (!(await this.hasSession(name))) return false
    await this.selectDialogOption(name, { number, label: '' })
    return true
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
      // Reattaching after a router restart: this manager's own sessionIds
      // map was lost with the old process, but the tmux session (and the
      // --session-id it was spawned with) is still the same one — recover
      // it from persistence so transcript tailing targets the exact file
      // instead of falling back to the mtime heuristic.
      if (!this.sessionIds.has(workdir)) {
        const persisted = this.persistence?.get(workdir)
        if (persisted) {
          this.dbg(`tmux: reattached to ${workdir}'s live session, recovered session-id ${persisted} from persistence`)
          this.sessionIds.set(workdir, persisted)
        }
      }
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
    this.persistence?.set(workdir, sessionId)

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
   *
   * A message for a workdir that already has a reply in flight is NOT
   * queued to start its own turn after the first one finishes. Verified by
   * testing: Claude Code's own CLI absorbs a message typed while it's still
   * working into the *current* turn (surfaced to the model as a "user sent
   * a new message while you were working" system-reminder, same mechanism
   * a real interactive user typing mid-stream gets), rather than queuing it
   * as a separate next turn — so queuing it ourselves and sending it only
   * after the first turn ends would just delay delivery for no benefit.
   * Instead, send it straight into the pane now and resolve to the in-flight
   * call's eventual result, which already covers this message too.
   */
  /**
   * True if a `sendAndAwaitReply` call for this workdir is currently in
   * flight, i.e. a call made right now would be absorbed into it instead of
   * starting its own turn. Callers can use this to skip setting up per-call
   * UI (like a fresh "thinking" status card) for a message they can already
   * tell is about to be merged into the in-flight one — see router.ts's
   * handleClaudeTmuxTask. Advisory only: `sendAndAwaitReply` re-checks for
   * itself and is the source of truth, since the in-flight call can settle
   * in the gap between this check and that one.
   */
  isBusy(workdir: string): boolean {
    return this.queues.has(workdir) || this.watching.has(workdir)
  }

  async sendAndAwaitReply(workdir: string, text: string, opts: SendAndAwaitReplyOptions = {}): Promise<string> {
    const inFlight = this.queues.get(workdir)
    if (inFlight) {
      opts.onAbsorbed?.()
      await this.sendKeys(sessionNameFor(workdir), text)
      return inFlight
    }
    if (this.watching.has(workdir)) {
      // The primary reply for the call still watching this workdir already
      // went out — this message arrived during its post-reply
      // watchBackgroundContinuation window, so there's no live primary
      // promise left to piggyback on. Absorb it into the same ongoing pane
      // anyway (the CLI handles it exactly like any other mid-task message)
      // rather than starting a second collectReply loop that would race the
      // watcher's own tailing of the same pane/transcript. The resolved
      // value is never read by a caller that checked onAbsorbed fired.
      opts.onAbsorbed?.()
      await this.sendKeys(sessionNameFor(workdir), text)
      return ''
    }
    const task = this.doSendAndAwaitReply(workdir, text, opts)
    this.queues.set(workdir, task)
    task.finally(() => { if (this.queues.get(workdir) === task) this.queues.delete(workdir) })
    return task
  }

  private async doSendAndAwaitReply(workdir: string, text: string, opts: SendAndAwaitReplyOptions): Promise<string> {
    const { model, onDialog, onStuckPane, onTabSwitched, onProgress, onBackgroundFollowup } = opts
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
    let primary: string
    try {
      primary = await this.collectReply(workdir, sessionId, beforeSendMs, transcriptBefore, startOffset, signalPath, baselineStopMs, onDialog, onStuckPane, onTabSwitched, onProgress)
    } catch (e) {
      this.dbg(`tmux: error while waiting for ${workdir}'s reply (message was already delivered, not retryable): ${e}`)
      return ''
    }
    // Deliver the primary reply now (this function's return) without waiting
    // on the check below — onBackgroundFollowup exists precisely so the
    // caller doesn't have to hold the whole message open until every
    // self-continued round finishes (see router.ts's handleClaudeTmuxTask).
    if (onBackgroundFollowup) {
      // Same "never throw past primary delivery" rule as the collectReply
      // call above — a capturePane failure here (e.g. the session just
      // died) must not cost the caller the primary reply that's already
      // sitting in hand.
      try {
        const runningShells = parseRunningShellCount(stripAnsi(await this.capturePane(sessionNameFor(workdir))))
        if (runningShells > 0) {
          // Report this first sighting right away — a whole watch round
          // below can itself take a while, and the caller (router.ts) needs
          // this notification promptly to put up a follow-up card instead
          // of leaving the chat looking done until that round finishes.
          try { onBackgroundFollowup({ runningShells, extraText: '', done: false }) }
          catch (e) { this.dbg(`tmux: onBackgroundFollowup callback for ${workdir} threw: ${e}`) }
          this.watching.add(workdir)
          void this.watchBackgroundContinuation(workdir, sessionId, signalPath, onDialog, onStuckPane, onTabSwitched, onProgress, onBackgroundFollowup)
            .finally(() => this.watching.delete(workdir))
        }
      } catch (e) {
        this.dbg(`tmux: post-primary shell-count check for ${workdir} failed (primary reply unaffected): ${e}`)
      }
    }
    return primary
  }

  /**
   * Keeps watching after the primary reply already went out, for as long as
   * the CLI's own footer still reports a background shell running — it can
   * auto-continue into a fresh turn once one finishes (its own Stop, same
   * mechanism as a human watching a background task complete), which
   * `collectReply`'s single call already returned from and would otherwise
   * never see. Each round is a fresh, self-contained `collectReply` call
   * starting from the current transcript size/signal mtime rather than
   * threading extra state through that function — reuses its existing
   * dialog/stuck-pane/progress handling for free, since a background task
   * can just as easily hit a permission prompt as the primary turn could.
   * Fire-and-forget: reports each round via `onBackgroundFollowup` and never
   * throws (logs and gives up quietly on error, same as doSendAndAwaitReply
   * does for the primary call).
   */
  private async watchBackgroundContinuation(
    workdir: string, sessionId: string | undefined, signalPath: string | null,
    onDialog: DialogHandler | undefined, onStuckPane: StuckPaneHandler | undefined, onTabSwitched: TabSwitchedHandler | undefined,
    onProgress: ProgressHandler | undefined, onBackgroundFollowup: BackgroundFollowupHandler,
  ): Promise<void> {
    // Caps the WHOLE watch (every round combined) at replyTimeoutMs from
    // when watching started, not a fresh replyTimeoutMs re-armed on every
    // round — otherwise a shell count that never reaches 0 (a genuinely
    // hung background process, or parseRunningShellCount misreading the
    // pane) would keep this loop going indefinitely, each round getting
    // its own full hour, with nothing bounding the total. This is meant as
    // a last-resort ceiling against that, same spirit as replyTimeoutMs
    // itself for the primary call.
    const overallDeadline = Date.now() + this.replyTimeoutMs
    try {
      const name = sessionNameFor(workdir)
      while (true) {
        if (Date.now() >= overallDeadline) {
          this.dbg(`tmux: background-continuation watch for ${workdir} gave up — still reporting shells running after the full ${this.replyTimeoutMs}ms ceiling`)
          try { onBackgroundFollowup({ runningShells: 0, extraText: '', done: true, giveUp: true }) }
          catch (e) { this.dbg(`tmux: onBackgroundFollowup callback for ${workdir} threw: ${e}`) }
          return
        }
        this.lastUsedAt.set(workdir, Date.now())
        const transcriptPath = sessionId ? transcriptPathForSession(workdir, sessionId) : findLatestTranscript(workdir)
        const startOffset = transcriptPath && existsSync(transcriptPath) ? statSync(transcriptPath).size : 0
        const baselineStopMs = signalPath && existsSync(signalPath) ? statSync(signalPath).mtimeMs : 0
        // Gives this round whatever's left of the overall ceiling rather
        // than collectReply's usual fresh `this.replyTimeoutMs` — faking
        // beforeSendMs is the only lever collectReply exposes for that,
        // since it always computes its own deadline as beforeSendMs plus
        // the full replyTimeoutMs.
        const roundBeforeSendMs = overallDeadline - this.replyTimeoutMs
        const extraText = await this.collectReply(workdir, sessionId, roundBeforeSendMs, transcriptPath, startOffset, signalPath, baselineStopMs, onDialog, onStuckPane, onTabSwitched, onProgress)
        const runningShells = parseRunningShellCount(stripAnsi(await this.capturePane(name)))
        const done = runningShells === 0
        try { onBackgroundFollowup({ runningShells, extraText, done }) }
        catch (e) { this.dbg(`tmux: onBackgroundFollowup callback for ${workdir} threw: ${e}`) }
        if (done) return
      }
    } catch (e) {
      this.dbg(`tmux: background-continuation watch for ${workdir} failed: ${e}`)
      // Without this, a card already opened by a prior round's
      // onBackgroundFollowup call (see router.ts's handleClaudeTmuxTask)
      // never gets its matching close — the Feishu card would sit open
      // indefinitely with no one left to finalize it.
      try { onBackgroundFollowup({ runningShells: 0, extraText: '', done: true, giveUp: true }) }
      catch (e2) { this.dbg(`tmux: onBackgroundFollowup callback for ${workdir} threw: ${e2}`) }
    }
  }

  private async collectReply(
    workdir: string, sessionId: string | undefined, beforeSendMs: number,
    transcriptBefore: string | null, startOffset: number, signalPath: string | null, baselineStopMs: number,
    onDialog?: DialogHandler, onStuckPane?: StuckPaneHandler, onTabSwitched?: TabSwitchedHandler, onProgress?: ProgressHandler,
  ): Promise<string> {
    let deadline = beforeSendMs + this.replyTimeoutMs
    let lastChangeMs = Date.now()
    let lastDialogCheckMs = Date.now()
    // 0, not Date.now(), so the very first stuck episode of this call is
    // never suppressed by the cooldown (Date.now() - 0 is always >= it).
    let lastStuckNotifyMs = 0
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
      const newLines = completeChunk.toString('utf8').split('\n')
      collected.push(...parseAssistantTextLines(newLines))
      if (onProgress) {
        const events = parseProgressLines(newLines)
        if (events.length) { try { onProgress(events) } catch (e) { this.dbg(`tmux: onProgress callback for ${workdir} threw: ${e}`) } }
      }
      lastSize += completeChunk.length
      lastChangeMs = Date.now()
      return true
    }

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 400))
      // Refreshed on every poll tick, not just at message-send time: with
      // replyTimeoutMs now able to run up to an hour (and
      // watchBackgroundContinuation able to chain several such waits back
      // to back), a single long active wait could otherwise cross
      // killIdleSessions' own idle threshold and get reaped mid-task.
      this.lastUsedAt.set(workdir, Date.now())
      if (readGrowth()) continue
      const stopFired = !!signalPath && existsSync(signalPath) && statSync(signalPath).mtimeMs > baselineStopMs
      if (stopFired) {
        // The Stop hook can fire before the final transcript line(s) are
        // flushed to disk — found by testing: with only a fixed grace delay
        // here, the last assistant message sometimes showed up as "new
        // growth" on the *next* call instead of this one, especially when
        // other Stop hooks in the same chain are still running. So instead
        // of trusting one delayed read, keep reading until growth itself
        // goes quiet for a (short) beat. Deliberately uncapped beyond that
        // (other than the outer replyTimeoutMs via `deadline`): a turn can
        // keep writing to the transcript well past its own Stop hook (a
        // lingering background bash task, a subagent still finishing up),
        // and a short fixed cap here would stop forwarding that activity to
        // onProgress/the status card even though the CLI is still working.
        let lastGrowthMs = Date.now()
        while (Date.now() < deadline) {
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
        const plainPane = stripAnsi(rawPane)
        const dialog = onDialog ? (parseDialogOptions(plainPane) ?? parseTabBar(plainPane)) : null
        if (dialog && onDialog) {
          // For a `kind: 'tabs'` choice, re-offer the SAME card after each
          // switch instead of returning to the generic poll loop and hoping
          // it re-detects the still-visible tab bar on its own: found live
          // that re-detection is not reliable (a freshly-focused tab's exact
          // pane text doesn't always still match parseTabBar's shape), which
          // left the user with a screenshot but no way to switch again
          // without sending a brand new message. Looping here guarantees the
          // next card goes out regardless of what the pane now looks like.
          // Only a real option number keeps this loop going (a numbered
          // dialog's single selectDialogOption call, an Escape, or "no
          // matching option" all exit after one iteration).
          let currentDialog = dialog
          while (true) {
            this.dbg(`tmux: ${workdir} is showing a dialog ("${currentDialog.question}"), asking caller for a choice`)
            // Keep this workdir looking "in use" for the whole wait — it's
            // paced by a human clicking a Feishu card, not by anything this
            // loop controls, so killIdleSessions must not reap the session
            // out from under an answer that's about to arrive.
            this.lastUsedAt.set(workdir, Date.now())
            const chosenNumber = await onDialog(currentDialog)
            this.lastUsedAt.set(workdir, Date.now())
            if (chosenNumber === DIALOG_ESCAPE_CHOICE) {
              if (await this.hasSession(name)) await runTmux(['send-keys', '-t', name, 'Escape'])
              break
            }
            if (chosenNumber === DIALOG_TIMED_OUT_CHOICE) {
              // Nobody answered the card at all — unlike an explicit
              // /esc/`/restart` cancellation (which has already dealt with
              // the session its own way, see the fallthrough below), nothing
              // else is going to clean this up. Send the same Escape the
              // card's own 🚪 button would have, so the CLI isn't left
              // sitting on an open menu indefinitely, confusing whatever
              // message comes next.
              this.dbg(`tmux: dialog for ${workdir} timed out with no answer — sending Escape to close it`)
              if (await this.hasSession(name)) await runTmux(['send-keys', '-t', name, 'Escape'])
              return collected.join('\n\n')
            }
            const option = currentDialog.options.find(o => Number(o.number) === chosenNumber)
            if (!option) {
              // Any other non-matching value is an explicit cancellation
              // (e.g. /restart already killed/is killing the session, or
              // /esc already sent its own Escape directly) rather than a
              // timeout — something else already resolved this, so (as
              // before the Escape-on-timeout change above) guessing an
              // option here, or sending a redundant keystroke into whatever
              // the session is doing now, is worse than just giving up.
              this.dbg(`tmux: dialog choice for ${workdir} didn't resolve to a real option (cancelled) — not sending a keystroke`)
              // Ends the whole wait immediately, same as the outer poll loop
              // timing out — not just this inner loop, which would otherwise
              // fall through to the deadline reset below and keep polling a
              // session that has nothing more to say.
              return collected.join('\n\n')
            }
            if (!(await this.hasSession(name))) {
              // The session this dialog belonged to is gone (e.g. restarted
              // while the card was still pending) — sending the chosen digit
              // now would hit a different, unrelated session under the same
              // name. router.ts is expected to have already cancelled this
              // dialog in that case, but check directly too rather than rely
              // solely on that.
              this.dbg(`tmux: ${workdir}'s session is gone by the time a dialog choice came back — not sending a keystroke`)
              return collected.join('\n\n')
            }
            if (currentDialog.kind !== 'tabs') {
              await this.selectDialogOption(name, option)
              break
            }
            // No numbered jump target exists — reach the chosen tab by
            // pressing Right from the known current tab (wrapping circularly
            // if the target is "behind" it, since there's no Left here).
            // currentNumber starts at '1' (parseTabBar's leftmost assumption)
            // but is updated below to wherever we actually switched to, so a
            // second switch is relative to the real last click instead of
            // re-assuming leftmost every time.
            const rightPresses = rightPressesToReach(currentDialog.currentNumber ?? '1', option.number, currentDialog.options.length)
            // Captured before sending any keys, so captureStablePane can
            // tell "redraw hasn't started yet" (still equals this) apart
            // from "redraw has finished" (stable AND different) — only
            // meaningful when we're actually about to move (rightPresses >
            // 0); re-picking the already-current tab is a legitimate no-op
            // that should resolve as soon as the capture is merely stable.
            const beforeSwitch = onTabSwitched && rightPresses > 0 ? await this.capturePane(name) : undefined
            let sessionGone = false
            for (let i = 0; i < rightPresses; i++) {
              if (!(await this.hasSession(name))) {
                this.dbg(`tmux: ${workdir}'s session disappeared mid tab-navigation — stopping`)
                sessionGone = true
                break
              }
              await runTmux(['send-keys', '-t', name, 'Right'])
            }
            if (sessionGone) break
            if (onTabSwitched) {
              const rawPane = await this.captureStablePane(name, beforeSwitch)
              try { await onTabSwitched(rawPane) } catch (e) { this.dbg(`tmux: onTabSwitched callback for ${workdir} threw: ${e}`) }
            }
            // Loop back around and offer the same tab choices again — the
            // caller (router.ts) sends a fresh card and waits for another
            // click, same as the first time, but now marking the tab we
            // just switched to as current instead of the original leftmost
            // assumption.
            currentDialog = {
              ...currentDialog,
              question: `切换到哪个标签页？（当前在第 ${option.number} 个「${option.label}」）`,
              currentNumber: option.number,
            }
          }
          // The user's click(s) can take any amount of time — don't let that
          // count against the reply deadline, and give the chosen action a
          // fresh window to actually run and produce output.
          deadline = Date.now() + this.replyTimeoutMs
          lastChangeMs = Date.now()
        } else if (
          onStuckPane &&
          isQuietDone(lastChangeMs, Date.now(), this.stuckPaneCheckMs) &&
          isQuietDone(lastStuckNotifyMs, Date.now(), this.stuckPaneCooldownMs)
        ) {
          // Not a dialog we know how to act on (or no onDialog configured at
          // all) — just hand the raw pane to the caller, rate-limited by
          // stuckPaneCooldownMs so a long task with several genuine stuck
          // episodes doesn't get a screenshot for every single one.
          // Purely informational: this code doesn't wait for or act on
          // anything afterward, so it can't deadlock the way an unanswered
          // dialog could.
          lastStuckNotifyMs = Date.now()
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
    this.persistence?.delete(workdir)
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
