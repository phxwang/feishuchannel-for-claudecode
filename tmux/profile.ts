/**
 * A CLI profile tells the generic tmux manager (tmux/manager.ts) everything
 * that differs between the interactive CLIs it can host — how to spawn it,
 * where its transcript lives and how to read it, how its turn-completion
 * signal works, and how its menus look and are answered. Everything else
 * (tmux plumbing, the reply-collection loop, dialog/stuck-pane callbacks,
 * idle reaping) is shared.
 */
import { existsSync } from 'fs'
import type { BackgroundWait } from '../background-tasks'
import type { GoalSignal } from './goal'
import type { Dialog, DialogOption } from './dialog'

export type TmuxCliKind = 'claude' | 'agy' | 'codex'

export interface ProgressEvent { tool: string; summary: string }

/** Spawn-time knobs. Unset = the CLI's own default. */
export interface SpawnOptions {
  model?: string
  effort?: string
  permissionMode?: string
  /** Sandbox policy for CLIs that have one (Codex `-s`: 'read-only' | 'workspace-write'). */
  sandbox?: string
}

export interface SpawnPlan {
  argv: string[]
  env: Record<string, string>
  /** Known up front (Claude's --session-id); undefined when the CLI only reveals it later (agy, see discoverSessionId). */
  sessionId?: string
}

export interface StopOutcome {
  wait: BackgroundWait
  /** The user input whose turn just ended, when the CLI reports it (agy). Used to hand a queued message's turn to the right caller. */
  lastUserInput?: string
  /** Conversation id reported by the stop signal, if any. */
  conversationId?: string
  /** Error text the CLI attached to the stop (e.g. a quota error), if any. */
  error?: string
  /** The CLI's machine-readable error category for `error` (Claude: "verification_required", "rate_limit" …), if it gives one. */
  errorCode?: string
}

export interface StopContext {
  workdir: string
  sessionName: string
  transcriptPath: string | null
  /** Plain-text (ANSI-stripped) pane capture taken right after the stop. */
  plainPane: string
}

export interface TmuxCliProfile {
  readonly kind: TmuxCliKind
  /** Human-facing name used in debug logs and default dialog questions. */
  readonly label: string
  /**
   * What happens to a message sent while a turn is in flight.
   * 'absorb': the CLI folds it into the running turn (Claude Code) — the
   * caller's call resolves with the in-flight result.
   * 'queue': the CLI runs it as its own next turn (agy) — the caller gets
   * its own result once that turn ends.
   */
  readonly midTurn: 'absorb' | 'queue'
  /** Whether a persisted session id should be reused (`--conversation`) when respawning after an idle kill or router restart. */
  readonly resumable: boolean
  readonly startupTimeoutMs?: number
  /**
   * Some slash commands (agy's `/model`, `/config` …) only open a local panel:
   * no turn, no transcript step, no stop signal. When set, a delivered
   * `/command` that never starts a turn is considered finished once the pane
   * has shown the ready marker continuously for this long. Omit for CLIs
   * whose local commands leave a transcript record (Claude Code) — those use
   * `isLocalCommandResult` instead.
   */
  readonly slashCommandIdleMs?: number

  /**
   * True if this transcript line is the result of a local-only slash command
   * (Claude Code's `<local-command-stdout>` record for `/model`, `/cost` …).
   * Such commands never fire the Stop hook, so a delivered `/command` whose
   * result has been recorded ends the wait once the transcript goes quiet.
   */
  isLocalCommandResult?(line: string): boolean

  sessionName(workdir: string): string
  /** Called right before spawning a fresh tmux session (e.g. to clear stale signal files). */
  prepareSpawn?(workdir: string): void
  planSpawn(workdir: string, opts: SpawnOptions, resumeId?: string): SpawnPlan
  /** True once the CLI has booted far enough to accept typed input. */
  isReady(plainPane: string): boolean

  transcriptPath(workdir: string, sessionId: string): string
  /** Degraded fallback when the session id is unknown; may return null if the CLI has no safe heuristic. */
  findLatestTranscript(workdir: string, sinceMs?: number): string | null
  /** Learn the live session id after spawn, for CLIs that don't accept one up front. */
  discoverSessionId?(workdir: string): string | undefined

  /** File whose mtime advancing means "a turn just ended"; null if unknown (falls back to a quiet-period heuristic). */
  stopSignalPath(workdir: string, sessionId: string | undefined): string | null
  afterStop(ctx: StopContext): StopOutcome

  /**
   * True if this transcript line is the start of a new user turn (agy's
   * USER_INPUT step). Lets a 'queue' profile attribute text to the right
   * queued caller even when the next turn starts before the previous turn's
   * stop has been fully processed. Omit for 'absorb' profiles.
   */
  isUserTurnStart?(line: string): boolean
  /**
   * True if this transcript line ends the current turn (Codex's
   * `task_complete` / `turn_aborted` records). Treated exactly like the stop
   * signal firing, for CLIs whose own turn-end hook misses some endings
   * (Codex's `notify` never fires for failed or interrupted turns). A
   * profile that sets this also opts out of the quiet-period fallback.
   */
  isTurnEnd?(line: string): boolean
  /**
   * True if this transcript line records that the user interrupted the turn
   * (Claude Code's `[Request interrupted by user]`). An interrupt fires no
   * Stop hook, so without this the reply wait would run to its deadline. It
   * ends the wait at once ('interrupted'), without waiting on background
   * work: the turn was stopped on purpose.
   */
  isInterrupt?(line: string): boolean
  /**
   * Classify a transcript line as a native `/goal` record (see tmux/goal.ts),
   * or null. A profile that sets this supports native goals: while a goal is
   * active a Stop does not end the reply; the goal's verdict does.
   */
  parseGoalSignal?(line: string): GoalSignal | null
  parseText(lines: string[]): string[]
  parseProgress(lines: string[]): ProgressEvent[]
  parseDialog(plainPane: string): Dialog | null
  /** tmux `send-keys` argument lists (each sent in order) that pick `option` from a 'numbered' dialog. */
  optionKeys(option: DialogOption): string[][]
}

/** Resolve a CLI binary once: PATH first, then common install locations (a launchd PATH often lacks ~/.local/bin). */
export function resolveBin(name: string, candidates: string[]): string {
  const viaPath = Bun.which(name)
  if (viaPath) return viaPath
  for (const c of candidates) if (existsSync(c)) return c
  return name  // let tmux surface a clear "command not found" if truly missing
}
