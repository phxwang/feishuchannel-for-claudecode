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
import type { Dialog, DialogOption } from './dialog'

export type TmuxCliKind = 'claude' | 'agy'

export interface ProgressEvent { tool: string; summary: string }

/** Spawn-time knobs. Unset = the CLI's own default. */
export interface SpawnOptions {
  model?: string
  effort?: string
  permissionMode?: string
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

  /** tmux session name for a session key (the workdir for chat; see TmuxCliManager.ensureSession's sessionKey). */
  sessionName(workdir: string): string
  /** Called right before spawning a fresh tmux session (e.g. to clear stale signal files). Receives the session key. */
  prepareSpawn?(workdir: string): void
  /** `workdir` is the start directory; `sessionKey` (default = workdir) is what per-session state like signal dirs is keyed by. */
  planSpawn(workdir: string, opts: SpawnOptions, resumeId?: string, sessionKey?: string): SpawnPlan
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
