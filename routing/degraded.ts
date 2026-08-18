/**
 * Tracks per-workdir "temporarily unavailable" windows — e.g. a Claude Code
 * worker just hit its usage rate limit and won't produce a real reply until
 * it resets. In-memory only, deliberately not persisted: the window is short
 * and self-refreshes on each new rate_limit event from the worker, so losing
 * it on router restart just means one extra Claude attempt, not a wedged
 * conversation.
 */
export class DegradedTracker {
  private until = new Map<string, number>()

  markDegraded(workdir: string, untilMs: number): void {
    this.until.set(workdir, untilMs)
  }

  isDegraded(workdir: string, now: number = Date.now()): boolean {
    const t = this.until.get(workdir)
    if (t === undefined) return false
    if (now >= t) {
      this.until.delete(workdir)
      return false
    }
    return true
  }
}
