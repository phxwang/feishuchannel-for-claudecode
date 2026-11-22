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
import { DIALOG_ESCAPE_CHOICE, type TmuxCliManager } from '../../tmux/manager'
import type { Dialog } from '../../tmux/dialog'
import type { SpawnOptions } from '../../tmux/profile'
import type { Candidate } from '../schema/primitives'
import {
  notSent, type AttemptContext, type BackendCapabilities, type BackendEvent, type BackendHandle,
  type LocateResult, type NotSent, type OpenResult, type ReleaseResult, type SubmitResult, type TaskBackend,
} from './backend'
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
  toolSeq: number
  openTools: string[]
  pending: Map<string, PendingDialog>
  finished: Promise<void>
}

const TRIGGERS: BackendCapabilities['fallback']['supportedFallbackTriggers'] = [
  { code: 'backend_unavailable', stage: 'before_delivery' },
  { code: 'startup_failed', stage: 'before_delivery' },
]

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
      fallback: { orderedFallback: true, supportedFallbackTriggers: TRIGGERS, cleanFailureFallback: false, checkpointHandoff: false, sameOwnerResetRecovery: false, nativeGoal: false },
    }
  }

  async preflight(ctx: AttemptContext): Promise<{ kind: 'ok' } | NotSent> {
    const a = await this.o.available().catch(e => ({ ok: false, reason: String(e) }))
    if (!a.ok) return notSent('backend_unavailable', a.reason ?? `${this.kind} is unavailable`)
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
    if (input.inputKind !== 'text') return notSent('capability_unavailable', 'native goal input is not supported')
    const workdir = ctx.workdir.canonicalPath
    if (this.o.manager.isBusy(workdir)) return notSent('backend_unavailable', `the ${this.kind} session for this workdir is busy`)
    const run: Run = {
      workdir, queue: [], wake: null, done: false, delivered: false, interrupted: false, stopError: null,
      toolSeq: 0, openTools: [], pending: new Map(), finished: Promise.resolve(),
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
      onStopError: error => { run.stopError = error; this.o.onStopError?.(workdir, error) },
    }).then(reply => {
      delivered()
      for (const id of run.openTools.splice(0)) push({ type: 'tool', toolCallId: id, name: 'tool', status: 'completed' })
      const outcome = run.interrupted ? 'cancelled' : run.stopError ? 'failed' : 'completed'
      push({
        type: 'turn.ended', outcome, finalText: reply || null,
        protocol: { backendFinished: true, activeToolCount: 0, stopReason: run.stopError ?? (run.interrupted ? 'interrupted' : null) },
        process: { exitCode: null, signal: null, controlledShutdown: run.interrupted },
        ...(outcome === 'failed' ? { failureCode: 'execution_failed' as const } : {}),
        effects: run.toolSeq === 0 && !run.stopError ? 'none' : 'unknown',
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
        if (next.type === 'turn.ended' || (next.type === 'delivery' && next.status === 'not_sent')) return
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
  }

  /** The session is shared per workdir and is never killed; release = this task's turn has ended. */
  async release(ctx: AttemptContext, _h: BackendHandle, graceMs: number): Promise<ReleaseResult> {
    const run = this.runs.get(ctx.executionAttemptId)
    if (!run) return { released: null, backgroundWorkSettled: null, detail: 'no in-memory record of this turn (router restarted?)' }
    if (!run.done) {
      await this.interrupt(ctx)
      const settled = await Promise.race([run.finished.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), graceMs))])
      if (!settled) return { released: false, backgroundWorkSettled: false, detail: `turn still running after ${graceMs} ms` }
    }
    this.runs.delete(ctx.executionAttemptId)
    return { released: true, backgroundWorkSettled: true, detail: `turn ended; shared ${this.kind} session for the workdir kept` }
  }

  async locate(ctx: AttemptContext): Promise<LocateResult> {
    const run = this.runs.get(ctx.executionAttemptId)
    if (!run) return 'unreachable'
    return run.done ? 'ended' : 'running'
  }
}
