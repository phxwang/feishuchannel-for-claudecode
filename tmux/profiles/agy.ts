/**
 * Antigravity CLI (`agy`) profile for the tmux manager.
 *
 * Verified live against agy 1.5.12 (2026-11-20, see
 * docs/agy-integration-plan.md §2):
 *   - Turn completion comes from agy's own lifecycle hooks. Hooks can't be
 *     injected per session (`--settings` rejects "hooks"), so the repo's
 *     agy-plugin/ (installed once, globally) writes hook payloads into
 *     $FEISHU_AGY_SIGNAL_DIR — set only on sessions this router spawns, so
 *     the plugin is a no-op for the user's own agy use.
 *   - There's no `--session-id`; the conversation id arrives in every hook
 *     payload (last.json) and is resumed with `--conversation <id>`.
 *   - Transcript: ~/.gemini/antigravity-cli/brain/<id>/.system_generated/
 *     logs/transcript_full.jsonl, one JSON step per line.
 *   - Menus: numbered permission prompts with a `>` cursor, answered by the
 *     digit alone (no Enter); pickers like `/model` have a `>` cursor and no
 *     numbers (parseCursorList).
 *   - A message typed mid-turn is queued by agy and run as its own next
 *     turn, so this profile is midTurn: 'queue'.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { parseCursorList, parseDialogOptions, type DialogOption } from '../dialog'
import { resolveBin, type ProgressEvent, type SpawnOptions, type SpawnPlan, type StopContext, type StopOutcome, type TmuxCliProfile } from '../profile'
import { summarizeToolInput } from './claude'

const AGY_BRAIN_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'brain')
const SIGNAL_ROOT = join(tmpdir(), 'feishu-agy-tmux')
/** Env var the router's agy plugin hook (agy-plugin/hook.sh) checks; unset = hook does nothing. */
export const AGY_SIGNAL_ENV = 'FEISHU_AGY_SIGNAL_DIR'

/** Argument names worth showing on the status card, tried in order (agy tool args are PascalCase). */
const AGY_PROGRESS_FIELDS = ['CommandLine', 'Path', 'AbsolutePath', 'TargetFile', 'File', 'Url', 'Query', 'SearchPath', 'Pattern', 'toolSummary']

export function agySessionNameFor(workdir: string): string {
  const hash = createHash('sha1').update(workdir).digest('hex').slice(0, 10)
  return `feishu-agy-${hash}`
}

export function agySignalDirFor(workdir: string, signalRoot = SIGNAL_ROOT): string {
  return join(signalRoot, agySessionNameFor(workdir))
}

export function agyTranscriptPath(conversationId: string, brainDir = AGY_BRAIN_DIR): string {
  return join(brainDir, conversationId, '.system_generated', 'logs', 'transcript_full.jsonl')
}

interface AgyStep {
  type?: string
  content?: unknown
  tool_calls?: { name?: unknown; args?: unknown }[]
}

function parseStep(line: string): AgyStep | null {
  if (!line.trim()) return null
  try {
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === 'object' ? parsed as AgyStep : null
  } catch {
    return null
  }
}

/** Reply text: the `content` of each PLANNER_RESPONSE step (the model's own words; tool and system steps are skipped). */
export function parseAgyTextLines(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const step = parseStep(line)
    if (step?.type !== 'PLANNER_RESPONSE') continue
    if (typeof step.content === 'string' && step.content.trim()) out.push(step.content)
  }
  return out
}

/** One progress event per tool call in a PLANNER_RESPONSE step — name plus one short, truncated argument. */
export function parseAgyProgressLines(lines: string[]): ProgressEvent[] {
  const out: ProgressEvent[] = []
  for (const line of lines) {
    const step = parseStep(line)
    if (step?.type !== 'PLANNER_RESPONSE' || !Array.isArray(step.tool_calls)) continue
    for (const call of step.tool_calls) {
      if (call && typeof call.name === 'string') out.push({ tool: call.name, summary: summarizeToolInput(call.args, AGY_PROGRESS_FIELDS) })
    }
  }
  return out
}

export function buildAgySpawnArgs(bin: string, workdir: string, opts: SpawnOptions, resumeId?: string): string[] {
  return [
    bin,
    ...(resumeId ? ['--conversation', resumeId] : []),
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.effort ? ['--effort', opts.effort] : []),
    ...(opts.permissionMode ? ['--mode', opts.permissionMode] : []),
    // Session-only trust (verified: skips the "trust this folder?" prompt
    // and is not written to agy's settings.json). The router only ever
    // spawns in a workdir declared in agents.yaml.
    '--settings', JSON.stringify({ trustedWorkspaces: [workdir] }),
  ]
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const str = (v: unknown) => typeof v === 'string' && v ? v : undefined

/**
 * Interpret the Stop hook payload. `fullyIdle: false` means agy still has a
 * background task running and will wake itself when it ends — keep
 * collecting, but capped (backgroundIdleCapMs) in case it never does.
 * Unreadable payload → done (the stop signal itself already fired).
 */
export function readAgyStop(path: string): StopOutcome {
  const payload = readJson(path)
  if (!payload) return { wait: 'done' }
  const outcome: StopOutcome = { wait: payload.fullyIdle === false ? 'wait-capped' : 'done' }
  const conversationId = str(payload.conversationId)
  const lastUserInput = str(payload.lastUserInput)
  const error = str(payload.error)
  if (conversationId) outcome.conversationId = conversationId
  if (lastUserInput) outcome.lastUserInput = lastUserInput
  if (error) outcome.error = error
  return outcome
}

/** Idle footer agy shows when it's waiting for input. */
const READY_RE = /\?\s+for shortcuts/
/** Footer under agy's numbered permission prompts, tolerated after the option block. */
const NAVIGATE_FOOTER_RE = /↑\/↓\s+Navigate/

export interface AgyProfileOptions {
  /** Binary (or argv prefix, e.g. a test double run through bun). Default: resolved `agy`. */
  bin?: string | string[]
  /** Overrides for tests; default ~/.gemini/antigravity-cli/brain and $TMPDIR/feishu-agy-tmux. */
  brainDir?: string
  signalRoot?: string
  /** tmux session name for a session key. Default: agySessionNameFor (chat: key = workdir). The task service uses `rtask-<attemptId>`. */
  sessionName?: (sessionKey: string) => string
  /** Signal directory (FEISHU_AGY_SIGNAL_DIR) for a session key. Default: <signalRoot>/<chat session name>. */
  signalDirFor?: (sessionKey: string) => string
  /** Reuse a persisted conversation id on respawn. Default true (chat); the task service passes false. */
  resumable?: boolean
}

export function createAgyProfile(options: AgyProfileOptions = {}): TmuxCliProfile {
  const binArgv = Array.isArray(options.bin)
    ? options.bin
    : [options.bin ?? resolveBin('agy', [join(homedir(), '.local', 'bin', 'agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy'])]
  const brainDir = options.brainDir ?? AGY_BRAIN_DIR
  const signalDir = options.signalDirFor ?? ((workdir: string) => agySignalDirFor(workdir, options.signalRoot ?? SIGNAL_ROOT))
  return {
    kind: 'agy',
    label: 'Antigravity',
    midTurn: 'queue',
    resumable: options.resumable ?? true,
    startupTimeoutMs: 30_000,
    // Verified live: `/model` + Esc leaves no trace except the pane going idle.
    slashCommandIdleMs: 3_000,

    sessionName: options.sessionName ?? agySessionNameFor,

    /** Fresh signal dir per spawn, so a previous process's last.json/Stop.json can't be mistaken for this one's. */
    prepareSpawn(workdir: string) {
      const dir = signalDir(workdir)
      rmSync(dir, { recursive: true, force: true })
      // Owner-only: on a shared /tmp another user must not be able to plant fake stop signals.
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    },

    planSpawn(workdir: string, opts: SpawnOptions, resumeId?: string, sessionKey?: string): SpawnPlan {
      const [head, ...rest] = binArgv
      const argv = buildAgySpawnArgs(head, workdir, opts, resumeId)
      return { argv: [argv[0], ...rest, ...argv.slice(1)], env: { [AGY_SIGNAL_ENV]: signalDir(sessionKey ?? workdir) } }
    },

    isReady: (plainPane: string) => READY_RE.test(plainPane),

    transcriptPath: (_workdir: string, sessionId: string) => agyTranscriptPath(sessionId, brainDir),
    /** No safe heuristic: agy's brain dir is shared by every agy session on the machine. */
    findLatestTranscript: () => null,

    discoverSessionId(workdir: string) {
      const last = readJson(join(signalDir(workdir), 'last.json'))
      return str(last?.conversationId)
    },

    stopSignalPath: (workdir: string) => join(signalDir(workdir), 'Stop.json'),

    afterStop(ctx: StopContext): StopOutcome {
      return readAgyStop(join(signalDir(ctx.workdir), 'Stop.json'))
    },

    isUserTurnStart: (line: string) => parseStep(line)?.type === 'USER_INPUT',
    parseText: parseAgyTextLines,
    parseProgress: parseAgyProgressLines,
    parseDialog: (plainPane: string) =>
      parseDialogOptions(plainPane, { cursorChars: '>', extraTrailingRes: [NAVIGATE_FOOTER_RE], fallbackQuestion: 'Antigravity 需要你的输入' })
      ?? parseCursorList(plainPane, { fallbackQuestion: 'Antigravity 需要你选择' }),
    /** agy acts on the digit immediately — an extra Enter would be typed into the input box. */
    optionKeys: (option: DialogOption) => [['-l', option.number]],
  }
}

export const agyProfile = createAgyProfile()

/** True when the router's agy plugin hook has ever written into this workdir's signal dir — used to warn when the plugin isn't installed. */
export function agyHookSeen(workdir: string): boolean {
  return existsSync(join(agySignalDirFor(workdir), 'last.json'))
}
