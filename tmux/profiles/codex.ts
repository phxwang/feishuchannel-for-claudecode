/**
 * Codex CLI (`codex`, the interactive TUI) profile for the tmux manager.
 *
 * Verified against codex-cli 0.169.1 (2026-11-22) by driving the real TUI in
 * tmux with an isolated CODEX_HOME and a local mock of the Responses API, so
 * no prompt ever reached a real model (see docs/codex-tmux-profile.md):
 *   - Spawn: `codex [resume <id>] -s <sandbox> -a <approval> [-m M]
 *     [-c model_reasoning_effort="E"] -c notify=[…] -c projects={"<workdir>"=
 *     {trust_level="trusted"}}`. The projects override skips the "Trust this
 *     folder?" screen for this session only. Nothing is written to
 *     config.toml. (The dotted form `-c projects."<path>".trust_level=…`
 *     does NOT work.)
 *   - Ready: the idle footer "? for shortcuts". That footer stays visible
 *     during a turn as well, so "esc to interrupt" (the working line) must be
 *     absent too.
 *   - Session id: no `--session-id`. The rollout file
 *     (sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl) appears on the
 *     first submitted message. `notify` reports the thread id after each
 *     completed turn, but also for Codex's internal title-generator threads,
 *     which never get a rollout. So a notified id counts only if its rollout
 *     exists and is an interactive session in this workdir.
 *   - Turn end: the rollout's `task_complete` / `turn_aborted` records (see
 *     TmuxCliProfile.isTurnEnd). `notify` is NOT a usable stop signal: it
 *     never fires for a failed turn (task_complete with `error`) or an
 *     interrupted one (turn_aborted), and the title thread's notify can
 *     land before the main one.
 *   - Hooks (`-c hooks={Stop=[…]}`) exist in 0.169 but need a persisted trust
 *     decision ("Hooks need review") or `--dangerously-bypass-hook-trust`, so
 *     they are not used.
 *   - Approval prompts: a numbered menu with a `›` cursor and the footer
 *     "Press enter to confirm or esc to cancel". A bare digit selects
 *     immediately, so no Enter is sent. `/model` is a numbered `›` picker
 *     with "enter select · esc back" and leaves no rollout record.
 *   - A message typed mid-turn is steered into the running turn ("Messages
 *     to be submitted after next tool call"). One turn and one task_complete
 *     cover both, so this profile is midTurn: 'absorb'.
 *   - `codex resume <id>` reopens the thread and appends to the same rollout,
 *     so the profile is resumable.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { parseDialogOptions, type Dialog, type DialogOption } from '../dialog'
import { resolveBin, type SpawnOptions, type SpawnPlan, type StopContext, type StopOutcome, type TmuxCliProfile } from '../profile'
import {
  findRollout, isCodexTurnEndLine, isCodexTurnStartLine, isOwnTuiSession, lastTurnEnd, parseCodexProgressLines,
  parseCodexTextLines, readSessionMeta, rolloutIdFromPath, rolloutsCreatedSince,
} from './codex-rollout'

const SIGNAL_ROOT = join(tmpdir(), 'feishu-codex-tmux')
/** Env var the router's notify bridge (codex-plugin/notify.sh) checks; unset = the bridge does nothing. */
export const CODEX_SIGNAL_ENV = 'FEISHU_CODEX_SIGNAL_DIR'
export const CODEX_NOTIFY_SCRIPT = join(import.meta.dir, '..', '..', 'codex-plugin', 'notify.sh')

/** Only sandboxed modes. `danger-full-access` and every bypass flag are refused. */
export const CODEX_SANDBOXES = ['read-only', 'workspace-write'] as const
export const CODEX_APPROVALS = ['on-request', 'never'] as const
const DEFAULT_SANDBOX = 'workspace-write'
const DEFAULT_APPROVAL = 'on-request'
const MODEL_RE = /^[A-Za-z0-9][\w.:\/-]{0,127}$/
const EFFORT_RE = /^[a-z]{1,16}$/

export function codexHomeDir(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

export function codexSessionNameFor(workdir: string): string {
  const hash = createHash('sha1').update(workdir).digest('hex').slice(0, 10)
  return `feishu-codex-${hash}`
}

export function codexSignalDirFor(workdir: string, signalRoot = SIGNAL_ROOT): string {
  return join(signalRoot, codexSessionNameFor(workdir))
}

/** TOML basic string. JSON string escapes (\" \\ \n \uXXXX) are all valid TOML. */
const tomlString = (s: string) => JSON.stringify(s)

/**
 * Argv for a fresh or resumed session. Sandbox and approval are always passed
 * explicitly, so the user's own config.toml can't widen a router session to
 * full access. Throws on a value outside the allowed set. That throw happens
 * before anything is pasted, so the caller may still fall back.
 */
export function buildCodexSpawnArgs(bin: string, workdir: string, opts: SpawnOptions, notifyScript: string, resumeId?: string): string[] {
  const sandbox = opts.sandbox ?? DEFAULT_SANDBOX
  if (!(CODEX_SANDBOXES as readonly string[]).includes(sandbox)) {
    throw new Error(`codex sandbox "${sandbox}" is not allowed (use ${CODEX_SANDBOXES.join(' or ')})`)
  }
  const approval = opts.permissionMode ?? DEFAULT_APPROVAL
  if (!(CODEX_APPROVALS as readonly string[]).includes(approval)) {
    throw new Error(`codex approval policy "${approval}" is not allowed (use ${CODEX_APPROVALS.join(' or ')})`)
  }
  if (opts.model !== undefined && !MODEL_RE.test(opts.model)) throw new Error(`invalid codex model name "${opts.model}"`)
  if (opts.effort !== undefined && !EFFORT_RE.test(opts.effort)) throw new Error(`invalid codex reasoning effort "${opts.effort}"`)
  if (resumeId !== undefined && !/^[0-9A-Fa-f-]{8,64}$/.test(resumeId)) throw new Error(`invalid codex session id "${resumeId}"`)
  return [
    bin,
    ...(resumeId ? ['resume', resumeId] : []),
    '-s', sandbox,
    '-a', approval,
    ...(opts.model ? ['-m', opts.model] : []),
    ...(opts.effort ? ['-c', `model_reasoning_effort=${tomlString(opts.effort)}`] : []),
    // Run through sh so the script needs no exec bit (plugin caches may drop it).
    '-c', `notify=[${tomlString('/bin/sh')},${tomlString(notifyScript)}]`,
    '-c', `projects={${tomlString(workdir)}={trust_level="trusted"}}`,
  ]
}

/** Idle footer. It stays on screen while a turn runs, so the working line must be absent too. */
const READY_RE = /\?\s+for shortcuts/
const WORKING_RE = /esc to interrupt/
export function isCodexReady(plainPane: string): boolean {
  return READY_RE.test(plainPane) && !WORKING_RE.test(plainPane)
}

/** Footers and scroll arrows that may trail a Codex menu. */
const MENU_TRAILING_RES = [/^\s*[↑↓]\s*$/, /\benter\s+\w+\s*·\s*esc\s+\w+/i, /Press enter to confirm/i]
const APPROVAL_QUESTION_RE = /^\s*(Would you like to|Do you want to|Allow)\b.*\?\s*$/
const COMMAND_LINE_RE = /^\s*\$\s+\S/

/**
 * Numbered menus (approval prompts, `/model`). For an approval prompt, the
 * card question becomes "Would you like to run the following command?" plus
 * the `$ command` line, instead of whichever line sits right above option 1.
 */
export function parseCodexDialog(plainPane: string): Dialog | null {
  const dialog = parseDialogOptions(plainPane, { cursorChars: '›', extraTrailingRes: MENU_TRAILING_RES, fallbackQuestion: 'Codex 需要你的输入' })
  if (!dialog) return null
  const lines = plainPane.split('\n')
  const firstOption = lines.findLastIndex(l => /^\s*(?:›\s*)?1\.\s+/.test(l))
  let qIdx = -1
  for (let i = firstOption - 1; i >= 0 && i >= firstOption - 12; i--) {
    if (APPROVAL_QUESTION_RE.test(lines[i])) { qIdx = i; break }
  }
  if (qIdx === -1) return dialog
  const command = lines.slice(qIdx + 1, firstOption).find(l => COMMAND_LINE_RE.test(l))
  return { ...dialog, question: [lines[qIdx].trim(), command?.trim()].filter(Boolean).join('\n') }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Thread ids reported by the notify bridge in this signal dir, most recent first. */
export function notifiedThreadIds(signalDir: string): string[] {
  let names: string[]
  try { names = readdirSync(signalDir).filter(n => /^notify-[0-9A-Fa-f-]+\.json$/.test(n)) } catch { return [] }
  return names
    .map(n => ({ n, t: statSync(join(signalDir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .map(({ n }) => readJson(join(signalDir, n))?.['thread-id'])
    .filter((id): id is string => typeof id === 'string' && /^[0-9A-Fa-f-]+$/.test(id))
}

/** Map a rollout's last turn end to the manager's stop outcome. Only a failed turn carries an error. An Esc interrupt is the user's own doing. */
export function readCodexStop(transcriptPath: string | null): StopOutcome {
  const outcome: StopOutcome = { wait: 'done' }
  if (!transcriptPath) return outcome
  const id = rolloutIdFromPath(transcriptPath)
  if (id) outcome.conversationId = id
  const end = lastTurnEnd(transcriptPath)
  if (end?.error) outcome.error = end.error
  return outcome
}

export interface CodexProfileOptions {
  /** Binary (or argv prefix, e.g. a test double run through bun). Default: resolved `codex`. */
  bin?: string | string[]
  /** Overrides for tests. Default: $CODEX_HOME (or ~/.codex) and $TMPDIR/feishu-codex-tmux. */
  codexHome?: string
  signalRoot?: string
  /** Notify bridge script. Default: the repo's codex-plugin/notify.sh. */
  notifyScript?: string
}

export function createCodexProfile(options: CodexProfileOptions = {}): TmuxCliProfile {
  const binArgv = Array.isArray(options.bin)
    ? options.bin
    : [options.bin ?? resolveBin('codex', ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', join(homedir(), '.local', 'bin', 'codex')])]
  const sessionsDir = () => join(options.codexHome ?? codexHomeDir(), 'sessions')
  const signalDir = (workdir: string) => codexSignalDirFor(workdir, options.signalRoot ?? SIGNAL_ROOT)
  const notifyScript = options.notifyScript ?? CODEX_NOTIFY_SCRIPT
  /** workdir -> when this profile last spawned it, bounding the rollout fallback below. */
  const spawnedAt = new Map<string, number>()
  /** thread id -> rollout path, once found (resolved rollouts never move). */
  const rolloutCache = new Map<string, string>()

  const rolloutFor = (id: string): string | null => {
    const cached = rolloutCache.get(id)
    if (cached && existsSync(cached)) return cached
    const found = findRollout(sessionsDir(), id)
    if (found) rolloutCache.set(id, found)
    return found
  }

  return {
    kind: 'codex',
    label: 'Codex',
    midTurn: 'absorb',
    resumable: true,
    startupTimeoutMs: 30_000,
    // Verified: `/model` + Esc leaves no rollout record and no notify.
    slashCommandIdleMs: 3_000,

    sessionName: codexSessionNameFor,

    /** Fresh, owner-only signal dir per spawn, so an earlier process's notify files can't be mistaken for this one's. */
    prepareSpawn(workdir: string) {
      const dir = signalDir(workdir)
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      spawnedAt.set(workdir, Date.now())
    },

    planSpawn(workdir: string, opts: SpawnOptions, resumeId?: string): SpawnPlan {
      const [head, ...rest] = binArgv
      const argv = buildCodexSpawnArgs(head, workdir, opts, notifyScript, resumeId)
      return { argv: [argv[0], ...rest, ...argv.slice(1)], env: { [CODEX_SIGNAL_ENV]: signalDir(workdir) } }
    },

    isReady: isCodexReady,

    /** Where the id's rollout is. If it doesn't exist (yet), a path that won't exist, so the manager reads nothing rather than a wrong file. */
    transcriptPath: (_workdir: string, sessionId: string) => rolloutFor(sessionId) ?? join(sessionsDir(), 'pending', `rollout-${sessionId}.jsonl`),
    /** Never guess: the sessions dir is shared by every Codex run on the machine. Identity comes from discoverSessionId. */
    findLatestTranscript: () => null,

    /**
     * 1. Exact: a thread id from this session's notify bridge whose rollout
     *    is an interactive session in this workdir (title-generator threads
     *    have no rollout and are skipped).
     * 2. Before the first notify (or when the first turn failed, which
     *    notifies nothing): the single interactive rollout for this workdir
     *    created since this profile spawned the session. If there are two or
     *    more, nothing is returned.
     */
    discoverSessionId(workdir: string) {
      for (const id of notifiedThreadIds(signalDir(workdir))) {
        const path = rolloutFor(id)
        if (path && isOwnTuiSession(readSessionMeta(path), workdir)) return id
      }
      const since = spawnedAt.get(workdir)
      if (since === undefined) return undefined
      const candidates = rolloutsCreatedSince(sessionsDir(), workdir, since - 1_000)
      return candidates.length === 1 ? rolloutIdFromPath(candidates[0]) : undefined
    },

    /** No signal file: turn ends are read from the rollout (isTurnEnd). */
    stopSignalPath: () => null,
    afterStop: (ctx: StopContext) => readCodexStop(ctx.transcriptPath),

    isUserTurnStart: isCodexTurnStartLine,
    isTurnEnd: isCodexTurnEndLine,
    parseText: parseCodexTextLines,
    parseProgress: parseCodexProgressLines,
    parseDialog: parseCodexDialog,
    /** Verified: Codex acts on the digit at once. An extra Enter would land in the input box. */
    optionKeys: (option: DialogOption) => [['-l', option.number]],
  }
}

export const codexProfile = createCodexProfile()
