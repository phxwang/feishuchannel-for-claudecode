/**
 * Codex `exec` backend (design doc §11.5). One attempt = one detached
 * `codex exec --json` process whose JSONL stdout is tailed from a file, so
 * observation survives a router restart. Permissions are decided only by the
 * server-configured sandbox with approval_policy="never" (backend_policy).
 */
import { execFile } from 'child_process'
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { resolveBin } from '../../tmux/profile'
import type {
  AttemptContext, BackendCapabilities, BackendEvent, BackendHandle, LocateResult, NotSent, OpenResult, ReleaseResult, SubmitResult, TaskBackend,
} from './backend'
import { notSent } from './backend'
import { isSameProcessAlive, readExit, signalGroup, spawnDetached, stopGroup, tailLines } from './process-runner'

export type CodexSandbox = 'read-only' | 'workspace-write'

export interface CodexExecOptions {
  bin?: string
  sandbox: CodexSandbox
  env?: Record<string, string>
}

const SAFE_SANDBOXES: readonly string[] = ['read-only', 'workspace-write']
const KNOWN_OPTION_KEYS: readonly string[] = ['bin', 'sandbox', 'env']
const BIN_CANDIDATES = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex']
const AVAILABILITY_CACHE_MS = 60_000
const VERSION_TIMEOUT_MS = 10_000
/** After a terminal event, how long to wait for the process to exit before ending the turn anyway. */
const EXIT_WAIT_AFTER_TERMINAL_MS = 10_000
/** After the process is gone, how long to wait for the spawner's exit.json to appear. */
const EXIT_FILE_WAIT_MS = 500
const TOOL_ITEM_TYPES: readonly string[] = ['command_execution', 'file_change', 'mcp_tool_call']

// ── JSONL reduction (pure) ────────────────────────────────────────────────

export interface CodexStreamState {
  threadId: string | null
  turnStarted: boolean
  openItems: ReadonlySet<string>
  toolItemsSeen: number
  lastAgentText: string | null
  terminal: { outcome: 'completed' | 'failed'; stopReason: string } | null
}

export const INITIAL_STREAM_STATE: CodexStreamState = {
  threadId: null, turnStarted: false, openItems: new Set(), toolItemsSeen: 0, lastAgentText: null, terminal: null,
}

type ItemEvents = { state: CodexStreamState; events: BackendEvent[] }

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function errorMessage(ev: Record<string, any>): string {
  return str(ev.error?.message) ?? str(ev.message) ?? 'codex reported an error'
}

function toolFailed(item: Record<string, any>): boolean {
  if (item.status === 'failed' || item.status === 'declined') return true
  if (item.type === 'command_execution' && typeof item.exit_code === 'number' && item.exit_code !== 0) return true
  return item.type === 'mcp_tool_call' && item.error != null
}

function toolDetail(item: Record<string, any>): string | undefined {
  if (item.type === 'command_execution') return str(item.command) ?? undefined
  if (item.type === 'mcp_tool_call') return [str(item.server), str(item.tool)].filter(Boolean).join('.') || undefined
  if (item.type === 'file_change' && Array.isArray(item.changes)) {
    return item.changes.map((c: any) => `${str(c?.kind) ?? 'change'} ${str(c?.path) ?? '?'}`).join(', ') || undefined
  }
  return undefined
}

function reduceItem(state: CodexStreamState, phase: 'started' | 'updated' | 'completed', item: Record<string, any>): ItemEvents {
  const id = str(item.id)
  const type = str(item.type)
  if (!id || !type) return { state, events: [{ type: 'diagnostic', detail: `codex item without id/type (${phase})` }] }

  if (type === 'agent_message') {
    const text = str(item.text)
    if (text === null) return { state, events: [] }
    const next = phase === 'completed' ? { ...state, lastAgentText: text } : state
    return { state: next, events: [{ type: 'text', streamId: id, text, mode: 'snapshot' }] }
  }

  if (TOOL_ITEM_TYPES.includes(type)) {
    const detail = toolDetail(item)
    const base = { type: 'tool' as const, toolCallId: id, name: type, ...(detail ? { detail } : {}) }
    if (phase === 'started') {
      const seen = state.openItems.has(id) ? state.toolItemsSeen : state.toolItemsSeen + 1
      return { state: { ...state, openItems: new Set([...state.openItems, id]), toolItemsSeen: seen }, events: [{ ...base, status: 'started' }] }
    }
    if (phase === 'updated') return { state, events: [{ type: 'activity', label: type }] }
    const wasOpen = state.openItems.has(id)
    const openItems = new Set([...state.openItems].filter(x => x !== id))
    const toolItemsSeen = wasOpen ? state.toolItemsSeen : state.toolItemsSeen + 1
    return { state: { ...state, openItems, toolItemsSeen }, events: [{ ...base, status: toolFailed(item) ? 'failed' : 'completed' }] }
  }

  // reasoning, todo_list, web_search, error items: activity only.
  return { state, events: [{ type: 'activity', label: type }] }
}

/** Fold one JSONL line into the stream state. Events after a terminal event are ignored. */
export function reduceLine(state: CodexStreamState, line: string): ItemEvents {
  if (state.terminal) return { state, events: [] }
  let ev: Record<string, any>
  try { ev = JSON.parse(line) } catch { return { state, events: [{ type: 'diagnostic', detail: 'unparseable codex output line' }] } }
  if (!ev || typeof ev !== 'object') return { state, events: [] }
  switch (ev.type) {
    case 'thread.started': return { state: state.threadId ? state : { ...state, threadId: str(ev.thread_id) }, events: [] }
    case 'turn.started': return { state: { ...state, turnStarted: true }, events: [] }
    case 'item.started': return reduceItem(state, 'started', ev.item ?? {})
    case 'item.updated': return reduceItem(state, 'updated', ev.item ?? {})
    case 'item.completed': return reduceItem(state, 'completed', ev.item ?? {})
    case 'turn.completed': return { state: { ...state, terminal: { outcome: 'completed', stopReason: 'turn.completed' } }, events: [] }
    case 'turn.failed':
    case 'error': return { state: { ...state, terminal: { outcome: 'failed', stopReason: errorMessage(ev) } }, events: [] }
    default: return { state, events: [] }
  }
}

export function reduceAll(text: string): CodexStreamState {
  return text.split('\n').filter(l => l.trim()).reduce((s, l) => reduceLine(s, l).state, INITIAL_STREAM_STATE)
}

// ── helpers ───────────────────────────────────────────────────────────────

/** True when `dir` or any parent contains `.git` (what codex's repo check looks for). */
export function insideGitRepo(dir: string): boolean {
  let cur = dir
  for (;;) {
    if (existsSync(join(cur, '.git'))) return true
    const parent = dirname(cur)
    if (parent === cur) return false
    cur = parent
  }
}

function childEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const base = Object.entries(process.env)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && !e[0].startsWith('FEISHU_'))
  return { ...Object.fromEntries(base), ...(extra ?? {}) }
}

function isExecutable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
}

function readText(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

interface RunPaths { runDir: string; promptPath: string; stdoutPath: string; stderrPath: string; exitPath: string; lastMessagePath: string }

function runPaths(ctx: AttemptContext, handle: BackendHandle | null): RunPaths {
  const extra = handle?.extra ?? {}
  const runDir = typeof extra.runDir === 'string' ? extra.runDir : ctx.runDir
  const pick = (key: string, file: string) => (typeof extra[key] === 'string' ? extra[key] as string : join(runDir, file))
  return {
    runDir,
    promptPath: join(runDir, 'prompt.txt'),
    stdoutPath: pick('stdoutPath', 'stdout.jsonl'),
    stderrPath: pick('stderrPath', 'stderr.log'),
    exitPath: pick('exitPath', 'exit.json'),
    lastMessagePath: pick('lastMessagePath', 'last-message.txt'),
  }
}

function firstStderrLine(path: string): string {
  const line = (readText(path) ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? ''
  return line.slice(0, 200)
}

// ── backend ───────────────────────────────────────────────────────────────

export class CodexExecBackend implements TaskBackend {
  readonly kind = 'codex' as const
  readonly mode = 'exec' as const
  private readonly bin: string
  private readonly sandbox: CodexSandbox
  private readonly env: Record<string, string> | undefined
  private availability: { at: number; ok: boolean; reason: string | null } | null = null

  constructor(opts: CodexExecOptions) {
    const unknown = Object.keys(opts).filter(k => !KNOWN_OPTION_KEYS.includes(k))
    if (unknown.length) throw new Error(`codex backend: unsupported option(s) ${unknown.join(', ')}`)
    if (!SAFE_SANDBOXES.includes(opts.sandbox)) {
      throw new Error(`codex backend: sandbox must be read-only or workspace-write, got ${JSON.stringify(opts.sandbox)}`)
    }
    this.sandbox = opts.sandbox
    this.bin = opts.bin ?? resolveBin('codex', BIN_CANDIDATES)
    this.env = opts.env ? { ...opts.env } : undefined
  }

  async capabilities(): Promise<BackendCapabilities> {
    const a = await this.checkAvailable()
    return {
      kind: 'codex', mode: 'exec', available: a.ok, availabilityReason: a.reason,
      features: { isolatedSession: true, samePrimaryTurns: false, recoverAcceptedTurn: true, permissionReply: false, cancel: true, eventReplay: true },
      permissionModes: ['backend_policy'],
      fallback: {
        orderedFallback: false,
        supportedFallbackTriggers: [{ code: 'backend_unavailable', stage: 'before_delivery' }, { code: 'startup_failed', stage: 'before_delivery' }],
        cleanFailureFallback: false, checkpointHandoff: false, sameOwnerResetRecovery: false, nativeGoal: false,
      },
    }
  }

  private async checkAvailable(): Promise<{ ok: boolean; reason: string | null }> {
    const cached = this.availability
    if (cached && Date.now() - cached.at < AVAILABILITY_CACHE_MS) return cached
    const result = await this.probeVersion()
    this.availability = { at: Date.now(), ...result }
    return result
  }

  private probeVersion(): Promise<{ ok: boolean; reason: string | null }> {
    if (!this.bin.includes('/') || !isExecutable(this.bin)) return Promise.resolve({ ok: false, reason: 'codex binary not found' })
    return new Promise(resolve => {
      execFile(this.bin, ['--version'], { timeout: VERSION_TIMEOUT_MS, env: childEnv(this.env) }, (err) => {
        resolve(err ? { ok: false, reason: `codex --version failed: ${err.message.slice(0, 200)}` } : { ok: true, reason: null })
      })
    })
  }

  async preflight(ctx: AttemptContext, _signal?: AbortSignal): Promise<{ kind: 'ok' } | NotSent> {
    if (ctx.permissionMode !== 'backend_policy') return notSent('capability_unavailable', 'codex exec supports only backend_policy')
    const a = await this.checkAvailable()
    return a.ok ? { kind: 'ok' } : notSent('backend_unavailable', a.reason ?? 'codex unavailable')
  }

  async open(ctx: AttemptContext, _signal?: AbortSignal): Promise<OpenResult> {
    return {
      kind: 'opened',
      handle: { backendSessionId: null, backendTurnId: `pending:${ctx.executionAttemptId}`, pid: null, pgid: null, processStartIdentity: null, extra: { runDir: ctx.runDir } },
    }
  }

  /** Exact argv; the prompt itself is never on the command line (it is read from stdin). */
  buildArgv(ctx: AttemptContext, lastMessagePath: string): string[] {
    const workdir = ctx.workdir.canonicalPath
    return [
      this.bin, 'exec', '--json',
      '-m', ctx.candidate.model,
      '-C', workdir,
      '-s', this.sandbox,
      '-c', 'approval_policy="never"',
      '-o', lastMessagePath,
      ...(insideGitRepo(workdir) ? [] : ['--skip-git-repo-check']),
      '-',
    ]
  }

  async submit(ctx: AttemptContext, handle: BackendHandle, input: { inputKind: 'text' | 'native_goal'; prompt: string }, _signal?: AbortSignal): Promise<SubmitResult> {
    if (ctx.permissionMode !== 'backend_policy') return notSent('capability_unavailable', 'codex exec supports only backend_policy')
    if (input.inputKind !== 'text') return notSent('capability_unavailable', 'codex exec accepts only text input')
    if (!this.bin.includes('/') || !isExecutable(this.bin)) return notSent('startup_failed', 'codex binary is not executable')
    const paths = runPaths(ctx, handle)
    try {
      writeFileSync(paths.promptPath, input.prompt, { mode: 0o600 })
      const spawned = spawnDetached({
        argv: this.buildArgv(ctx, paths.lastMessagePath),
        cwd: ctx.workdir.canonicalPath,
        env: childEnv(this.env),
        runDir: paths.runDir,
        stdinFile: paths.promptPath,
        attemptId: ctx.executionAttemptId,
      })
      return {
        kind: 'pending',
        handle: {
          ...handle, pid: spawned.pid, pgid: spawned.pgid, processStartIdentity: spawned.processStartIdentity,
          extra: { ...handle.extra, runDir: paths.runDir, stdoutPath: spawned.stdoutPath, stderrPath: spawned.stderrPath, exitPath: spawned.exitPath, lastMessagePath: paths.lastMessagePath },
        },
      }
    } catch (e) {
      return notSent('startup_failed', `codex spawn failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async *observe(ctx: AttemptContext, handle: BackendHandle, signal: AbortSignal): AsyncIterable<BackendEvent> {
    const paths = runPaths(ctx, handle)
    if (!handle.pid && !existsSync(paths.stdoutPath)) {
      yield { type: 'lost', detail: 'codex process was never recorded for this attempt' }
      return
    }
    let state = INITIAL_STREAM_STATE
    let terminalAt: number | null = null
    const finished = () => !isSameProcessAlive(handle.pid, handle.processStartIdentity)
      || (terminalAt !== null && Date.now() - terminalAt > EXIT_WAIT_AFTER_TERMINAL_MS)

    for await (const { line } of tailLines(paths.stdoutPath, 0, finished, signal)) {
      const before = state
      const step = reduceLine(state, line)
      state = step.state
      if (!before.threadId && state.threadId && handle.backendSessionId !== state.threadId) {
        yield { type: 'handle', handle: { ...handle, backendSessionId: state.threadId, backendTurnId: `${state.threadId}:1` } }
      }
      if (!before.turnStarted && state.turnStarted) yield { type: 'delivery', status: 'accepted' }
      yield* step.events
      if (!before.terminal && state.terminal) terminalAt = Date.now()
    }
    if (signal.aborted) return
    yield* this.endOfStream(state, paths, handle)
  }

  private async *endOfStream(state: CodexStreamState, paths: RunPaths, handle: BackendHandle): AsyncIterable<BackendEvent> {
    const alive = isSameProcessAlive(handle.pid, handle.processStartIdentity)
    const exit = alive ? null : await this.waitExitFile(paths.exitPath)
    const proc = { exitCode: exit?.code ?? null, signal: exit?.signal ?? null, controlledShutdown: false }

    if (state.terminal) {
      const finalText = this.finalText(state, paths)
      if (finalText.mismatch) yield { type: 'diagnostic', detail: 'last-message.txt differs from the last agent_message item' }
      yield {
        type: 'turn.ended', outcome: state.terminal.outcome, finalText: finalText.text,
        protocol: { backendFinished: true, activeToolCount: state.openItems.size, stopReason: state.terminal.stopReason },
        process: proc,
        ...(state.terminal.outcome === 'failed' ? { failureCode: 'execution_failed' as const } : {}),
        ...(state.toolItemsSeen === 0 ? { effects: 'none' as const } : {}),
      }
      return
    }
    if (!state.threadId && !state.turnStarted && exit && typeof exit.code === 'number' && exit.code !== 0) {
      const err = firstStderrLine(paths.stderrPath)
      yield { type: 'delivery', status: 'not_sent', failure: notSent('startup_failed', `codex exited with code ${exit.code} before thread.started${err ? `: ${err}` : ''}`, true) }
      return
    }
    if (state.turnStarted) {
      yield {
        type: 'turn.ended', outcome: 'failed', finalText: state.lastAgentText,
        protocol: { backendFinished: false, activeToolCount: state.openItems.size, stopReason: 'codex exited without a terminal turn event' },
        process: proc, failureCode: 'execution_failed',
      }
      return
    }
    yield { type: 'lost', detail: 'codex exited before turn.started without a proven startup failure' }
  }

  private async waitExitFile(exitPath: string): Promise<ReturnType<typeof readExit>> {
    const end = Date.now() + EXIT_FILE_WAIT_MS
    for (;;) {
      const exit = readExit(exitPath)
      if (exit || Date.now() >= end) return exit
      await sleep(25)
    }
  }

  private finalText(state: CodexStreamState, paths: RunPaths): { text: string | null; mismatch: boolean } {
    const file = readText(paths.lastMessagePath)
    if (state.lastAgentText === null) return { text: file, mismatch: false }
    const mismatch = file !== null && file.trim() !== state.lastAgentText.trim()
    return { text: state.lastAgentText, mismatch }
  }

  /** backend_policy has no approval channel: there is never anything to answer. */
  async replyPermission(): Promise<'confirmed' | 'unknown'> {
    return 'unknown'
  }

  async interrupt(_ctx: AttemptContext, handle: BackendHandle): Promise<void> {
    signalGroup(handle.pid, handle.pgid, handle.processStartIdentity, 'SIGINT')
  }

  async release(_ctx: AttemptContext, handle: BackendHandle, graceMs: number): Promise<ReleaseResult> {
    const r = await stopGroup(handle.pid, handle.pgid, handle.processStartIdentity, graceMs)
    return { released: r.released ? true : null, backgroundWorkSettled: r.released ? true : null, detail: r.detail }
  }

  async locate(ctx: AttemptContext, handle: BackendHandle): Promise<LocateResult> {
    if (isSameProcessAlive(handle.pid, handle.processStartIdentity)) return 'running'
    const out = readText(runPaths(ctx, handle).stdoutPath)
    if (out === null) return 'absent'
    const state = reduceAll(out)
    return state.terminal || state.turnStarted ? 'ended' : 'absent'
  }
}
