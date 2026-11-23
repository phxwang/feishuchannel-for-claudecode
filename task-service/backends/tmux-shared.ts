/**
 * Task backend over the router's EXISTING tmux CLI managers (Claude Code,
 * Antigravity, Codex). It drives the same `TmuxCliManager.sendAndAwaitReply`
 * the Feishu path uses (tmux-route.ts), on the same per-workdir session: a
 * task on a workdir that already has a session reuses it; a new (e.g.
 * temporary) workdir gets its own session. Only the presentation differs:
 * events go to the task ledger instead of Feishu cards.
 *
 * Contract inherited from the manager: sendAndAwaitReply throwing means the
 * message never reached the CLI (pre-delivery, safe to fall back).
 */
import { DIALOG_ESCAPE_CHOICE, type TmuxCliManager, type WaitEndReason } from '../../tmux/manager'
import type { GoalState } from '../../tmux/goal'
import { stripAnsi, type Dialog } from '../../tmux/dialog'
import { runTmux } from '../../tmux/tmux-exec'
import type { SpawnOptions } from '../../tmux/profile'
import type { Candidate } from '../schema/primitives'
import {
  notSent, type AttemptContext, type BackendCapabilities, type BackendEvent, type BackendHandle,
  type LocateResult, type NotSent, type OpenResult, type ReleaseResult, type SubmitResult, type TaskBackend,
} from './backend'
import type { AuthCheck } from './claude-auth'
import { describeDialog, dialogRequestId, findDenyOption, permissionPair } from './dialog-permission'

export type TmuxTaskKind = 'claude' | 'agy' | 'codex'

export interface SharedTmuxBackendOptions {
  kind: TmuxTaskKind
  /** The router's own manager instance for this CLI (shared with chat). */
  manager: TmuxCliManager
  /** Spawn flags for a fresh session; reuses the router's resolution (e.g. resolveAgySpawnOptions). */
  spawnFor: (candidate: Candidate, workdir: string) => SpawnOptions
  /** Binary/plugin availability check. */
  available: () => Promise<{ ok: boolean; reason?: string }>
  /** Router-side "temporarily unavailable" state (e.g. agy quota cooldown); null = fine. */
  unavailableReason?: (workdir: string) => string | null
  /**
   * Credential probe run in preflight (Claude: `claude auth status`). Only a
   * positive "invalid" result is reported as `authentication_invalid`.
   */
  authCheck?: AuthCheck
  /** Router-side handling of a CLI-reported stop error (e.g. mark agy degraded). */
  onStopError?: (workdir: string, error: string) => void
}

interface PendingDialog { requestId: string; dialog: Dialog; resolve: (choice: number) => void }

interface Run {
  workdir: string
  queue: BackendEvent[]
  wake: (() => void) | null
  done: boolean
  delivered: boolean
  interrupted: boolean
  stopError: string | null
  /** The CLI's category for stopError, when it gives one. */
  stopCode: string | null
  endReason: WaitEndReason | null
  /** native_goal input: completion requires the goal to be achieved, not just a turn to stop. */
  goalInput: boolean
  goal: GoalState
  /** `/goal clear` already typed for this run. */
  goalCleared: boolean
  toolSeq: number
  openTools: string[]
  pending: Map<string, PendingDialog>
  finished: Promise<void>
}

/**
 * Wait-end reasons that mean the CLI really finished: the agent AND all its
 * subtasks have stopped. 'background_idle' is excluded — the manager gave up
 * waiting on background work it never saw end, so completion is unproven
 * (chat still shows that reply; a task must not report it as completed).
 */
const COMPLETED_REASONS: ReadonlySet<WaitEndReason> = new Set<WaitEndReason>(['stop', 'local_command', 'quiet'])

/** Let the CLI settle the Esc before typing `/goal clear` into its prompt. */
const GOAL_CLEAR_DELAY_MS = 300

const TRIGGERS: BackendCapabilities['fallback']['supportedFallbackTriggers'] = [
  { code: 'backend_unavailable', stage: 'before_delivery' },
  { code: 'startup_failed', stage: 'before_delivery' },
]
/** With a credential probe (Claude): auth failure before delivery (`auth status`) and as a turn's first-request API error. */
const AUTH_TRIGGERS = [
  { code: 'authentication_invalid', stage: 'before_delivery' },
  { code: 'authentication_invalid', stage: 'clean_failure' },
] as const

/**
 * CLI error categories that mean "auth failed" although the CLI is logged in
 * (Claude: account verification required via the Verification Portal, or
 * rejected credentials). Everything else (rate_limit, server_error …) stays
 * execution_failed and is never an auth fallback.
 */
const AUTH_ERROR_CODES: ReadonlySet<string> = new Set(['verification_required', 'authentication_failed'])

export class SharedTmuxBackend implements TaskBackend {
  readonly kind: TmuxTaskKind
  readonly mode = 'tmux' as const
  private runs = new Map<string, Run>()

  constructor(private readonly o: SharedTmuxBackendOptions) {
    this.kind = o.kind
  }

  async capabilities(): Promise<BackendCapabilities> {
    const a = await this.o.available().catch(e => ({ ok: false, reason: String(e) }))
    return {
      kind: this.kind, mode: this.mode, available: a.ok, availabilityReason: a.ok ? null : (a.reason ?? 'unavailable'),
      // Sessions are per workdir and shared with chat; a turn in flight lives only in router memory.
      features: { isolatedSession: false, samePrimaryTurns: false, recoverAcceptedTurn: false, permissionReply: true, cancel: true, eventReplay: true },
      permissionModes: ['broker', 'backend_policy'],
      fallback: { orderedFallback: true, supportedFallbackTriggers: this.o.authCheck ? [...TRIGGERS, ...AUTH_TRIGGERS] : TRIGGERS,
        // Clean-failure classification exists only for the auth case; its effects evidence is "no tool ran".
        cleanFailureFallback: Boolean(this.o.authCheck), checkpointHandoff: false, sameOwnerResetRecovery: false, nativeGoal: this.supportsGoals() },
    }
  }

  /** Native goals need a profile that can read the CLI's goal verdicts (tmux/goal.ts). */
  private supportsGoals(): boolean {
    return typeof this.o.manager.profile.parseGoalSignal === 'function'
  }

  async preflight(ctx: AttemptContext): Promise<{ kind: 'ok' } | NotSent> {
    const a = await this.o.available().catch(e => ({ ok: false, reason: String(e) }))
    if (!a.ok) return notSent('backend_unavailable', a.reason ?? `${this.kind} is unavailable`)
    // Positive proof of bad credentials only; an unreadable status lets the attempt proceed (never a fallback trigger).
    if (this.o.authCheck) {
      const auth = await this.o.authCheck().catch(e => ({ state: 'unknown' as const, detail: String(e) }))
      if (auth.state === 'invalid') return notSent('authentication_invalid', auth.detail)
    }
    const workdir = ctx.workdir.canonicalPath
    const degraded = this.o.unavailableReason?.(workdir)
    if (degraded) return notSent('backend_unavailable', degraded)
    // A busy shared session would absorb or queue the input into someone else's turn.
    if (this.o.manager.isBusy(workdir)) return notSent('backend_unavailable', `the ${this.kind} session for this workdir is busy`)
    return { kind: 'ok' }
  }

  async open(ctx: AttemptContext): Promise<OpenResult> {
    const workdir = ctx.workdir.canonicalPath
    return {
      kind: 'opened',
      handle: {
        backendSessionId: this.o.manager.profile.sessionName(workdir), backendTurnId: `tmux:${ctx.executionAttemptId}`,
        pid: null, pgid: null, processStartIdentity: null, extra: { workdir },
      },
    }
  }

  async submit(ctx: AttemptContext, _h: BackendHandle, input: { inputKind: 'text' | 'native_goal'; prompt: string }): Promise<SubmitResult> {
    const goalInput = input.inputKind === 'native_goal'
    if (goalInput && !this.supportsGoals()) return notSent('capability_unavailable', `${this.kind} has no native goal support`)
    const workdir = ctx.workdir.canonicalPath
    if (this.o.manager.isBusy(workdir)) return notSent('backend_unavailable', `the ${this.kind} session for this workdir is busy`)
    const run: Run = {
      workdir, queue: [], wake: null, done: false, delivered: false, interrupted: false, stopError: null, stopCode: null, endReason: null,
      goalInput, goal: 'none', goalCleared: false, toolSeq: 0, openTools: [], pending: new Map(), finished: Promise.resolve(),
    }
    this.runs.set(ctx.executionAttemptId, run)
    const push = (e: BackendEvent) => { run.queue.push(e); run.wake?.() }
    const delivered = () => { if (!run.delivered) { run.delivered = true; push({ type: 'delivery', status: 'accepted' }) } }
    run.finished = this.o.manager.sendAndAwaitReply(workdir, input.prompt, {
      ...this.o.spawnFor(ctx.candidate, workdir),
      onTextChunk: text => { delivered(); push({ type: 'text', streamId: 'reply', text, mode: 'append' }) },
      onProgress: events => {
        delivered()
        for (const ev of events) {
          const id = `t${++run.toolSeq}`
          run.openTools.push(id)
          push({ type: 'tool', toolCallId: id, name: ev.tool, status: 'started', detail: ev.summary })
        }
      },
      onDialog: dialog => { delivered(); return this.onDialog(ctx, run, dialog, push) },
      onAbsorbed: () => { delivered(); push({ type: 'diagnostic', detail: 'input was folded into a turn already in flight on this session' }) },
      onStopError: (error, code) => { run.stopError = error; run.stopCode = code ?? null; this.o.onStopError?.(workdir, error) },
      onWaitEnded: (reason, info) => { run.endReason = reason; run.goal = info?.goal ?? 'none' },
    }).then(reply => {
      delivered()
      for (const id of run.openTools.splice(0)) push({ type: 'tool', toolCallId: id, name: 'tool', status: 'completed' })
      // Only a real end of turn is a completion; giving up (session killed by /restart, timeout, idle, dropped dialog) is not.
      // A /goal task is complete only once its goal is achieved (cleared, interrupted or never set is not).
      const turnStopped = run.endReason !== null && COMPLETED_REASONS.has(run.endReason)
      const goalMissed = run.goalInput && run.goal !== 'achieved'
      const finishedTurn = turnStopped && !goalMissed
      const outcome = run.interrupted ? 'cancelled' : run.stopError || !finishedTurn ? 'failed' : 'completed'
      const authFailed = run.stopCode !== null && AUTH_ERROR_CODES.has(run.stopCode)
      const unfinishedReason = !turnStopped ? `reply wait ended: ${run.endReason ?? 'unknown'}` : `goal ${run.goal}, not achieved`
      push({
        type: 'turn.ended', outcome, finalText: reply || null,
        protocol: {
          backendFinished: finishedTurn, activeToolCount: 0,
          stopReason: run.stopError ?? (run.interrupted ? 'interrupted' : finishedTurn ? null : unfinishedReason),
        },
        process: { exitCode: null, signal: null, controlledShutdown: run.interrupted },
        ...(outcome === 'failed' ? { failureCode: authFailed ? 'authentication_invalid' as const : 'execution_failed' as const } : {}),
        // An auth rejection with no tool call means nothing ran: the request itself was refused.
        effects: run.toolSeq === 0 && (!run.stopError || authFailed) ? 'none' : 'unknown',
      })
    }, err => {
      // By the manager's contract a throw means the input never reached the CLI.
      push({ type: 'delivery', status: 'not_sent', failure: notSent('startup_failed', err instanceof Error ? err.message : String(err), true) })
    }).finally(() => { run.done = true; run.wake?.() })
    return { kind: 'pending' }
  }

  private onDialog(ctx: AttemptContext, run: Run, dialog: Dialog, push: (e: BackendEvent) => void): Promise<number> {
    if (ctx.permissionMode !== 'broker') {
      const deny = findDenyOption(dialog)
      push({ type: 'tool', toolCallId: `dlg${++run.toolSeq}`, name: 'permission', status: 'failed', detail: `denied by backend_policy: ${describeDialog(dialog)}` })
      return Promise.resolve(deny ? Number(deny.number) : DIALOG_ESCAPE_CHOICE)
    }
    const requestId = dialogRequestId(dialog)
    const pair = permissionPair(dialog)
    if (pair) push({ type: 'permission.requested', backendRequestId: requestId, toolCallId: null, toolName: 'permission', description: describeDialog(dialog) })
    else push({ type: 'interaction.required', detail: describeDialog(dialog) })
    return new Promise<number>(resolve => {
      run.pending.set(requestId, { requestId, dialog, resolve: choice => { run.pending.delete(requestId); resolve(choice) } })
    })
  }

  async *observe(ctx: AttemptContext, _h: BackendHandle, signal: AbortSignal): AsyncIterable<BackendEvent> {
    const run = this.runs.get(ctx.executionAttemptId)
    if (!run) { yield { type: 'lost', detail: 'the router restarted while this turn was in flight; its reply cannot be recovered' }; return }
    while (!signal.aborted) {
      const next = run.queue.shift()
      if (next) {
        yield next
        if (next.type === 'delivery' && next.status === 'not_sent') { this.runs.delete(ctx.executionAttemptId); return }
        if (next.type === 'turn.ended') return
        continue
      }
      if (run.done) return
      await new Promise<void>(resolve => {
        run.wake = () => { run.wake = null; resolve() }
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  }

  async replyPermission(ctx: AttemptContext, _h: BackendHandle, backendRequestId: string, decision: 'allow_once' | 'deny_once'): Promise<'confirmed' | 'unknown'> {
    const run = this.runs.get(ctx.executionAttemptId)
    const p = run?.pending.get(backendRequestId)
    if (!run || !p) return 'unknown'
    const pair = permissionPair(p.dialog)
    const option = decision === 'allow_once' ? pair?.allow : (pair?.deny ?? findDenyOption(p.dialog))
    p.resolve(option ? Number(option.number) : DIALOG_ESCAPE_CHOICE)
    run.queue.push({ type: 'permission.cleared', backendRequestId })
    run.wake?.()
    return 'confirmed'
  }

  async interrupt(ctx: AttemptContext, _h?: BackendHandle): Promise<void> {
    const run = this.runs.get(ctx.executionAttemptId)
    if (!run || run.done) return
    run.interrupted = true
    for (const p of [...run.pending.values()]) p.resolve(DIALOG_ESCAPE_CHOICE)
    await this.o.manager.sendEscape(run.workdir)
    // Esc stops the turn but leaves the goal armed: its Stop hook would keep
    // driving the shared session. Clearing it also ends the reply wait. Only
    // while this run's wait still owns the session — once it has ended, the
    // session may already be running someone else's message (release() then
    // clears it only if the session is free).
    if (run.goalInput) {
      await new Promise(r => setTimeout(r, GOAL_CLEAR_DELAY_MS))
      if (!run.done && !run.goalCleared) {
        run.goalCleared = true
        await this.o.manager.sendLine(run.workdir, '/goal clear')
      }
    }
  }

  /**
   * After a goal run ended without its goal achieved or cleared (timeout,
   * dropped dialog, denied tool, Esc …), the goal is still armed in the CLI
   * and would keep driving turns on the shared session. Disarm it: Escape,
   * then `/goal clear` — unless another caller is already using the session.
   */
  private async disarmGoal(run: Run): Promise<string> {
    if (!run.goalInput || run.goalCleared || run.goal === 'achieved' || run.goal === 'cleared') return ''
    if (this.o.manager.isBusy(run.workdir)) return '; goal may still be armed: the session is busy with another caller'
    run.goalCleared = true
    try {
      await this.o.manager.sendEscape(run.workdir)
      await new Promise(r => setTimeout(r, GOAL_CLEAR_DELAY_MS))
      return (await this.o.manager.sendLine(run.workdir, '/goal clear')) ? '; unfinished goal cleared' : '; session gone, goal cleared with it'
    } catch (e) {
      return `; clearing the unfinished goal failed: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  /** The session is shared per workdir and is never killed; release = this task's turn has ended. */
  async release(ctx: AttemptContext, h: BackendHandle, graceMs: number): Promise<ReleaseResult> {
    const run = this.runs.get(ctx.executionAttemptId)
    if (!run) return this.releaseOrphan(ctx, h, graceMs)
    if (!run.done) {
      await this.interrupt(ctx)
      const settled = await Promise.race([run.finished.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), graceMs))])
      if (!settled) return { released: false, backgroundWorkSettled: false, detail: `turn still running after ${graceMs} ms` }
    }
    const goalNote = await this.disarmGoal(run)
    this.runs.delete(ctx.executionAttemptId)
    return { released: true, backgroundWorkSettled: true, detail: `turn ended; shared ${this.kind} session for the workdir kept${goalNote}` }
  }

  /**
   * After a router restart the turn is no longer tracked in memory. The session
   * name is the exact identity: gone → nothing is left running; present → press
   * Escape (as /esc does) and require the CLI's ready prompt before reporting release.
   */
  private async releaseOrphan(ctx: AttemptContext, h: BackendHandle, graceMs: number): Promise<ReleaseResult> {
    const name = h.backendSessionId ?? this.o.manager.profile.sessionName(ctx.workdir.canonicalPath)
    const alive = async () => (await runTmux(['has-session', '-t', name])).ok
    const ready = async () => {
      const pane = await runTmux(['capture-pane', '-p', '-t', name])
      return pane.ok && this.o.manager.profile.isReady(stripAnsi(pane.stdout))
    }
    try {
      if (!(await alive())) return { released: true, backgroundWorkSettled: true, detail: `session ${name} no longer exists` }
      if (await ready()) return { released: true, backgroundWorkSettled: null, detail: `session ${name} is idle at its prompt` }
      await this.o.manager.sendEscape(ctx.workdir.canonicalPath)
      const end = Date.now() + graceMs
      while (Date.now() < end) {
        if (!(await alive()) || await ready()) return { released: true, backgroundWorkSettled: null, detail: `interrupted the orphaned turn in ${name}` }
        await new Promise(r => setTimeout(r, 250))
      }
      return { released: false, backgroundWorkSettled: false, detail: `session ${name} did not return to its prompt after Escape` }
    } catch (e) {
      return { released: null, backgroundWorkSettled: null, detail: `could not inspect session ${name}: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  async locate(ctx: AttemptContext): Promise<LocateResult> {
    const run = this.runs.get(ctx.executionAttemptId)
    if (!run) return 'unreachable'
    return run.done ? 'ended' : 'running'
  }
}
