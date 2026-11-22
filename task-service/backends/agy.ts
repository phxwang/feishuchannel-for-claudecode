/**
 * Antigravity (`agy` / `tmux`) task backend (design doc §11.6). Each
 * execution attempt runs in its own fresh tmux session `rtask-<attemptId>`
 * hosted by a TmuxCliManager this backend owns — never the chat manager, never
 * in an idle sweep, never persisted in the chat `tmux_sessions` table. The
 * handle's `extra` is the durable record; observation is file-based
 * (agy-files.ts / agy-observe.ts), so it re-attaches after a router restart.
 */
import { existsSync, readFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { StartupTimeoutError, TmuxCliManager, TmuxSendError } from '../../tmux/manager'
import { resolveBin, type SpawnOptions } from '../../tmux/profile'
import { createAgyProfile } from '../../tmux/profiles/agy'
import type {
  AttemptContext, BackendCapabilities, BackendEvent, BackendHandle, LocateResult, NotSent, OpenResult, ReleaseResult, SubmitResult, TaskBackend,
} from './backend'
import { emptyHandle, notSent } from './backend'
import { dialogRequestId } from './agy-dialog'
import { handleFrom, promptDigest, readConversationId, readExtra, readStopAfter, scanTranscript, stopSignalMtime, type AgyExtra } from './agy-files'
import { AgyObserver, type AgyAttemptState, type AgyObserveTiming } from './agy-observe'

/** Name of the repo's agy hooks plugin (agy-plugin/plugin.json). */
const PLUGIN_NAME = 'feishu-router'
const DEFAULT_BRAIN_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'brain')
const DEFAULT_AGY_CONFIG_DIR = join(homedir(), '.gemini', 'config')
const AGY_CANDIDATES = [join(homedir(), '.local', 'bin', 'agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy']
const VERIFY_GONE_MS = 2_000
const CONFIRM_DIALOG_MS = 2_500

export function taskSessionName(executionAttemptId: string): string {
  return `rtask-${executionAttemptId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

export interface AgyTmuxBackendOptions {
  /** Binary or argv prefix (tests: [bun, fake-agy-task.ts, --brain, dir]). Default: resolved `agy`. */
  bin?: string | string[]
  /** `--effort` for every attempt (config taskService.backends.agy.effort). */
  effort?: string | null
  /** `--mode` used in backend_policy mode only (config taskService.backends.agy.permissionMode). */
  permissionMode?: string | null
  /** Overrides for tests. */
  brainDir?: string
  agyConfigDir?: string
  /** Hooks-plugin check; default reads `<agyConfigDir>/plugins/feishu-router` and config.json's enabled flag. */
  pluginInstalled?: () => boolean
  startupTimeoutMs?: number
  timing?: Partial<AgyObserveTiming>
  dbg?: (msg: string) => void
}

const DEFAULT_TIMING: AgyObserveTiming = { pollMs: 400, postStopQuietMs: 800, dialogCheckMs: 1_500, deliveryProofTimeoutMs: 60_000 }

/** File-based check that `agy plugin install ./agy-plugin` was run and the plugin is not disabled. */
export function agyHooksPluginInstalled(agyConfigDir = DEFAULT_AGY_CONFIG_DIR): boolean {
  if (!existsSync(join(agyConfigDir, 'plugins', PLUGIN_NAME, 'hooks.json'))) return false
  try {
    const cfg = JSON.parse(readFileSync(join(agyConfigDir, 'config.json'), 'utf8')) as { plugins?: Record<string, { enabled?: unknown }> }
    return cfg.plugins?.[PLUGIN_NAME]?.enabled !== false
  } catch {
    return true  // no config.json (or unreadable): plugins default to enabled
  }
}

function binaryExists(bin: string): boolean {
  return bin.includes('/') ? existsSync(bin) : Bun.which(bin) !== null
}

export class AgyTmuxBackend implements TaskBackend {
  readonly kind = 'agy' as const
  readonly mode = 'tmux' as const
  private readonly binArgv: string[]
  private readonly brainDir: string
  private readonly timing: AgyObserveTiming
  private readonly manager: TmuxCliManager
  /** attemptId -> signal dir, consulted by the profile at spawn time. */
  private readonly signalDirs = new Map<string, string>()
  private readonly states = new Map<string, AgyAttemptState>()

  constructor(private readonly options: AgyTmuxBackendOptions = {}) {
    this.binArgv = Array.isArray(options.bin) ? options.bin : [options.bin ?? resolveBin('agy', AGY_CANDIDATES)]
    this.brainDir = options.brainDir ?? DEFAULT_BRAIN_DIR
    this.timing = { ...DEFAULT_TIMING, ...options.timing }
    const profile = createAgyProfile({
      bin: this.binArgv,
      brainDir: this.brainDir,
      sessionName: taskSessionName,
      signalDirFor: key => this.signalDirs.get(key) ?? join(tmpdir(), 'feishu-agy-task', taskSessionName(key)),
      resumable: false,
    })
    // No persistence: the task handle is the durable record, never the chat tmux_sessions table.
    this.manager = new TmuxCliManager(profile, { dbg: options.dbg, startupTimeoutMs: options.startupTimeoutMs })
  }

  private state(attemptId: string): AgyAttemptState {
    let s = this.states.get(attemptId)
    if (!s) {
      s = { interrupted: false, releasing: false, pendingDialog: null, allowed: false }
      this.states.set(attemptId, s)
    }
    return s
  }

  /** Register and return the attempt's facts; the signal dir is always `<runDir>/agy-signal`. */
  private extraFor(ctx: AttemptContext, handle: BackendHandle): AgyExtra {
    const extra = readExtra(handle, { sessionName: taskSessionName(ctx.executionAttemptId), signalDir: join(ctx.runDir, 'agy-signal') })
    this.signalDirs.set(ctx.executionAttemptId, extra.signalDir)
    return extra
  }

  private unavailableReason(): string | null {
    if (!binaryExists(this.binArgv[0])) return `agy binary not found (${this.binArgv[0]})`
    if (Bun.which('tmux') === null) return 'tmux not found'
    const pluginOk = this.options.pluginInstalled ? this.options.pluginInstalled() : agyHooksPluginInstalled(this.options.agyConfigDir)
    if (!pluginOk) return 'agy hooks plugin not installed (agy plugin install ./agy-plugin)'
    return null
  }

  async capabilities(): Promise<BackendCapabilities> {
    const reason = this.unavailableReason()
    return {
      kind: 'agy', mode: 'tmux', available: reason === null, availabilityReason: reason,
      features: { isolatedSession: true, samePrimaryTurns: false, recoverAcceptedTurn: true, permissionReply: true, cancel: false, eventReplay: false },
      permissionModes: ['broker', 'backend_policy'],
      fallback: {
        orderedFallback: false,
        supportedFallbackTriggers: [{ code: 'backend_unavailable', stage: 'before_delivery' }, { code: 'startup_failed', stage: 'before_delivery' }],
        cleanFailureFallback: false, checkpointHandoff: false, sameOwnerResetRecovery: false, nativeGoal: false,
      },
    }
  }

  async preflight(_ctx?: AttemptContext, _signal?: AbortSignal): Promise<{ kind: 'ok' } | NotSent> {
    const reason = this.unavailableReason()
    return reason === null ? { kind: 'ok' } : notSent('backend_unavailable', reason)
  }

  async open(ctx: AttemptContext, signal: AbortSignal): Promise<OpenResult> {
    const extra = this.extraFor(ctx, emptyHandle('pending'))
    const key = ctx.executionAttemptId
    if (await this.manager.hasLiveSession(key)) {
      return notSent('startup_failed', `tmux session ${extra.sessionName} already exists`, false)
    }
    try {
      await this.manager.ensureSession(ctx.workdir.canonicalPath, this.spawnOptions(ctx), { sessionKey: key, requireReady: true })
    } catch (e) {
      const detail = e instanceof StartupTimeoutError ? `agy did not become ready: ${e.message}` : `agy failed to start: ${errorText(e)}`
      return notSent('startup_failed', detail, await this.killAndVerify(key))
    }
    if (signal.aborted) return notSent('startup_failed', 'open aborted', await this.killAndVerify(key))
    return { kind: 'opened', handle: handleFrom(emptyHandle('pending'), extra) }
  }

  private spawnOptions(ctx: AttemptContext): SpawnOptions {
    const policyMode = ctx.permissionMode === 'backend_policy' ? this.options.permissionMode : null
    return {
      model: ctx.candidate.model,
      ...(this.options.effort ? { effort: this.options.effort } : {}),
      // Broker mode keeps agy's default mode so every permission prompt reaches the broker.
      ...(policyMode ? { permissionMode: policyMode } : {}),
    }
  }

  async submit(ctx: AttemptContext, handle: BackendHandle, input: { inputKind: 'text' | 'native_goal'; prompt: string }, _signal?: AbortSignal): Promise<SubmitResult> {
    if (input.inputKind !== 'text') return notSent('capability_unavailable', 'agy accepts text input only')
    const prepared: AgyExtra = {
      ...this.extraFor(ctx, handle),
      promptSha256: promptDigest(input.prompt),
      submittedAtMs: Date.now(),
      stopBaselineMs: stopSignalMtime(join(ctx.runDir, 'agy-signal')),
    }
    try {
      await this.manager.sendText(ctx.executionAttemptId, input.prompt)
    } catch (e) {
      const stage = e instanceof TmuxSendError ? e.stage : null
      if (stage === 'no_session' || stage === 'buffer') return notSent('startup_failed', errorText(e), false)
      return { kind: 'unknown', detail: `agy delivery ambiguous: ${errorText(e)}` }
    }
    return { kind: 'pending', handle: handleFrom(handle, prepared) }
  }

  observe(ctx: AttemptContext, handle: BackendHandle, signal: AbortSignal): AsyncIterable<BackendEvent> {
    const extra = this.extraFor(ctx, handle)
    const observer = new AgyObserver(
      { manager: this.manager, brainDir: this.brainDir, timing: this.timing, state: this.state(ctx.executionAttemptId) },
      ctx, handle, extra,
    )
    return observer.run(signal)
  }

  async replyPermission(ctx: AttemptContext, _h: BackendHandle, backendRequestId: string, decision: 'allow_once' | 'deny_once'): Promise<'confirmed' | 'unknown'> {
    const key = ctx.executionAttemptId
    const state = this.state(key)
    const pending = state.pendingDialog
    if (!pending || pending.id !== backendRequestId || !(await this.dialogStillShown(key, backendRequestId))) return 'unknown'
    const option = decision === 'allow_once' ? pending.pair.allow : pending.pair.deny
    if (!(await this.manager.selectOption(key, option.number))) return 'unknown'
    if (decision === 'allow_once') state.allowed = true
    const deadline = Date.now() + CONFIRM_DIALOG_MS
    while (Date.now() < deadline) {
      await Bun.sleep(150)
      if (!(await this.dialogStillShown(key, backendRequestId))) return 'confirmed'
    }
    return 'unknown'
  }

  private async dialogStillShown(key: string, id: string): Promise<boolean> {
    const pane = await this.manager.capturePlainPane(key)
    const dialog = pane ? this.manager.profile.parseDialog(pane) : null
    return !!dialog && dialogRequestId(dialog) === id
  }

  async interrupt(ctx: AttemptContext, _handle?: BackendHandle): Promise<void> {
    this.state(ctx.executionAttemptId).interrupted = true
    await this.manager.sendEscape(ctx.executionAttemptId)
  }

  async release(ctx: AttemptContext, handle: BackendHandle, graceMs: number): Promise<ReleaseResult> {
    const key = ctx.executionAttemptId
    const extra = this.extraFor(ctx, handle)
    this.state(key).releasing = true
    if (await this.manager.hasLiveSession(key)) {
      if (!this.turnStopped(extra)) {
        await this.manager.sendEscape(key)
        await this.waitForStop(extra, graceMs)
      }
    }
    const gone = await this.killAndVerify(key)
    if (gone) { this.states.delete(key); this.signalDirs.delete(key) }
    return {
      released: gone ? true : null,
      backgroundWorkSettled: gone ? true : null,
      detail: gone ? `tmux session ${extra.sessionName} killed and verified gone` : `tmux session ${extra.sessionName} still exists after kill-session`,
    }
  }

  private turnStopped(extra: AgyExtra): boolean {
    return readStopAfter(extra.signalDir, extra.stopBaselineMs)?.wait === 'done'
  }

  private async waitForStop(extra: AgyExtra, graceMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, graceMs)
    while (Date.now() < deadline && !this.turnStopped(extra)) await Bun.sleep(100)
  }

  /** kill-session for this attempt's exact session name only, then prove `has-session` fails. */
  private async killAndVerify(key: string): Promise<boolean> {
    await this.manager.killSession(key)
    const deadline = Date.now() + VERIFY_GONE_MS
    while (Date.now() < deadline) {
      if (!(await this.manager.hasLiveSession(key))) return true
      await Bun.sleep(100)
    }
    return false
  }

  async locate(ctx: AttemptContext, handle: BackendHandle): Promise<LocateResult> {
    const extra = this.extraFor(ctx, handle)
    const stopped = this.turnStopped(extra)
    if (await this.manager.hasLiveSession(ctx.executionAttemptId)) return stopped ? 'ended' : 'running'
    const conversationId = extra.conversationId ?? readConversationId(extra.signalDir)
    if (!conversationId || !stopped) return 'absent'
    return scanTranscript(this.brainDir, conversationId, extra.promptSha256).inputStep !== null ? 'ended' : 'absent'
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
