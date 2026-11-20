/**
 * Claude-via-tmux delivery mode — compatibility entry point.
 *
 * Keeps a real interactive `claude` CLI running in a detached tmux session
 * per workdir and feeds it messages as terminal keystrokes, instead of the
 * Unix-socket worker protocol (worker-link.ts / server.ts). Claude Code CLI
 * wraps channel-sourced messages received while busy in an "untrusted
 * external data" system reminder, which breaks confirm-card flows; terminal
 * keystrokes carry no such wrapper. Validated manually (2026-11-11).
 *
 * The implementation now lives in tmux/ and is shared with Antigravity
 * (agy): tmux/manager.ts (generic session + reply-collection loop),
 * tmux/dialog.ts (pane menu parsers), tmux/profiles/claude.ts (everything
 * Claude-specific). This module re-exports the original API so existing
 * imports keep working.
 */
import { TmuxCliManager, type TmuxManagerOptions } from './tmux/manager'
import { claudeProfile } from './tmux/profiles/claude'

export {
  parseDialogOptions, parseTabBar, parseCursorList, parseRunningShellCount, rightPressesToReach, stripAnsi,
  type Dialog, type DialogOption,
} from './tmux/dialog'
export {
  isQuietDone, DIALOG_ESCAPE_CHOICE, DIALOG_TIMED_OUT_CHOICE,
  type DialogHandler, type StuckPaneHandler, type TabSwitchedHandler, type ProgressHandler, type TextChunkHandler,
  type SendAndAwaitReplyOptions,
} from './tmux/manager'
export type { ProgressEvent } from './tmux/profile'
export {
  sessionNameFor, escapeWorkdirForTranscriptDir, parseAssistantTextLines, parseProgressLines,
  stopSignalPathFor, buildSettingsOverride, type TranscriptLine,
} from './tmux/profiles/claude'

/**
 * Claude Code's `/clear` (aliases `/reset`, `/new`) switches the CLI to a
 * brand-new transcript file and never fires a Stop hook for the turn that
 * sent it — typed into the pane as chat this stranded the reply wait (found
 * live in qttresearch). The router treats these as a session restart.
 */
const SESSION_RESET_COMMANDS = new Set(['/clear', '/reset', '/new'])
export function isSessionResetCommand(text: string): boolean {
  return SESSION_RESET_COMMANDS.has(text.trim().toLowerCase())
}

export type TmuxClaudeManagerOptions = TmuxManagerOptions

/** The Claude-profile tmux manager (original class name kept for callers). */
export class TmuxClaudeManager extends TmuxCliManager {
  constructor(opts: TmuxManagerOptions = {}) {
    super(claudeProfile, opts)
  }
}
