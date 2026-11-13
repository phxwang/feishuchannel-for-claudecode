import type { AgentEvent } from '../agent-adapter'

/** Never derive a public summary from a command/input. Redact before truncating. */
export function safeSummary(value: string): string {
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:sk-|ghp_|github_pat_)[\w-]+/g, '[redacted]')
    .replace(/(token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@')
    .replace(/[\r\n\t]+/g, ' ').replace(/[<>*_`\[\]]/g, '').slice(0, 120)
}

export interface TextPartSnapshot { messageId: string; partId: string; text: string }
export function textKey(p: TextPartSnapshot): string { return JSON.stringify([p.messageId, p.partId]) }
/** UTF-16 length budget, without splitting a surrogate pair or discarding whitespace. */
export function splitUnicode(text: string, limit = 4096): string[] {
  const out: string[] = []
  while (text.length) {
    let n = Math.min(limit, text.length)
    if (n < text.length && /[\uD800-\uDBFF]/.test(text[n - 1])) n--
    if (!n) throw new Error('Text chunk limit must accommodate a Unicode character')
    out.push(text.slice(0, n)); text = text.slice(n)
  }
  return out
}

/** One bounded snapshot map, one sender. API acknowledgement alone advances delivery.
 * Unknown outcomes are never automatically retried; final reconciliation labels the resend. */
export class TextDelivery {
  private parts = new Map<string, { value: TextPartSnapshot; delivered: string; revised: boolean; unknown: boolean }>()
  private timer?: ReturnType<typeof setTimeout>
  private sending: Promise<void> = Promise.resolve()
  private closing = false
  private degraded = false
  private deliveryDeadline = Infinity
  constructor(private send: (text: string) => Promise<void>, private streaming = false, private windowMs = 750,
    private maxBytes = 512 * 1024, private maxParts = 256, private sendBudgetMs = 30_000) {}
  snapshot(value: TextPartSnapshot) {
    if (this.closing || this.degraded) return
    const key = textKey(value), previous = this.parts.get(key)
    if (previous) {
      if (previous.value.text === value.text || previous.value.text.startsWith(value.text)) return
      if (!value.text.startsWith(previous.value.text)) previous.revised = true
      previous.value = value
    } else {
      if (this.parts.size >= this.maxParts) { this.degraded = true; return }
      this.parts.set(key, { value, delivered: '', revised: false, unknown: false })
    }
    if ([...this.parts.values()].reduce((n, p) => n + p.value.text.length * 2, 0) > this.maxBytes) {
      this.degraded = true; return
    }
    if (this.streaming && !this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.flush(false) }, this.windowMs)
  }
  private flush(final: boolean) {
    this.sending = this.sending.then(async () => {
      for (const state of this.parts.values()) {
        if (!final && (this.closing || state.revised || state.unknown || this.degraded)) continue
        const text = state.value.text
        const revision = state.revised || !text.startsWith(state.delivered)
        if (!revision && !state.unknown && text === state.delivered) continue
        const prefix = revision ? '【更新版】\n' : state.unknown ? '【补发：此前发送状态未确认】\n' : ''
        const remaining = prefix ? text : text.slice(state.delivered.length)
        if (!remaining) continue
        const target = prefix + remaining
        let sent = ''
        try {
          for (const chunk of splitUnicode(target)) {
            if (Date.now() >= this.deliveryDeadline) throw new Error('Text delivery budget exceeded')
            await this.send(chunk); sent += chunk
          }
          state.delivered = text; state.unknown = false; state.revised = false
        } catch {
          // A timeout might have been accepted remotely. Do not claim success or blindly retry.
          state.unknown = true
          if (!prefix) state.delivered += sent
        }
      }
    })
  }
  async finalize(authoritative: TextPartSnapshot[]): Promise<{ delivered: boolean; hasText: boolean }> {
    this.closing = true; this.deliveryDeadline = Date.now() + this.sendBudgetMs; clearTimeout(this.timer)
    await this.sending
    // Authority supersedes intermediate snapshots and ordering; no task-level anyTextSent.
    const ordered = new Map<string, { value: TextPartSnapshot; delivered: string; revised: boolean; unknown: boolean }>()
    for (const value of authoritative) {
      const old = this.parts.get(textKey(value))
      ordered.set(textKey(value), { value, delivered: old?.delivered ?? '',
        revised: !!old?.revised || (!!old?.delivered && !value.text.startsWith(old.delivered)), unknown: old?.unknown ?? false })
    }
    this.parts = ordered
    this.flush(true); await this.sending
    return { delivered: [...this.parts.values()].every(p => !p.unknown && p.delivered === p.value.text), hasText: authoritative.some(p => !!p.text) }
  }
}

/** Latest-state coalescer. Never overlaps a patch; terminal is always sent last. */
export class ProgressCard {
  private active = new Map<string, { name: string; since: number }>()
  private terminalTools = new Set<string>()
  private permissions = new Set<string>()
  private latest = '🤔 等待执行进展'
  private stopped = false
  private dirty = false
  private lastPatch = 0
  private patchFailures = 0
  private timer?: ReturnType<typeof setTimeout>
  private chain: Promise<void> = Promise.resolve()
  private final?: Promise<void>
  private heartbeat: ReturnType<typeof setInterval>
  private started = Date.now()
  constructor(private patch: (line: string) => Promise<void>, private cooldown = 1500, heartbeatMs = 15000) {
    this.heartbeat = setInterval(() => this.schedule(), heartbeatMs)
  }
  event(event: AgentEvent) {
    if (this.stopped) return
    if (event.type === 'permission.requested') this.permissions.add(event.requestId)
    if (event.type === 'tool.started' || event.type === 'tool.completed' || event.type === 'tool.failed') {
      if (!event.messageId || !event.partId) return
      const key = JSON.stringify([event.messageId, event.partId, event.callId])
      // Presentation can degrade independently; ownership/final output remains authoritative.
      if (this.terminalTools.size >= 4096 || this.active.size >= 256) return
      if (event.type !== 'tool.started') { this.terminalTools.add(key); this.active.delete(key) }
      else if (!this.terminalTools.has(key) && !this.active.has(key)) this.active.set(key, { name: safeSummary(event.toolName), since: Date.now() })
    }
    if (event.type === 'text.snapshot') this.latest = '✍️ 输出中'
    this.schedule()
  }
  permissionResolved(id: string) { this.permissions.delete(id); this.schedule() }
  private line() {
    const tool = this.active.values().next().value
    const state = this.permissions.size ? `🔐 等待你的授权（${this.permissions.size}）` : tool
      ? `🔧 ${tool.name} · 工具 ${Math.floor((Date.now() - tool.since) / 1000)}秒${this.active.size > 1 ? `，另有 ${this.active.size - 1} 个工具运行中` : ''}` : this.latest
    return `${state} · 总时长 ${Math.floor((Date.now() - this.started) / 1000)}秒`
  }
  private schedule() {
    if (this.stopped || this.patchFailures >= 3) return
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.chain = this.chain.then(async () => {
        if (this.stopped || !this.dirty || this.patchFailures >= 3) return
        this.dirty = false; this.lastPatch = Date.now()
        try { await this.patch(this.line()); this.patchFailures = 0 } catch { this.patchFailures++ }
        if (this.dirty) this.schedule()
      })
    }, Math.max(0, this.lastPatch + this.cooldown - Date.now()))
  }
  finalize(line: string): Promise<void> {
    if (this.final) return this.final
    this.stopped = true; clearTimeout(this.timer); clearInterval(this.heartbeat)
    this.final = this.chain.then(async () => { try { await this.patch(line) } catch { /* display failure is not execution failure */ } })
    return this.final
  }
}
