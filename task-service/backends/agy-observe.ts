/**
 * Re-attachable observation of one agy task attempt (design doc §11.6).
 * Everything it needs is on disk (handle extras, the attempt's own signal
 * dir, the conversation transcript) or in the attempt's own tmux session, so
 * a fresh backend instance after a router restart observes the same turn.
 * It owns no time limits beyond the delivery-proof window.
 */
import type { TmuxCliManager } from '../../tmux/manager'
import { isAgyQuotaError } from '../../tmux/agy-errors'
import type { Dialog } from '../../tmux/dialog'
import type { AttemptContext, BackendEvent, BackendHandle } from './backend'
import { describeDialog, dialogRequestId, findDenyOption, permissionPair, type PermissionPair } from './agy-dialog'
import {
  handleFrom, readConversationId, readStopAfter, scanTranscript, transcriptSize, type AgyExtra, type StopState, type TurnScan,
} from './agy-files'

/** In-memory facts about an attempt this backend instance is driving. */
export interface AgyAttemptState {
  interrupted: boolean
  releasing: boolean
  pendingDialog: { id: string; dialog: Dialog; pair: PermissionPair } | null
  /** An allow was sent to a dialog: side effects are possible. */
  allowed: boolean
}

export interface AgyObserveTiming {
  pollMs: number
  /** After a Stop, how long transcript growth must stay quiet before the reply is final. */
  postStopQuietMs: number
  /** How long with no transcript growth before checking the pane for a menu. */
  dialogCheckMs: number
  /** After submit, how long without a USER_INPUT step before delivery is reported unknown. */
  deliveryProofTimeoutMs: number
}

export interface AgyObserveDeps {
  manager: TmuxCliManager
  brainDir: string
  timing: AgyObserveTiming
  state: AgyAttemptState
}

const STREAM_ID = 'reply'

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}

export class AgyObserver {
  private extra: AgyExtra
  private accepted = false
  private deliveryUnknownSent = false
  private lastText: string | null = null
  private readonly toolsSeen = new Set<string>()
  private lastSize = -1
  private lastGrowthMs = Date.now()
  private lastDialogCheckMs = 0
  private currentDialogId: string | null = null
  private readonly startedMs = Date.now()

  constructor(
    private readonly deps: AgyObserveDeps,
    private readonly ctx: AttemptContext,
    private readonly base: BackendHandle,
    extra: AgyExtra,
  ) {
    this.extra = extra
  }

  private get key(): string { return this.ctx.executionAttemptId }

  async *run(signal: AbortSignal): AsyncGenerator<BackendEvent> {
    while (!signal.aborted) {
      yield* this.discoverConversation()
      yield* this.readTranscript()
      const stop = this.accepted ? readStopAfter(this.extra.signalDir, this.extra.stopBaselineMs) : null
      if (stop) {
        const ended = yield* this.onStop(stop, signal)
        if (ended) return
        continue
      }
      if (!(await this.deps.manager.hasLiveSession(this.key))) {
        yield* this.onSessionGone()
        return
      }
      yield* this.checkDeliveryDeadline()
      yield* this.checkDialog()
      await sleep(this.deps.timing.pollMs, signal)
    }
  }

  private *discoverConversation(): Generator<BackendEvent> {
    if (this.extra.conversationId) return
    const id = readConversationId(this.extra.signalDir)
    if (!id) return
    this.extra = { ...this.extra, conversationId: id }
    yield { type: 'handle', handle: handleFrom(this.base, this.extra) }
  }

  private *readTranscript(): Generator<BackendEvent> {
    const conv = this.extra.conversationId
    if (!conv) return
    const size = transcriptSize(this.deps.brainDir, conv)
    if (size === this.lastSize) return
    this.lastSize = size
    this.lastGrowthMs = Date.now()
    yield* this.applyScan(scanTranscript(this.deps.brainDir, conv, this.extra.promptSha256))
  }

  private *applyScan(scan: TurnScan): Generator<BackendEvent> {
    if (scan.inputStep === null) return
    if (!this.accepted) {
      this.accepted = true
      this.extra = { ...this.extra, backendTurnId: `${this.extra.conversationId}:${scan.inputStep}` }
      yield { type: 'handle', handle: handleFrom(this.base, this.extra) }
      if (scan.positional) yield { type: 'diagnostic', detail: 'agy USER_INPUT step attributed by position (its text did not match the prompt digest)' }
      yield { type: 'delivery', status: 'accepted' }
    }
    for (const tool of scan.tools) {
      if (this.toolsSeen.has(tool.id)) continue
      this.toolsSeen.add(tool.id)
      yield { type: 'tool', toolCallId: tool.id, name: tool.name, status: 'started', ...(tool.summary ? { detail: tool.summary } : {}) }
      yield { type: 'activity', label: tool.name }
    }
    const text = scan.texts.join('\n\n')
    if (text && text !== this.lastText) {
      this.lastText = text
      yield { type: 'text', streamId: STREAM_ID, text, mode: 'snapshot' }
    }
  }

  /** Returns true when the turn ended (a turn.ended event was yielded). */
  private async *onStop(stop: StopState, signal: AbortSignal): AsyncGenerator<BackendEvent, boolean> {
    // The Stop hook can land before the last transcript lines are flushed.
    let quietSince = Date.now()
    while (!signal.aborted && Date.now() - quietSince < this.deps.timing.postStopQuietMs) {
      await sleep(Math.min(200, this.deps.timing.postStopQuietMs), signal)
      const before = this.lastSize
      yield* this.readTranscript()
      if (this.lastSize !== before) quietSince = Date.now()
    }
    if (signal.aborted) return false
    // Re-read: a later Stop (background work finishing) may have replaced this one meanwhile.
    const latest = readStopAfter(this.extra.signalDir, this.extra.stopBaselineMs) ?? stop
    if (latest.wait !== 'done') {
      // agy still runs background work and will wake itself; keep observing.
      this.extra = { ...this.extra, stopBaselineMs: latest.mtimeMs }
      yield { type: 'activity', label: 'background work running' }
      return false
    }
    yield* this.finish(latest)
    return true
  }

  private *finish(stop: StopState): Generator<BackendEvent> {
    for (const id of this.toolsSeen) yield { type: 'tool', toolCallId: id, name: 'tool', status: 'completed' }
    if (stop.error) {
      yield { type: 'diagnostic', detail: `agy stop error (${isAgyQuotaError(stop.error) ? 'quota_or_rate_limit' : 'other'}): ${stop.error}` }
    }
    const state = this.deps.state
    const outcome = state.interrupted ? 'cancelled' : stop.error ? 'failed' : 'completed'
    yield {
      type: 'turn.ended',
      outcome,
      finalText: this.lastText ?? '',
      protocol: { backendFinished: true, activeToolCount: 0, stopReason: stop.error ?? stop.terminationReason ?? 'stop' },
      process: { exitCode: null, signal: null, controlledShutdown: state.interrupted },
      ...(outcome === 'failed' ? { failureCode: 'execution_failed' as const } : {}),
      effects: this.toolsSeen.size === 0 && !state.allowed ? 'none' : 'unknown',
    }
  }

  private *onSessionGone(): Generator<BackendEvent> {
    // Our own release killed it: the caller is finalizing and stops observing.
    if (this.deps.state.releasing) return
    yield { type: 'lost', detail: `agy tmux session ${this.extra.sessionName} ended without a Stop signal for this turn` }
  }

  private *checkDeliveryDeadline(): Generator<BackendEvent> {
    if (this.accepted || this.deliveryUnknownSent) return
    const since = this.extra.submittedAtMs ?? this.startedMs
    if (Date.now() - since < this.deps.timing.deliveryProofTimeoutMs) return
    this.deliveryUnknownSent = true
    const why = this.extra.conversationId ? 'no USER_INPUT step for the prompt appeared' : 'no hook signal (conversation id) arrived — is the agy plugin installed?'
    yield { type: 'delivery', status: 'unknown', detail: `agy: keys were sent but ${why}` }
  }

  private async *checkDialog(): AsyncGenerator<BackendEvent> {
    const now = Date.now()
    const { dialogCheckMs } = this.deps.timing
    if (now - this.lastGrowthMs < dialogCheckMs || now - this.lastDialogCheckMs < dialogCheckMs) return
    this.lastDialogCheckMs = now
    const pane = await this.deps.manager.capturePlainPane(this.key)
    const dialog = pane ? this.deps.manager.profile.parseDialog(pane) : null
    const id = dialog ? dialogRequestId(dialog) : null
    if (id === this.currentDialogId) return
    yield* this.clearDialog()
    if (!dialog || !id) return
    this.currentDialogId = id
    yield* (this.ctx.permissionMode === 'broker' ? this.brokerDialog(id, dialog) : this.denyDialog(id, dialog))
  }

  private *clearDialog(): Generator<BackendEvent> {
    const pending = this.deps.state.pendingDialog
    this.currentDialogId = null
    if (!pending) return
    this.deps.state.pendingDialog = null
    yield { type: 'permission.cleared', backendRequestId: pending.id }
  }

  private *brokerDialog(id: string, dialog: Dialog): Generator<BackendEvent> {
    const pair = permissionPair(dialog)
    if (!pair) {
      yield { type: 'interaction.required', detail: `agy is showing a menu with no one-shot allow/deny pair: ${describeDialog(dialog)}` }
      return
    }
    this.deps.state.pendingDialog = { id, dialog, pair }
    yield { type: 'permission.requested', backendRequestId: id, toolCallId: null, toolName: 'agy permission dialog', description: describeDialog(dialog) }
  }

  /** backend_policy: nobody may approve — answer with the deny option and record it. */
  private async *denyDialog(id: string, dialog: Dialog): AsyncGenerator<BackendEvent> {
    const deny = findDenyOption(dialog)
    if (!deny) {
      yield { type: 'interaction.required', detail: `agy is showing a menu with no deny option: ${describeDialog(dialog)}` }
      return
    }
    const sent = await this.deps.manager.selectOption(this.key, deny.number)
    yield {
      type: 'tool', toolCallId: id, name: 'agy permission dialog', status: 'failed',
      detail: sent ? `denied by backend_policy: ${describeDialog(dialog)}` : `deny could not be sent (session gone): ${describeDialog(dialog)}`,
    }
  }
}
