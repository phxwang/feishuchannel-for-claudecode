/**
 * Claude Code print-mode task backend (design doc §11.4): one detached
 * `claude -p --output-format stream-json` process per execution attempt,
 * observed by tailing its stdout file so a router restart can re-attach.
 *
 * Persisted handle:
 *   backendSessionId = backendTurnId = the `--session-id` UUID
 *   pid / pgid / processStartIdentity = the spawned process group leader
 *   extra = { runDir, relayToken, stdoutPath, stderrPath, exitPath, observedOffset }
 */
import { execFile } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { PermissionAskParams } from '../ipc/protocol'
import { resolveBin } from '../../tmux/profile'
import type {
  AttemptContext, BackendCapabilities, BackendEvent, BackendHandle, LocateResult, NotSent, OpenResult, ReleaseResult, SubmitResult, TaskBackend,
} from './backend'
import { notSent } from './backend'
import { endEvents, initialStreamState, reduceLine, scanForMarkers, snapshotEvents, type StreamState } from './claude-stream'
import { PermissionRelay, type ClaudePermissionDecision } from './claude-relay'
import { groupAlive, isSameProcessAlive, readExit, signalGroup, spawnDetached, stopGroup, tailLines } from './process-runner'

export interface ClaudePrintBackendOptions {
  bin?: string
  /** Advertise `broker` and route prompts through the relay MCP tool. */
  permissionPromptTool: boolean
  strictMcpConfig: boolean
  /** task.sock path the relay connects to. */
  socketPath: string
  /** argv that starts the relay MCP server; default: this Bun binary + claude-permission-mcp.ts. */
  relayCommand?: string[]
  /** Extra environment for the child (applied after FEISHU_* are stripped). */
  env?: Record<string, string>
}

export const RELAY_SERVER_NAME = 'router_task'
export const RELAY_TOOL = `mcp__${RELAY_SERVER_NAME}__permission`
const AVAILABILITY_TTL_MS = 60_000
const VERSION_TIMEOUT_MS = 15_000
const RESULT_EXIT_GRACE_MS = 10_000
const EXIT_FILE_WAIT_MS = 500
const OFFSET_PERSIST_INTERVAL_MS = 1_000
const STDERR_TAIL_BYTES = 1_024
const IDENTITY_RECHECK_MS = 2_000
/** Variables removed from the child env: Feishu credentials, and the nested-session guard. */
const STRIPPED_ENV = [/^FEISHU_/, /^CLAUDECODE$/]

const TRIGGERS: BackendCapabilities['fallback']['supportedFallbackTriggers'] = [
  { code: 'backend_unavailable', stage: 'before_delivery' },
  { code: 'startup_failed', stage: 'before_delivery' },
]

interface RunFacts {
  sessionId: string
  runDir: string
  relayToken: string
  stdoutPath: string
  stderrPath: string
  exitPath: string
  observedOffset: number
}

export class ClaudePrintBackend implements TaskBackend {
  readonly kind = 'claude' as const
  readonly mode = 'print' as const
  readonly relay = new PermissionRelay()
  private readonly bin: string
  private availability: { at: number; ok: boolean; reason: string | null } | null = null

  constructor(private readonly o: ClaudePrintBackendOptions) {
    this.bin = o.bin ?? resolveBin('claude', [join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'])
  }

  // ── capabilities / preflight ───────────────────────────────────────────
  async capabilities(): Promise<BackendCapabilities> {
    const a = await this.probe()
    return {
      kind: 'claude', mode: 'print', available: a.ok, availabilityReason: a.reason,
      features: { isolatedSession: true, samePrimaryTurns: false, recoverAcceptedTurn: true, permissionReply: this.o.permissionPromptTool, cancel: true, eventReplay: true },
      permissionModes: this.o.permissionPromptTool ? ['broker', 'backend_policy'] : ['backend_policy'],
      fallback: { orderedFallback: true, supportedFallbackTriggers: TRIGGERS, cleanFailureFallback: false, checkpointHandoff: false, sameOwnerResetRecovery: false, nativeGoal: false },
    }
  }

  async preflight(ctx: AttemptContext, _signal?: AbortSignal): Promise<{ kind: 'ok' } | NotSent> {
    const a = await this.probe()
    if (!a.ok) return notSent('backend_unavailable', a.reason ?? 'claude is not available')
    if (ctx.permissionMode === 'broker' && !this.o.permissionPromptTool) {
      return notSent('capability_unavailable', 'broker permissions need the permission prompt tool, which is disabled')
    }
    return { kind: 'ok' }
  }

  private async probe(): Promise<{ ok: boolean; reason: string | null }> {
    const now = Date.now()
    if (this.availability && now - this.availability.at < AVAILABILITY_TTL_MS) return this.availability
    const reason = await new Promise<string | null>(resolve => {
      execFile(this.bin, ['--version'], { timeout: VERSION_TIMEOUT_MS, env: childEnv(this.o.env) }, (err, stdout) => {
        if (err) resolve(`${this.bin} --version failed: ${err.message.split('\n')[0]}`)
        else resolve(String(stdout).trim() ? null : `${this.bin} --version printed nothing`)
      })
    })
    this.availability = { at: now, ok: reason === null, reason }
    return this.availability
  }

  // ── open / submit ──────────────────────────────────────────────────────
  async open(ctx: AttemptContext, _signal?: AbortSignal): Promise<OpenResult> {
    const sessionId = randomUUID()
    const relayToken = randomBytes(24).toString('hex')
    try {
      writeFileSync(join(ctx.runDir, 'session.json'), JSON.stringify({ sessionId, executionAttemptId: ctx.executionAttemptId, createdAt: new Date().toISOString() }), { mode: 0o600 })
    } catch (e) {
      return notSent('startup_failed', `cannot write run files: ${errText(e)}`)
    }
    if (ctx.permissionMode === 'broker') this.relay.register(ctx.executionAttemptId, relayToken)
    return {
      kind: 'opened',
      handle: { backendSessionId: sessionId, backendTurnId: sessionId, pid: null, pgid: null, processStartIdentity: null, extra: { runDir: ctx.runDir, relayToken } },
    }
  }

  async submit(ctx: AttemptContext, handle: BackendHandle, input: { inputKind: 'text' | 'native_goal'; prompt: string }, _signal?: AbortSignal): Promise<SubmitResult> {
    if (input.inputKind !== 'text') return notSent('capability_unavailable', 'claude print mode only accepts text input')
    const sessionId = handle.backendSessionId
    if (!sessionId) return notSent('startup_failed', 'handle has no session id')
    const promptPath = join(ctx.runDir, 'prompt.txt')
    // Never hand the input off twice: a prompt file means an earlier submit already ran.
    if (existsSync(promptPath)) return { kind: 'unknown', detail: 'prompt.txt already exists; input may already have been handed off' }
    let mcpPath: string | null = null
    try {
      writeFileSync(promptPath, input.prompt, { mode: 0o600, flag: 'wx' })
      if (ctx.permissionMode === 'broker') mcpPath = this.writeMcpConfig(ctx, String(handle.extra.relayToken ?? ''))
    } catch (e) {
      return notSent('startup_failed', `cannot write run files: ${errText(e)}`)
    }
    try {
      const spawned = spawnDetached({
        argv: buildArgv(this.bin, sessionId, ctx.candidate.model, ctx.permissionMode === 'broker' ? mcpPath : null, this.o.strictMcpConfig),
        cwd: ctx.workdir.canonicalPath, env: childEnv(this.o.env), runDir: ctx.runDir, stdinFile: promptPath, attemptId: ctx.executionAttemptId,
      })
      return {
        kind: 'pending',
        handle: {
          ...handle, pid: spawned.pid, pgid: spawned.pgid, processStartIdentity: spawned.processStartIdentity,
          extra: { ...handle.extra, runDir: ctx.runDir, stdoutPath: spawned.stdoutPath, stderrPath: spawned.stderrPath, exitPath: spawned.exitPath, observedOffset: 0 },
        },
      }
    } catch (e) {
      return notSent('startup_failed', `spawn failed: ${errText(e)}`)
    }
  }

  private writeMcpConfig(ctx: AttemptContext, relayToken: string): string {
    const [command, ...args] = this.o.relayCommand ?? [process.execPath, join(import.meta.dir, 'claude-permission-mcp.ts')]
    const config = {
      mcpServers: {
        [RELAY_SERVER_NAME]: {
          type: 'stdio', command, args,
          env: { ROUTER_TASK_SOCKET: this.o.socketPath, ROUTER_TASK_ATTEMPT_ID: ctx.executionAttemptId, ROUTER_TASK_RELAY_TOKEN: relayToken },
        },
      },
    }
    const path = join(ctx.runDir, 'mcp.json')
    writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 })
    return path
  }

  // ── observe ────────────────────────────────────────────────────────────
  async *observe(ctx: AttemptContext, handle: BackendHandle, signal: AbortSignal): AsyncIterable<BackendEvent> {
    const facts = runFacts(handle)
    if (!facts || !handle.pid) { yield { type: 'lost', detail: 'no claude process was recorded for this attempt' }; return }
    const attemptId = ctx.executionAttemptId
    if (ctx.permissionMode === 'broker' && facts.relayToken) this.relay.register(attemptId, facts.relayToken)
    const channel = new EventChannel<BackendEvent>()
    const inner = new AbortController()
    const onAbort = () => inner.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const unsubscribe = this.relay.subscribe(attemptId, e => channel.push(e))
    void this.pumpStdout(handle, facts, inner.signal, e => channel.push(e))
      .catch(e => channel.push({ type: 'lost', detail: `reading claude output failed: ${errText(e)}` }))
      .finally(() => channel.close())
    try {
      for await (const ev of channel.iterate(inner.signal)) {
        yield ev
        if (ev.type === 'turn.ended' || ev.type === 'lost' || (ev.type === 'delivery' && ev.status === 'not_sent')) break
      }
    } finally {
      unsubscribe()
      signal.removeEventListener('abort', onAbort)
      inner.abort()
    }
  }

  /**
   * Replays stdout.jsonl from byte 0 so the stream state is always complete.
   * Lines already in the file when observation starts are folded silently:
   * their text goes out once as per-block snapshots (idempotent against the
   * engine's restored streams), and their tool/diagnostic events only when
   * they lie past the persisted `observedOffset`. Later lines stream live,
   * with text as appends.
   */
  private async pumpStdout(handle: BackendHandle, facts: RunFacts, signal: AbortSignal, emit: (e: BackendEvent) => void): Promise<void> {
    let state: StreamState = initialStreamState(facts.sessionId)
    const backlogEnd = fileSize(facts.stdoutPath)
    let live = backlogEnd === 0
    let resultAt: number | null = null
    let lastPersist = Date.now()
    let extra = handle.extra
    const alive = aliveCheck(handle.pid, handle.processStartIdentity)
    const finished = () => !alive() || (resultAt !== null && Date.now() - resultAt > RESULT_EXIT_GRACE_MS)
    const persistOffset = (offset: number) => {
      extra = { ...extra, observedOffset: offset }
      lastPersist = Date.now()
      emit({ type: 'handle', handle: { ...handle, extra } })
    }
    for await (const { line, nextOffset } of tailLines(facts.stdoutPath, 0, finished, signal)) {
      if (!live && nextOffset > backlogEnd) { snapshotEvents(state).forEach(emit); live = true }
      const r = reduceLine(state, line, nextOffset)
      state = r.state
      if (state.result && resultAt === null) resultAt = Date.now()
      const unseen = nextOffset > facts.observedOffset
      for (const ev of r.events) {
        if (live || ev.type === 'delivery' || (unseen && ev.type !== 'text')) emit(ev)
      }
      const notable = r.events.some(e => e.type !== 'text' && e.type !== 'activity')
      if (unseen && (notable || Date.now() - lastPersist >= OFFSET_PERSIST_INTERVAL_MS)) persistOffset(nextOffset)
    }
    if (signal.aborted) return
    if (!live) snapshotEvents(state).forEach(emit)
    const exit = await waitForExitFile(facts.exitPath, signal)
    endEvents(state, exit, readTail(facts.stderrPath, STDERR_TAIL_BYTES), !groupAlive(handle.pgid)).forEach(emit)
  }

  // ── permissions ────────────────────────────────────────────────────────
  /** IPC handler for `permission.ask` from claude-permission-mcp.ts. */
  handlePermissionAsk = (params: PermissionAskParams, signal: AbortSignal): Promise<ClaudePermissionDecision> => this.relay.ask(params, signal)

  async replyPermission(ctx: AttemptContext, _handle: BackendHandle, backendRequestId: string, decision: 'allow_once' | 'deny_once'): Promise<'confirmed' | 'unknown'> {
    return this.relay.reply(ctx.executionAttemptId, backendRequestId, decision) ? 'confirmed' : 'unknown'
  }

  // ── control ────────────────────────────────────────────────────────────
  async interrupt(ctx: AttemptContext, handle: BackendHandle): Promise<void> {
    this.relay.denyAll(ctx.executionAttemptId, 'turn interrupted')
    signalGroup(handle.pid, handle.pgid, handle.processStartIdentity, 'SIGINT')
  }

  async release(ctx: AttemptContext, handle: BackendHandle, graceMs: number): Promise<ReleaseResult> {
    this.relay.denyAll(ctx.executionAttemptId, 'attempt released')
    const r = await stopGroup(handle.pid, handle.pgid, handle.processStartIdentity, graceMs)
    if (r.released) this.relay.unregister(ctx.executionAttemptId)
    return { released: r.released, backgroundWorkSettled: r.released, detail: r.detail }
  }

  async locate(_ctx: AttemptContext, handle: BackendHandle): Promise<LocateResult> {
    if (isSameProcessAlive(handle.pid, handle.processStartIdentity)) return 'running'
    const facts = runFacts(handle)
    if (!facts || !handle.pid || !existsSync(facts.stdoutPath)) return 'absent'
    let content: string
    try { content = readFileSync(facts.stdoutPath, 'utf8') } catch { return 'unreachable' }
    const m = scanForMarkers(content, facts.sessionId)
    return m.result || m.init ? 'ended' : 'absent'
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

export function buildArgv(bin: string, sessionId: string, model: string, mcpConfigPath: string | null, strictMcpConfig: boolean): string[] {
  const permission = mcpConfigPath
    ? ['--permission-prompts', 'host', '--permission-prompt-tool', RELAY_TOOL, '--mcp-config', mcpConfigPath]
    : ['--permission-prompts', 'none']
  return [
    bin, '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--session-id', sessionId, '--model', model, '--permission-mode', 'default',
    ...permission, ...(strictMcpConfig ? ['--strict-mcp-config'] : []),
  ]
}

export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const base = Object.entries(process.env)
    .filter((kv): kv is [string, string] => typeof kv[1] === 'string' && !STRIPPED_ENV.some(re => re.test(kv[0])))
  return { ...Object.fromEntries(base), ...extra }
}

function runFacts(h: BackendHandle): RunFacts | null {
  const runDir = typeof h.extra.runDir === 'string' ? h.extra.runDir : null
  if (!runDir || !h.backendSessionId) return null
  const str = (k: string, fallback: string) => (typeof h.extra[k] === 'string' ? String(h.extra[k]) : fallback)
  return {
    sessionId: h.backendSessionId, runDir, relayToken: str('relayToken', ''),
    stdoutPath: str('stdoutPath', join(runDir, 'stdout.jsonl')),
    stderrPath: str('stderrPath', join(runDir, 'stderr.log')),
    exitPath: str('exitPath', join(runDir, 'exit.json')),
    observedOffset: Math.max(0, Number(h.extra.observedOffset ?? 0) || 0),
  }
}

/** exit.json is written by the spawning router on child exit; a restarted router never gets it. */
async function waitForExitFile(path: string, signal: AbortSignal): Promise<{ code: number | null; signal: string | null } | null> {
  const end = Date.now() + EXIT_FILE_WAIT_MS
  for (;;) {
    const exit = readExit(path)
    if (exit || Date.now() >= end || signal.aborted) return exit
    await new Promise(r => setTimeout(r, 25))
  }
}

function fileSize(path: string): number {
  try { return statSync(path).size } catch { return 0 }
}

function readTail(path: string, maxBytes: number): string {
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    const fd = openSync(path, 'r')
    try { readSync(fd, buf, 0, buf.length, start) } finally { closeSync(fd) }
    return buf.toString('utf8').replace(/\s+/g, ' ').trim()
  } catch { return '' }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Liveness of the recorded process for the tail loop: `kill(pid, 0)` on every
 * poll, the (costlier) start-identity check at most every IDENTITY_RECHECK_MS.
 */
function aliveCheck(pid: number | null, identity: string | null): () => boolean {
  let verifiedAt = 0
  return () => {
    if (!pid) return false
    try { process.kill(pid, 0) } catch { return false }
    if (Date.now() - verifiedAt < IDENTITY_RECHECK_MS) return true
    const same = isSameProcessAlive(pid, identity)
    if (same) verifiedAt = Date.now()
    return same
  }
}

/**
 * Single-consumer queue merging stdout events and relay events. The queue is
 * private to one observe() call and never shared, so it is mutated in place.
 */
class EventChannel<T> {
  private readonly items: T[] = []
  private closed = false
  private wake: (() => void) | null = null

  push(item: T): void {
    if (this.closed) return
    this.items.push(item)
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.wake?.()
  }

  async *iterate(signal: AbortSignal): AsyncGenerator<T> {
    const onAbort = () => this.wake?.()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (!signal.aborted) {
        if (this.items.length) { yield this.items.shift() as T; continue }
        if (this.closed) return
        await new Promise<void>(resolve => { this.wake = resolve })
        this.wake = null
      }
    } finally { signal.removeEventListener('abort', onAbort) }
  }
}
