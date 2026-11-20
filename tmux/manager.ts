/**
 * Generic "interactive CLI in a detached tmux session per workdir" manager.
 * Extracted from claude-tmux-worker.ts so Claude Code and Antigravity (agy)
 * share one implementation; everything CLI-specific lives in a
 * TmuxCliProfile (tmux/profiles/*). See claude-tmux-worker.ts's header for
 * the original rationale (terminal keystrokes carry no "untrusted channel
 * data" framing).
 *
 * Delivery contract (relied on by router.ts's fallback logic): everything
 * before the message is pasted into the pane either throws (nothing was
 * delivered — safe to hand the task to another backend) or succeeds; once
 * pasted, nothing throws past sendAndAwaitReply — failures while waiting
 * are swallowed and whatever text was collected is returned.
 */
import { existsSync, readFileSync, statSync } from 'fs'
import { randomUUID } from 'crypto'
import { runTmux } from './tmux-exec'
import {
  cursorMovesToReach, rightPressesToReach, stripAnsi,
  type Dialog, type DialogOption,
} from './dialog'
import type { ProgressEvent, SpawnOptions, TmuxCliProfile } from './profile'

/** True once `quietMs` have passed since `lastChangeAtMs`. */
export function isQuietDone(lastChangeAtMs: number, nowMs: number, quietMs: number): boolean {
  return nowMs - lastChangeAtMs >= quietMs
}

/**
 * Resolve with the chosen option's number, `DIALOG_ESCAPE_CHOICE` for a
 * caller-side "just press Escape" button, or `DIALOG_TIMED_OUT_CHOICE` if
 * nobody answered. Any other value is an explicit cancellation (e.g. the
 * router's `/esc`/`/restart` already dealt with the session) — which, unlike
 * a timeout, gets no automatic Escape.
 */
export type DialogHandler = (dialog: Dialog) => Promise<number>
export const DIALOG_ESCAPE_CHOICE = 0
export const DIALOG_TIMED_OUT_CHOICE = -1
/** Called (rate-limited) with the raw ANSI pane when the session looks stuck on something that isn't a parseable dialog. Informational only. */
export type StuckPaneHandler = (paneAnsiText: string) => Promise<void>
/** Called with the raw ANSI pane right after a 'tabs' choice's Right presses land, so the caller can show where it actually ended up. */
export type TabSwitchedHandler = (paneAnsiText: string) => Promise<void>
/** Synchronous, fire-and-forget: newly-seen tool calls. Must not throw or block. */
export type ProgressHandler = (events: ProgressEvent[]) => void
/** Synchronous, fire-and-forget: each new reply text block as soon as it's read. Must not throw or block. */
export type TextChunkHandler = (text: string) => void

export interface SendAndAwaitReplyOptions extends SpawnOptions {
  onDialog?: DialogHandler
  onStuckPane?: StuckPaneHandler
  onTabSwitched?: TabSwitchedHandler
  onProgress?: ProgressHandler
  onTextChunk?: TextChunkHandler
  /** 'absorb' CLIs only: called before delivery when this message is being folded into an in-flight turn; the call then resolves with that turn's result. */
  onAbsorbed?: () => void
  /** 'queue' CLIs only: called before delivery when this message is queued behind an in-flight turn; the call still resolves with its own turn's text. */
  onQueued?: () => void
  /** 'queue' CLIs only: called when this queued message's own turn becomes the current one. */
  onTurnStarted?: () => void
  /** A turn stopped with an error the CLI reported (e.g. agy quota exhausted). Fire-and-forget. */
  onStopError?: (error: string) => void
}

export interface TmuxManagerOptions {
  dbg?: (msg: string) => void
  /** Fixed pane size so the CLI's UI doesn't reflow mid-session. */
  cols?: number
  rows?: number
  /** How long to wait for a fresh session to show its ready marker before typing into it. */
  startupTimeoutMs?: number
  /** Quiet period used only when there's no stop signal to watch. */
  quietMs?: number
  /** Hard cap on waiting for a reply (refreshed after each dialog answer / queued hand-off). */
  replyTimeoutMs?: number
  /** After a stop signal, how long transcript growth must stay quiet before trusting the turn is done. */
  postStopQuietMs?: number
  /** After a stop that left only uncertain background work pending, how long with no transcript growth before giving up on it. */
  backgroundIdleCapMs?: number
  /** How long with no transcript growth before checking the pane for a pending dialog. */
  dialogCheckMs?: number
  /** How long with no transcript growth before treating the pane as stuck (onStuckPane). */
  stuckPaneCheckMs?: number
  /** Minimum gap between successive onStuckPane calls within one reply wait. */
  stuckPaneCooldownMs?: number
  /** Durable workdir -> session id storage, so a router restart can reattach (and resumable CLIs can resume). */
  persistence?: {
    get(workdir: string): string | undefined
    set(workdir: string, sessionId: string): void
    delete(workdir: string): void
  }
}

interface TurnOwner {
  text: string
  opts: SendAndAwaitReplyOptions
  collected: string[]
  resolve: (text: string) => void
  reject: (error: unknown) => void
  /** onTurnStarted already fired (queued owners only). */
  started?: boolean
}

function newOwner(text: string, opts: SendAndAwaitReplyOptions): { owner: TurnOwner; done: Promise<string> } {
  let owner!: TurnOwner
  const done = new Promise<string>((resolve, reject) => { owner = { text, opts, collected: [], resolve, reject } })
  return { owner, done }
}

const normalizeInput = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * Index of the queued owner whose input the CLI just finished, by exact
 * (whitespace-normalized) match against the stop's reported
 * `lastUserInput`; 0 (the head) when nothing matches. Exact only — a
 * substring match would let a short message like "继续" settle a queued
 * "继续做X" too early. Picks the *last* exact match so a repeated message
 * settles every earlier identical owner.
 */
export function matchStoppedOwner(ownerTexts: string[], lastUserInput: string | undefined): number {
  if (!lastUserInput) return 0
  const reported = normalizeInput(lastUserInput)
  if (!reported) return 0
  let found = -1
  ownerTexts.forEach((t, i) => { if (normalizeInput(t) === reported) found = i })
  return found === -1 ? 0 : found
}

/** How long to wait, without any turn ever starting and with the CLI idle, before giving up on a non-slash message (e.g. the hook plugin isn't installed, so no stop signal will ever come). */
const NO_TURN_IDLE_MS = 20_000

export class TmuxCliManager {
  readonly profile: TmuxCliProfile
  private readonly dbg: (msg: string) => void
  private readonly cols: number
  private readonly rows: number
  private readonly startupTimeoutMs: number
  private readonly quietMs: number
  private readonly replyTimeoutMs: number
  private readonly postStopQuietMs: number
  private readonly backgroundIdleCapMs: number
  private readonly dialogCheckMs: number
  private readonly stuckPaneCheckMs: number
  private readonly stuckPaneCooldownMs: number
  private readonly persistence: TmuxManagerOptions['persistence']
  /** Workdirs with a confirmed live tmux session, to skip a has-session round-trip per message. */
  private knownAlive = new Set<string>()
  /** workdir -> live CLI session id (spawn-time for Claude, discovered from hook signals for agy). */
  private sessionIds = new Map<string, string>()
  /** workdir -> the in-flight reply wait, so a second message joins it instead of racing a second collect loop on the same pane. */
  private queues = new Map<string, Promise<string>>()
  /** workdir -> settles once the in-flight head message has been pasted (rejects if it never was). Later messages wait on it so they can't overtake the head. */
  private headDelivered = new Map<string, Promise<void>>()
  /** workdir -> FIFO of callers waiting on turns of the in-flight wait (length 1 unless the profile queues mid-turn messages). */
  private owners = new Map<string, TurnOwner[]>()
  /** workdir -> last time a message was sent to it, for killIdleSessions(). */
  private lastUsedAt = new Map<string, number>()
  /** workdir -> session epoch, bumped by killSession so an in-flight collect for the killed session stops. */
  private epochs = new Map<string, number>()

  constructor(profile: TmuxCliProfile, opts: TmuxManagerOptions = {}) {
    this.profile = profile
    this.dbg = opts.dbg ?? (() => {})
    this.cols = opts.cols ?? 220
    this.rows = opts.rows ?? 50
    this.startupTimeoutMs = opts.startupTimeoutMs ?? profile.startupTimeoutMs ?? 20_000
    this.quietMs = opts.quietMs ?? 2_500
    // A chain of self-continued turns can legitimately run for hours — this
    // is a last-resort ceiling against a genuinely stuck session.
    this.replyTimeoutMs = opts.replyTimeoutMs ?? 8 * 60 * 60 * 1000
    this.postStopQuietMs = opts.postStopQuietMs ?? 800
    this.backgroundIdleCapMs = opts.backgroundIdleCapMs ?? 2 * 60 * 60 * 1000
    this.dialogCheckMs = opts.dialogCheckMs ?? 1_500
    this.stuckPaneCheckMs = opts.stuckPaneCheckMs ?? 90_000
    this.stuckPaneCooldownMs = opts.stuckPaneCooldownMs ?? 5 * 60_000
    this.persistence = opts.persistence
  }

  private tag(): string { return `tmux[${this.profile.kind}]` }

  private async hasSession(name: string): Promise<boolean> {
    return (await runTmux(['has-session', '-t', name])).ok
  }

  /** `-e` keeps SGR escape codes for the stuck-pane screenshot; parsers strip them via stripAnsi(). */
  private async capturePane(name: string): Promise<string> {
    const r = await runTmux(['capture-pane', '-e', '-p', '-t', name])
    return r.ok ? r.stdout : ''
  }

  /**
   * Capture until `requiredStableReads` consecutive captures match (and, when
   * `baseline` is given, differ from it) — a fixed delay wasn't enough for a
   * tab whose content loads asynchronously. Gives up after maxWaitMs.
   */
  private async captureStablePane(name: string, baseline?: string, pollMs = 250, maxWaitMs = 4_000, requiredStableReads = 2): Promise<string> {
    const deadline = Date.now() + maxWaitMs
    let previous = await this.capturePane(name)
    let stableStreak = 0
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, pollMs))
      const current = await this.capturePane(name)
      if (current === previous && (baseline === undefined || current !== baseline)) {
        stableStreak++
        if (stableStreak >= requiredStableReads) return current
      } else {
        stableStreak = 0
      }
      previous = current
    }
    return previous
  }

  /** Bare Escape keypress to the workdir's session (dismisses a modal). No-op without a live session. */
  async sendEscape(workdir: string): Promise<void> {
    const name = this.profile.sessionName(workdir)
    if (!(await this.hasSession(name))) return
    await runTmux(['send-keys', '-t', name, 'Escape'])
  }

  /** Manual `/select <n>`: answer a numbered menu no card was sent for. False if there's no live session. */
  async selectOption(workdir: string, number: string): Promise<boolean> {
    const name = this.profile.sessionName(workdir)
    if (!(await this.hasSession(name))) return false
    await this.sendOptionKeys(name, { number, label: '' })
    return true
  }

  /**
   * Kill and respawn. `fresh: true` (default) forgets the session id so the
   * CLI starts a new conversation; `fresh: false` on a resumable profile
   * reattaches the same conversation (agy `--conversation`).
   */
  async restartSession(workdir: string, spawn: SpawnOptions = {}, fresh = true): Promise<string> {
    await this.killSession(workdir, { forget: fresh })
    return this.ensureSession(workdir, spawn)
  }

  private async sendOptionKeys(name: string, option: DialogOption): Promise<void> {
    for (const keys of this.profile.optionKeys(option)) await runTmux(['send-keys', '-t', name, ...keys])
  }

  private rememberSessionId(workdir: string, sessionId: string) {
    if (this.sessionIds.get(workdir) === sessionId) return
    this.sessionIds.set(workdir, sessionId)
    this.persistence?.set(workdir, sessionId)
  }

  /**
   * Ensure a live tmux session running the CLI exists for this workdir;
   * spawns one if missing. Spawn options only apply to a fresh spawn.
   */
  async ensureSession(workdir: string, spawn: SpawnOptions = {}): Promise<string> {
    const name = this.profile.sessionName(workdir)
    if (this.knownAlive.has(workdir) && await this.hasSession(name)) return name

    if (await this.hasSession(name)) {
      this.knownAlive.add(workdir)
      // Reattaching after a router restart: recover the session id so
      // transcript tailing targets the exact file.
      if (!this.sessionIds.has(workdir)) {
        const persisted = this.persistence?.get(workdir)
        if (persisted) {
          this.dbg(`${this.tag()}: reattached to ${workdir}'s live session, recovered session-id ${persisted}`)
          this.sessionIds.set(workdir, persisted)
        }
      }
      return name
    }

    const resumeId = this.profile.resumable ? this.persistence?.get(workdir) : undefined
    this.dbg(`${this.tag()}: no live session for ${workdir}, spawning ${name}${spawn.model ? ` (model: ${spawn.model})` : ''}${resumeId ? ` (resuming ${resumeId})` : ''}`)
    this.profile.prepareSpawn?.(workdir)
    const spawnStartMs = Date.now()
    const plan = this.profile.planSpawn(workdir, spawn, resumeId)
    const envArgs = Object.entries(plan.env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    const r = await runTmux([
      'new-session', '-d', '-s', name, '-c', workdir, '-x', String(this.cols), '-y', String(this.rows),
      ...envArgs, ...plan.argv,
    ])
    if (!r.ok) throw new Error(`tmux new-session failed: ${r.stderr || r.stdout}`)
    const sessionId = plan.sessionId ?? resumeId
    if (sessionId) this.rememberSessionId(workdir, sessionId)
    else { this.sessionIds.delete(workdir); this.persistence?.delete(workdir) }

    await this.waitForStartup(name, spawnStartMs)
    this.knownAlive.add(workdir)
    return name
  }

  /**
   * Poll the pane for the profile's ready marker. Throws if the tmux session
   * died during boot (e.g. binary not found) — that's still pre-delivery,
   * so the caller may fall back. A slow-but-alive boot just proceeds.
   */
  private async waitForStartup(name: string, spawnStartMs: number): Promise<void> {
    const deadline = spawnStartMs + this.startupTimeoutMs
    while (Date.now() < deadline) {
      const r = await runTmux(['capture-pane', '-p', '-t', name])
      if (!r.ok && !(await this.hasSession(name))) throw new Error(`${this.profile.label} exited during startup (tmux session ${name} is gone)`)
      if (r.ok && this.profile.isReady(r.stdout)) return
      await new Promise(res => setTimeout(res, 200))
    }
    this.dbg(`${this.tag()}: startup wait timed out for session ${name}, proceeding anyway`)
  }

  /**
   * Deliver `text` as one bracketed paste, then a separate Enter — a plain
   * `send-keys -l` would submit at the first embedded newline.
   */
  private async sendKeys(name: string, text: string): Promise<void> {
    // A private named buffer, deleted on paste (-d): the default buffer is
    // shared by every session on the tmux server, so two workdirs sending at
    // once could otherwise paste each other's text.
    const buffer = `feishu-${randomUUID()}`
    const set = await runTmux(['set-buffer', '-b', buffer, '--', text])
    if (!set.ok) throw new Error(`tmux set-buffer failed: ${set.stderr || set.stdout}`)
    const paste = await runTmux(['paste-buffer', '-b', buffer, '-d', '-t', name, '-p'])
    if (!paste.ok) throw new Error(`tmux paste-buffer failed: ${paste.stderr || paste.stdout}`)
    const enter = await runTmux(['send-keys', '-t', name, 'Enter'])
    if (!enter.ok) throw new Error(`tmux send-keys (Enter) failed: ${enter.stderr || enter.stdout}`)
  }

  /**
   * True if a reply wait for this workdir is in flight (a call now would be
   * absorbed or queued). Advisory only — sendAndAwaitReply re-checks.
   */
  isBusy(workdir: string): boolean {
    return this.queues.has(workdir)
  }

  /**
   * Deliver a message to the workdir's session and wait for its reply.
   *
   * While a reply is already in flight: an 'absorb' profile (Claude Code)
   * folds the new message into the running turn — it's pasted now and the
   * call resolves with the in-flight result. A 'queue' profile (agy) runs it
   * as its own next turn — it's pasted now (the CLI queues it natively),
   * and the call resolves with the text of that later turn only.
   */
  async sendAndAwaitReply(workdir: string, text: string, opts: SendAndAwaitReplyOptions = {}): Promise<string> {
    const inFlight = this.queues.get(workdir)
    if (inFlight) {
      const name = this.profile.sessionName(workdir)
      // Never overtake the head: if it's still spawning/pasting, a message
      // pasted now would run first. If the head never got delivered, this
      // one isn't pasted either and rejects (the caller may fall back).
      const headDelivered = this.headDelivered.get(workdir)
      if (this.profile.midTurn === 'absorb') {
        await headDelivered
        await this.sendKeys(name, text)
        opts.onAbsorbed?.()
        // Pasted: from here on this call must never reject (see the delivery
        // contract), even if the in-flight wait it joined fails.
        return inFlight.catch(() => '')
      }
      // Registered synchronously before any await, so the in-flight collect
      // loop can never decide "nothing queued, done" in between and strand
      // this owner.
      const list = this.owners.get(workdir)!
      const { owner, done } = newOwner(text, opts)
      list.push(owner)
      try {
        await headDelivered
        await this.sendKeys(name, text)
      } catch (e) {
        const idx = list.indexOf(owner)
        if (idx !== -1) list.splice(idx, 1)
        throw e
      }
      opts.onQueued?.()
      return done
    }
    const { owner: head, done: headDone } = newOwner(text, opts)
    const owners: TurnOwner[] = [head]
    this.owners.set(workdir, owners)
    let markDelivered!: () => void
    let markNotDelivered!: (e: unknown) => void
    const delivered = new Promise<void>((res, rej) => { markDelivered = res; markNotDelivered = rej })
    delivered.catch(() => {})  // observed by later callers only
    this.headDelivered.set(workdir, delivered)
    const task = this.doSendAndAwaitReply(workdir, owners, markDelivered)
    task.catch(e => markNotDelivered(e))
    this.queues.set(workdir, headDone)
    const cleanup = () => {
      if (this.queues.get(workdir) === headDone) this.queues.delete(workdir)
      if (this.owners.get(workdir) === owners) this.owners.delete(workdir)
      if (this.headDelivered.get(workdir) === delivered) this.headDelivered.delete(workdir)
    }
    task.then(
      () => { cleanup(); this.settleRemaining(workdir, owners) },
      (e) => { cleanup(); this.settleRemaining(workdir, owners, e) },
    )
    // headDone can settle before the whole wait ends (a queue-mode hand-off
    // to the next queued message), and rejects on a pre-delivery failure.
    return headDone
  }

  /**
   * Settle every owner the collect loop didn't get to (session killed,
   * deadline). With `preDeliveryError`, the head never reached the CLI, so
   * it rejects — the caller may fall back; queued owners were already pasted
   * into a live pane, so they resolve with what they have instead.
   */
  private settleRemaining(workdir: string, owners: TurnOwner[], preDeliveryError?: unknown) {
    if (owners.length > 1) this.dbg(`${this.tag()}: ${workdir} reply wait ended with ${owners.length - 1} queued message(s) unanswered`)
    owners.splice(0).forEach((o, i) => {
      if (preDeliveryError !== undefined && i === 0) o.reject(preDeliveryError)
      else o.resolve(o.collected.join('\n\n'))
    })
  }

  private markTurnStarted(owner: TurnOwner | undefined) {
    if (!owner || owner.started) return
    owner.started = true
    try { owner.opts.onTurnStarted?.() } catch (e) { this.dbg(`${this.tag()}: onTurnStarted threw: ${e}`) }
  }

  private async doSendAndAwaitReply(workdir: string, owners: TurnOwner[], onDelivered: () => void): Promise<void> {
    const head = owners[0]
    this.lastUsedAt.set(workdir, Date.now())
    const name = await this.ensureSession(workdir, head.opts)
    // Resolve the session id *before* measuring the transcript offset: a
    // reattached session whose id wasn't persisted would otherwise be read
    // from byte 0 once its id is discovered, replaying old conversation.
    let sessionId = this.sessionIds.get(workdir)
    if (!sessionId && this.profile.discoverSessionId) {
      sessionId = this.profile.discoverSessionId(workdir)
      if (sessionId) this.rememberSessionId(workdir, sessionId)
    }
    const beforeSendMs = Date.now()
    const transcriptBefore = sessionId ? this.profile.transcriptPath(workdir, sessionId) : this.profile.findLatestTranscript(workdir)
    const startOffset = transcriptBefore && existsSync(transcriptBefore) ? statSync(transcriptBefore).size : 0
    const signalPath = this.profile.stopSignalPath(workdir, sessionId)
    const baselineStopMs = signalPath && existsSync(signalPath) ? statSync(signalPath).mtimeMs : 0

    await this.sendKeys(name, head.text)
    onDelivered()
    // Delivered — nothing below may throw (see the header's delivery contract).
    try {
      await this.collectReply(workdir, owners, beforeSendMs, transcriptBefore, startOffset, signalPath, baselineStopMs)
    } catch (e) {
      this.dbg(`${this.tag()}: error while waiting for ${workdir}'s reply (message was already delivered, not retryable): ${e}`)
    }
  }

  private async collectReply(
    workdir: string, owners: TurnOwner[], beforeSendMs: number,
    transcriptBefore: string | null, startOffset: number, signalPath: string | null, baselineStopMs: number,
  ): Promise<void> {
    const profile = this.profile
    const name = profile.sessionName(workdir)
    let deadline = beforeSendMs + this.replyTimeoutMs
    const epoch = this.epochs.get(workdir) ?? 0
    const sessionKilled = () => (this.epochs.get(workdir) ?? 0) !== epoch
    let lastChangeMs = Date.now()
    let lastDialogCheckMs = Date.now()
    let lastStuckNotifyMs = 0
    let lastSize = startOffset
    let transcriptPath = transcriptBefore
    let waitCappedSinceStop = false
    let anyCollected = false
    const current = () => owners[0]
    /** Owner receiving transcript text — can run ahead of owners[0] when the next queued turn starts before the previous stop is handled. */
    let textOwner: TurnOwner | undefined = owners[0]
    let seenTurnStart = false
    const advanceTextOwner = () => {
      const idx = textOwner ? owners.indexOf(textOwner) : -1
      const next = owners[idx + 1]
      if (next) { textOwner = next; this.markTurnStarted(next) }
    }
    const deliver = (lines: string[]) => {
      if (!lines.length) return
      const owner = textOwner && owners.includes(textOwner) ? textOwner : current()
      if (!owner) return
      const newTexts = profile.parseText(lines)
      owner.collected.push(...newTexts)
      for (const text of newTexts) {
        anyCollected = true
        try { owner.opts.onTextChunk?.(text) } catch (e) { this.dbg(`${this.tag()}: onTextChunk for ${workdir} threw: ${e}`) }
      }
      const events = profile.parseProgress(lines)
      if (events.length) { try { owner.opts.onProgress?.(events) } catch (e) { this.dbg(`${this.tag()}: onProgress for ${workdir} threw: ${e}`) } }
    }

    const resolveTranscript = (): string | null => {
      let sid = this.sessionIds.get(workdir)
      if (!sid && profile.discoverSessionId) {
        sid = profile.discoverSessionId(workdir)
        if (sid) { this.dbg(`${this.tag()}: ${workdir} session id is ${sid}`); this.rememberSessionId(workdir, sid) }
      }
      if (!signalPath) signalPath = profile.stopSignalPath(workdir, sid)
      return sid ? profile.transcriptPath(workdir, sid) : profile.findLatestTranscript(workdir, beforeSendMs)
    }

    // Byte-offset reads, consuming only up to the last newline so a
    // half-written trailing JSONL line is re-read once complete.
    const readGrowth = (): boolean => {
      if (!transcriptPath) transcriptPath = resolveTranscript()
      if (!transcriptPath || !existsSync(transcriptPath)) return false
      const buf = readFileSync(transcriptPath)
      if (buf.length <= lastSize) return false
      const newBytes = buf.subarray(lastSize)
      const lastNewline = newBytes.lastIndexOf(0x0a)
      if (lastNewline === -1) return false
      const completeChunk = newBytes.subarray(0, lastNewline + 1)
      const newLines = completeChunk.toString('utf8').split('\n')
      // Split at user-turn boundaries: the head's own turn start is the
      // first one seen; every later one moves text to the next queued owner.
      let segment: string[] = []
      for (const line of newLines) {
        if (profile.isUserTurnStart?.(line)) {
          deliver(segment)
          segment = []
          if (seenTurnStart) advanceTextOwner()
          seenTurnStart = true
          continue
        }
        segment.push(line)
      }
      deliver(segment)
      lastSize += completeChunk.length
      lastChangeMs = Date.now()
      return true
    }

    const stopFired = () => !!signalPath && existsSync(signalPath) && statSync(signalPath).mtimeMs > baselineStopMs
    // A local-only slash command (see TmuxCliProfile.slashCommandIdleMs) ends
    // when the pane has been idle for a while and no turn ever started.
    const slashIdleMs = profile.slashCommandIdleMs
    /**
     * How long the pane must sit idle, with no turn ever started, before the
     * wait ends on its own: short for a local slash command (no turn is
     * expected), long otherwise (the stop signal never came — typically the
     * hook plugin isn't installed). Only for profiles that opt in.
     */
    const noTurnIdleLimit = (): number | null => {
      if (!slashIdleMs || owners.length !== 1 || seenTurnStart) return null
      return owners[0].text.trim().startsWith('/') ? slashIdleMs : NO_TURN_IDLE_MS
    }
    let idleSinceMs = 0

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 400))
      if (!owners.length) return  // every caller already settled (e.g. a queued paste failed after a hand-off)
      if (sessionKilled()) {
        this.dbg(`${this.tag()}: ${workdir}'s session was killed/restarted — ending its in-flight reply wait`)
        return
      }
      // Refreshed every tick so a long active wait isn't reaped as idle.
      this.lastUsedAt.set(workdir, Date.now())
      if (readGrowth()) { waitCappedSinceStop = false; continue }
      if (stopFired()) {
        // The stop signal can land before the last transcript lines are
        // flushed — keep reading until growth goes quiet for a beat.
        let lastGrowthMs = Date.now()
        while (Date.now() < deadline && !sessionKilled()) {
          await new Promise(r => setTimeout(r, 300))
          if (readGrowth()) { lastGrowthMs = Date.now(); continue }
          if (isQuietDone(lastGrowthMs, Date.now(), this.postStopQuietMs)) break
        }
        baselineStopMs = statSync(signalPath!).mtimeMs
        const outcome = profile.afterStop({ workdir, sessionName: name, transcriptPath, plainPane: stripAnsi(await this.capturePane(name)) })
        // A /reset or /restart may have landed during that await — don't
        // write this dead session's state back over the new one.
        if (sessionKilled()) return
        if (outcome.conversationId && outcome.conversationId !== this.sessionIds.get(workdir)) {
          this.dbg(`${this.tag()}: ${workdir} now on conversation ${outcome.conversationId}`)
          this.rememberSessionId(workdir, outcome.conversationId)
          // Follow the new conversation's transcript: from its start if it
          // was created during this wait, otherwise from its current end.
          const next = profile.transcriptPath(workdir, outcome.conversationId)
          if (next !== transcriptPath) {
            transcriptPath = next
            lastSize = existsSync(next) && statSync(next).birthtimeMs < beforeSendMs ? statSync(next).size : 0
          }
        }
        if (outcome.error) {
          this.dbg(`${this.tag()}: ${workdir} turn stopped with error: ${outcome.error}`)
          const errorOwner = owners[matchStoppedOwner(owners.map(o => o.text), outcome.lastUserInput)] ?? current()
          try { errorOwner?.opts.onStopError?.(outcome.error) } catch (e) { this.dbg(`${this.tag()}: onStopError threw: ${e}`) }
        }
        // Queue-mode hand-off: settle every owner up to the one whose turn
        // just ended; if more are queued, the next one owns what follows.
        const stoppedIdx = matchStoppedOwner(owners.map(o => o.text), outcome.lastUserInput)
        if (stoppedIdx < owners.length - 1) {
          for (const o of owners.splice(0, stoppedIdx + 1)) o.resolve(o.collected.join('\n\n'))
          this.dbg(`${this.tag()}: ${workdir} turn ended, handing over to the next queued message (${owners.length} left)`)
          if (!textOwner || !owners.includes(textOwner)) textOwner = current()
          this.markTurnStarted(current())
          deadline = Date.now() + this.replyTimeoutMs
          waitCappedSinceStop = false
          lastChangeMs = Date.now()
          continue
        }
        if (stoppedIdx > 0) {
          for (const o of owners.splice(0, stoppedIdx)) o.resolve(o.collected.join('\n\n'))
          if (!textOwner || !owners.includes(textOwner)) textOwner = current()
        }
        if (outcome.wait !== 'done') {
          this.dbg(`${this.tag()}: ${workdir} stopped with background work still running — waiting for its next turn`)
          waitCappedSinceStop = outcome.wait === 'wait-capped'
          continue
        }
        return
      }
      if (waitCappedSinceStop && isQuietDone(lastChangeMs, Date.now(), this.backgroundIdleCapMs)) {
        this.dbg(`${this.tag()}: ${workdir} — no activity for ${this.backgroundIdleCapMs}ms while waiting on background tasks, treating the reply as finished`)
        return
      }
      // Quiet-period fallback only when there's no stop signal at all.
      if (!signalPath && anyCollected && isQuietDone(lastChangeMs, Date.now(), this.quietMs)) return

      const idleLimit = noTurnIdleLimit()
      if (idleLimit !== null && !stopFired()) {
        if (profile.isReady(stripAnsi(await this.capturePane(name)))) {
          idleSinceMs ||= Date.now()
          if (isQuietDone(idleSinceMs, Date.now(), idleLimit)) {
            const owner = owners[0]
            if (idleLimit === slashIdleMs) {
              this.dbg(`${this.tag()}: ${workdir} — "${owner.text.trim()}" ran without starting a turn, treating it as done`)
            } else {
              const hint = this.sessionIds.get(workdir) ? '' : '（未收到插件信号，请确认已安装：agy plugin install ./agy-plugin）'
              this.dbg(`${this.tag()}: ${workdir} — idle ${idleLimit}ms with no turn and no stop signal, ending the wait${hint}`)
              try { owner?.opts.onStopError?.(`${profile.label} 已空闲但未收到回合结束信号${hint}`) } catch (e) { this.dbg(`${this.tag()}: onStopError threw: ${e}`) }
            }
            return
          }
        } else {
          idleSinceMs = 0
        }
      }

      const owner = current()
      const onDialog = owner?.opts.onDialog
      const onStuckPane = owner?.opts.onStuckPane
      if ((onDialog || onStuckPane) && isQuietDone(lastDialogCheckMs, Date.now(), this.dialogCheckMs)) {
        lastDialogCheckMs = Date.now()
        const rawPane = await this.capturePane(name)
        const dialog = onDialog ? profile.parseDialog(stripAnsi(rawPane)) : null
        if (dialog && onDialog) {
          const keepWaiting = await this.handleDialog(workdir, name, dialog, onDialog, owner.opts.onTabSwitched)
          if (!keepWaiting) return
          // The click can take any amount of time — give the chosen action a
          // fresh window to run.
          deadline = Date.now() + this.replyTimeoutMs
          lastChangeMs = Date.now()
        } else if (
          onStuckPane &&
          isQuietDone(lastChangeMs, Date.now(), this.stuckPaneCheckMs) &&
          isQuietDone(lastStuckNotifyMs, Date.now(), this.stuckPaneCooldownMs)
        ) {
          lastStuckNotifyMs = Date.now()
          try { await onStuckPane(rawPane) } catch (e) { this.dbg(`${this.tag()}: onStuckPane failed for ${workdir}: ${e}`) }
        }
      }
    }
  }

  /**
   * Ask the caller for a choice and send the matching keystrokes. Returns
   * false when the whole reply wait should end (timeout, cancellation, or
   * the session vanished), true to keep collecting.
   */
  private async handleDialog(workdir: string, name: string, dialog: Dialog, onDialog: DialogHandler, onTabSwitched?: TabSwitchedHandler): Promise<boolean> {
    let currentDialog = dialog
    while (true) {
      this.dbg(`${this.tag()}: ${workdir} is showing a dialog ("${currentDialog.question}"), asking caller for a choice`)
      // Paced by a human — keep the session from being reaped as idle.
      this.lastUsedAt.set(workdir, Date.now())
      const chosenNumber = await onDialog(currentDialog)
      this.lastUsedAt.set(workdir, Date.now())
      if (chosenNumber === DIALOG_ESCAPE_CHOICE) {
        if (await this.hasSession(name)) await runTmux(['send-keys', '-t', name, 'Escape'])
        return true
      }
      if (chosenNumber === DIALOG_TIMED_OUT_CHOICE) {
        // Nobody answered — close the menu so the next message isn't typed into it.
        this.dbg(`${this.tag()}: dialog for ${workdir} timed out with no answer — sending Escape to close it`)
        if (await this.hasSession(name)) await runTmux(['send-keys', '-t', name, 'Escape'])
        return false
      }
      const option = currentDialog.options.find(o => Number(o.number) === chosenNumber)
      if (!option) {
        // Explicit cancellation (/esc, /restart already handled the session).
        this.dbg(`${this.tag()}: dialog choice for ${workdir} didn't resolve to a real option (cancelled) — not sending a keystroke`)
        return false
      }
      if (!(await this.hasSession(name))) {
        this.dbg(`${this.tag()}: ${workdir}'s session is gone by the time a dialog choice came back — not sending a keystroke`)
        return false
      }
      if (currentDialog.kind === 'numbered') {
        await this.sendOptionKeys(name, option)
        return true
      }
      if (currentDialog.kind === 'cursor') {
        const moves = cursorMovesToReach(currentDialog.currentNumber ?? '1', option.number)
        const key = moves >= 0 ? 'Down' : 'Up'
        for (let i = 0; i < Math.abs(moves); i++) await runTmux(['send-keys', '-t', name, key])
        await runTmux(['send-keys', '-t', name, 'Enter'])
        return true
      }
      // 'tabs': Right presses from the known current tab, then re-offer the
      // same card (re-detection of a freshly focused tab isn't reliable).
      const rightPresses = rightPressesToReach(currentDialog.currentNumber ?? '1', option.number, currentDialog.options.length)
      const beforeSwitch = onTabSwitched && rightPresses > 0 ? await this.capturePane(name) : undefined
      for (let i = 0; i < rightPresses; i++) {
        if (!(await this.hasSession(name))) {
          this.dbg(`${this.tag()}: ${workdir}'s session disappeared mid tab-navigation — stopping`)
          return true
        }
        await runTmux(['send-keys', '-t', name, 'Right'])
      }
      if (onTabSwitched) {
        const rawPane = await this.captureStablePane(name, beforeSwitch)
        try { await onTabSwitched(rawPane) } catch (e) { this.dbg(`${this.tag()}: onTabSwitched for ${workdir} threw: ${e}`) }
      }
      currentDialog = {
        ...currentDialog,
        question: `切换到哪个标签页？（当前在第 ${option.number} 个「${option.label}」）`,
        currentNumber: option.number,
      }
    }
  }

  /**
   * Kill the workdir's tmux session and end any in-flight wait on it.
   * `forget: false` keeps the persisted session id so a resumable profile
   * can pick the same conversation back up on the next spawn.
   */
  async killSession(workdir: string, opts: { forget?: boolean } = {}): Promise<void> {
    const forget = opts.forget ?? true
    const name = this.profile.sessionName(workdir)
    // Bump the epoch so the old collect loop stops, and free the queue slot
    // so the next message starts its own wait (found live: after /restart
    // the old wait kept screenshotting the new session).
    this.epochs.set(workdir, (this.epochs.get(workdir) ?? 0) + 1)
    this.queues.delete(workdir)
    this.knownAlive.delete(workdir)
    this.sessionIds.delete(workdir)
    this.lastUsedAt.delete(workdir)
    if (forget) this.persistence?.delete(workdir)
    await runTmux(['kill-session', '-t', name])
  }

  /** Kill sessions idle for at least `idleMs` — run on an interval. Resumable profiles keep their conversation id. */
  async killIdleSessions(idleMs: number): Promise<void> {
    const now = Date.now()
    for (const [workdir, lastUsed] of this.lastUsedAt) {
      if (now - lastUsed >= idleMs) {
        this.dbg(`${this.tag()}: ${workdir} idle for ${Math.round((now - lastUsed) / 1000)}s, killing session`)
        await this.killSession(workdir, { forget: !this.profile.resumable })
      }
    }
  }
}
