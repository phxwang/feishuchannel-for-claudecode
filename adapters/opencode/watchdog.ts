/**
 * Chat-turn watchdog for OpenCodeAdapter.send(). The task service owns its
 * own time limits and observes with no watchdog at all.
 *
 * A fixed wall-clock deadline kills legitimate long turns (observed live: a
 * 75+-step verification turn still making progress at the 1-hour mark), so
 * `idleTimeoutMs` is a *no-progress* timeout: any observed tool/text/
 * permission activity re-arms it. `hardCapMs` remains an absolute ceiling so a
 * session that keeps emitting events forever is still eventually reclaimed.
 */

/** Coarse, human-readable duration for timeout diagnostics (Chinese, matching user-facing replies). */
export function formatTaskDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分`
}

export type TaskTimeoutKind = 'idle' | 'hard_cap'

export interface TimeoutSnapshot {
  kind: TaskTimeoutKind
  elapsedMs: number
  idleMs: number
  hardCapMs: number
  lastActivity?: string
}

/** Builds the `detail` shown next to a task_timeout failure. */
export function describeTaskTimeout(opts: TimeoutSnapshot): string {
  const parts: string[] = []
  if (opts.kind === 'hard_cap') {
    parts.push(`已达最长运行上限 ${formatTaskDuration(opts.hardCapMs)}`)
    parts.push(`已运行 ${formatTaskDuration(opts.elapsedMs)}`)
  } else {
    parts.push(`已运行 ${formatTaskDuration(opts.elapsedMs)}`)
    parts.push(`已 ${formatTaskDuration(opts.idleMs)} 无新进展`)
  }
  if (opts.lastActivity) parts.push(`最后活动：${opts.lastActivity}`)
  return parts.join('；')
}

export class TurnWatchdog {
  private readonly startedAt = Date.now()
  private lastProgressAt = this.startedAt
  private lastActivity: string | undefined
  private timeoutKind: TaskTimeoutKind | undefined
  private timer: ReturnType<typeof setTimeout> | undefined

  /** `onExpire` is called once when either limit is hit; it must stop the run. */
  constructor(
    private readonly idleTimeoutMs: number,
    private readonly hardCapMs: number,
    private readonly run: AbortController,
    private readonly onExpire: () => void,
  ) {}

  start(): void { this.arm() }

  stop(): void { clearTimeout(this.timer) }

  /** Any turn activity postpones the idle timeout; only real progress should call this. */
  markProgress(label: string): void {
    this.lastProgressAt = Date.now()
    this.lastActivity = label
    this.arm()
  }

  snapshot(): TimeoutSnapshot {
    const now = Date.now()
    return {
      kind: this.timeoutKind ?? 'idle',
      elapsedMs: now - this.startedAt,
      idleMs: now - this.lastProgressAt,
      hardCapMs: this.hardCapMs,
      lastActivity: this.lastActivity,
    }
  }

  private check(): void {
    if (this.run.signal.aborted) return
    const now = Date.now()
    if (now - this.startedAt >= this.hardCapMs) { this.expire('hard_cap'); return }
    if (now - this.lastProgressAt >= this.idleTimeoutMs) { this.expire('idle'); return }
    this.arm()
  }

  private expire(kind: TaskTimeoutKind): void {
    this.timeoutKind = kind
    this.run.abort()
    this.onExpire()
  }

  private arm(): void {
    if (this.run.signal.aborted) return
    clearTimeout(this.timer)
    const now = Date.now()
    const idleIn = this.lastProgressAt + this.idleTimeoutMs - now
    const hardIn = this.startedAt + this.hardCapMs - now
    this.timer = setTimeout(() => this.check(), Math.max(1, Math.min(idleIn, hardIn)))
  }
}
