/** Opt-in native v2: admission and durable step ownership, never legacy parentID.
 * One coordinator per endpoint + canonical directory + session. No abort/resubmit fallback. */
import { createHash } from 'crypto'
import { realpathSync } from 'fs'
import { resolve } from 'path'
import type { AgentEvent } from '../agent-adapter'
import type { TextPartSnapshot } from './presentation'
import { SSEBuffer } from './sse'

export type Delivery = 'steer' | 'queue'
type Durable = { type: string; durable?: { seq: number }; data: Record<string, any> }
type Group = { id: string; source: string; inputs: Set<string>; consumed: Set<string>; messages: Set<string>; texts: Map<string, TextPartSnapshot>; taskId: string; started: number; lastProgress: number; failed?: string }
export interface V2Callbacks {
  started(groupId: string): void
  event(groupId: string, event: AgentEvent): void
  settled(groupId: string, texts: TextPartSnapshot[], outcome: { reason?: string; detail?: string }): Promise<void>
}
export interface V2Config {
  baseUrl: string; directory: string; sessionId: string; requestTimeoutMs: number; idleTimeoutMs: number; hardCapMs: number
  passwordEnv?: string; pollMs?: number; calibrationMs?: number; onWarn?: (message: string) => void
}
export class V2ProtocolError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}
export function nativeInputId(sessionId: string, sourceMessageId: string): string {
  return 'msg_' + createHash('sha256').update(JSON.stringify([sessionId, sourceMessageId])).digest('hex').slice(0, 26)
}
export function coordinatorKey(endpoint: string, directory: string, sessionId: string): string {
  let canonical: string
  try { canonical = realpathSync(directory) } catch { canonical = resolve(directory) }
  return JSON.stringify([new URL(endpoint).origin + new URL(endpoint).pathname.replace(/\/$/, ''), canonical, sessionId])
}
/** Bounded HTTP including body download. Mutating requests are NEVER automatically retried. */
export async function v2Request(config: Pick<V2Config, 'baseUrl' | 'requestTimeoutMs' | 'passwordEnv'>, path: string,
  body?: unknown, signal?: AbortSignal, timeoutMs = config.requestTimeoutMs, fetchImpl: typeof fetch = fetch): Promise<any> {
  const controller = new AbortController(), cancel = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, timeoutMs)
  try {
    const password = config.passwordEnv && process.env[config.passwordEnv]
    const response = await fetchImpl(new URL(path, config.baseUrl), { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(password ? { Authorization: `Bearer ${password}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal })
    if (!response.ok) throw new V2ProtocolError(`OpenCode v2 HTTP ${response.status}`, response.status)
    const reader = response.body?.getReader(); let bytes = 0, text = ''; const decoder = new TextDecoder()
    if (reader) try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        bytes += value.byteLength
        if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new V2ProtocolError('OpenCode v2 response exceeds 4 MiB budget') }
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
    } finally { reader.releaseLock() }
    return text ? JSON.parse(text) : null
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
}

export class V2SessionCoordinator {
  private groups = new Map<string, Group>()
  private inputs = new Map<string, { group: Group; payload: string; error?: string; result: Promise<{ groupId: string; joined: boolean; status: 'admitted' | 'outcome_unknown' }> }>()
  private current?: Group
  private active?: Group
  private cursor = 0
  private init?: Promise<void>
  private serial: Promise<unknown> = Promise.resolve()
  private observing?: Promise<void>
  private run?: AbortController
  private pending = new Map<number, Durable>()
  private permissionGroups = new Map<string, Group>()
  private lastCalibration = 0
  private lastError?: string
  private suspended = false
  private resolvedPermissions = new Set<string>()
  constructor(private config: V2Config, private callbacks: V2Callbacks, private fetchImpl: typeof fetch = fetch) {}
  private path(suffix = '') { return `/api/session/${encodeURIComponent(this.config.sessionId)}${suffix}` }
  private request(path: string, body?: unknown, signal?: AbortSignal, timeout?: number) {
    return v2Request(this.config, path, body, signal, timeout, this.fetchImpl)
  }
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serial.then(fn); this.serial = next.catch(() => {}); return next
  }
  private async initialize() {
    // Restart recovery is intentionally not inferred. A reused v2 session must be idle.
    await this.request(this.path('/wait'), {}, undefined, Math.min(this.config.requestTimeoutMs, 1000))
    for (let page = 0; page < 100; page++) {
      const history = await this.request(this.path(`/history?limit=200&after=${this.cursor}`))
      if (!Array.isArray(history?.data)) throw new V2ProtocolError('v2 history contract missing')
      for (const event of history.data) this.cursor = Math.max(this.cursor, event.durable?.seq ?? 0)
      if (!history.hasMore) return
    }
    throw new V2ProtocolError('v2 history baseline exceeds bounded scan; no input submitted')
  }
  submit(source: string, messageId: string, text: string, delivery: Delivery = 'steer') {
    return this.lock(async () => {
      if (this.suspended) throw new V2ProtocolError('会话已停止或归属异常，待处理输入未删除；需在 OpenCode 核验后重新绑定独立会话')
      this.init ??= this.initialize(); await this.init
      // Resolve idle-vs-insertion at the same serialization boundary as admission.
      if (this.groups.size) await this.settleIdle()
      const id = nativeInputId(this.config.sessionId, messageId)
      const payload = JSON.stringify({ id, prompt: { text }, delivery, resume: true })
      const previous = this.inputs.get(id)
      if (previous) {
        if (previous.error) throw new V2ProtocolError(previous.error)
        if (previous.payload !== payload || previous.group.source !== source) throw new V2ProtocolError('Conflicting duplicate input')
        return previous.result
      }
      if (this.inputs.size >= 4096) throw new V2ProtocolError('Session input ledger full; rotate to a new session')
      if (this.groups.size >= 32) throw new V2ProtocolError('Too many queued execution groups')
      if ([...this.groups.values()].some(group => group.source !== source)) throw new V2ProtocolError('Session belongs to another chat; insertion refused')
      const joined = delivery === 'steer' && !!this.active
      const group: Group = joined ? this.active! : { id, source, inputs: new Set(), consumed: new Set(), messages: new Set(), texts: new Map(), taskId: id, started: Date.now(), lastProgress: Date.now() }
      if (!joined) { this.groups.set(group.id, group); this.callbacks.started(group.id) }
      group.inputs.add(id)
      if (delivery === 'steer') this.active = group
      // Record before awaiting admission. Durable consumption can beat the HTTP response.
      let resolveResult!: (value: { groupId: string; joined: boolean; status: 'admitted' | 'outcome_unknown' }) => void
      const result = new Promise<{ groupId: string; joined: boolean; status: 'admitted' | 'outcome_unknown' }>(resolve => { resolveResult = resolve })
      this.inputs.set(id, { group, payload, result })
      let status: 'admitted' | 'outcome_unknown' = 'admitted'
      try {
        const response = await this.request(this.path('/prompt'), JSON.parse(payload))
        if (response?.data?.id !== id || response.data.sessionID !== this.config.sessionId || !Number.isInteger(response.data.admittedSeq)) {
          throw new Error('Unrecognized admission receipt')
        }
      } catch (error) {
        if (error instanceof V2ProtocolError && [400, 401, 403, 404, 409, 422, 429].includes(error.status ?? 0)) {
          this.inputs.get(id)!.error = error.message
          group.inputs.delete(id)
          if (!group.inputs.size) { this.groups.delete(group.id); if (this.active === group) this.active = undefined; void this.callbacks.settled(group.id, [], { reason: error.message }) }
          resolveResult({ groupId: group.id, joined, status: 'outcome_unknown' })
          throw error
        }
        status = 'outcome_unknown' // May be admitted: observe this same ID, no legacy fallback or resubmit.
      }
      if (!this.groups.has(group.id)) status = 'outcome_unknown'
      resolveResult({ groupId: group.id, joined, status })
      this.ensureObserver()
      return result
    })
  }
  private ensureObserver() {
    if (this.observing) return
    const controller = new AbortController(); this.run = controller
    this.observing = this.observe(controller.signal).catch(() => { this.config.onWarn?.('opencode v2 observer stopped unexpectedly') }).finally(() => {
      controller.abort(); this.observing = undefined
      if (this.groups.size) this.ensureObserver()
    })
  }
  /** One reader, no ownership HTTP or Feishu await in the SSE pump. Overflow calibrates from durable history. */
  private async stream(signal: AbortSignal) {
    try {
      const password = this.config.passwordEnv && process.env[this.config.passwordEnv]
      const response = await this.fetchImpl(new URL(this.path(`/event?after=${this.cursor}`), this.config.baseUrl),
        { signal, headers: password ? { Authorization: `Bearer ${password}` } : {} })
      if (!response.ok || !response.body) return
      const reader = response.body.getReader(), decoder = new TextDecoder(), buffer = new SSEBuffer()
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read(); if (done) break
          for (let item of buffer.push(decoder.decode(value, { stream: true }))) {
            if (typeof item === 'string') { try { item = JSON.parse(item) } catch { continue } }
            const event = item as Durable, seq = event.durable?.seq
            if (typeof seq === 'number' && seq > this.cursor && this.pending.size < 1024) this.pending.set(seq, event)
          }
        }
      } finally { void reader.cancel().catch(() => {}) }
    } catch { /* durable polling recovers disconnected/live-but-silent SSE */ }
  }
  private consume(event: Durable) {
    if (event.data?.sessionID !== this.config.sessionId) return
    const data = event.data
    if (event.type === 'session.next.prompted') {
      const input = this.inputs.get(data.messageID)
      if (!input) {
        // External client injected input: never broadcast its work into this chat.
        this.suspended = true
        for (const group of this.groups.values()) group.failed = 'external_input_detected'
        this.current = undefined; return
      }
      this.current = input.group; this.current.consumed.add(data.messageID); this.current.lastProgress = Date.now(); this.active = this.current
    }
    if (event.type === 'session.next.step.started' && this.current && !this.current.failed) {
      if (this.current.messages.size >= 4096) { this.current.failed = 'step_ownership_budget_exceeded'; this.suspended = true }
      else this.current.messages.add(data.assistantMessageID)
    }
    const group = [...this.groups.values()].find(g => g.messages.has(data.assistantMessageID))
    if (!group || group.failed) return
    group.lastProgress = Date.now()
    const identity = { taskId: group.taskId, messageId: data.assistantMessageID, partId: data.callID, callId: data.callID }
    if (event.type === 'session.next.tool.called') this.callbacks.event(group.id, { ...identity, type: 'tool.started', toolName: data.tool })
    // Terminal names may be absent; identity, not name, controls the running set.
    if (event.type === 'session.next.tool.success') this.callbacks.event(group.id, { ...identity, type: 'tool.completed', toolName: 'tool' })
    if (event.type === 'session.next.tool.failed') this.callbacks.event(group.id, { ...identity, type: 'tool.failed', toolName: 'tool', error: 'tool failed' })
    if (event.type === 'session.next.text.ended') {
      const snapshot = { messageId: data.assistantMessageID, partId: data.textID, text: String(data.text ?? '') }
      if (group.texts.size < 256 && [...group.texts.values()].reduce((bytes, p) => bytes + p.text.length * 2, 0) + snapshot.text.length * 2 <= 512 * 1024) group.texts.set(JSON.stringify([snapshot.messageId, snapshot.partId]), snapshot)
      this.callbacks.event(group.id, { type: 'text.snapshot', taskId: group.taskId, ...snapshot })
    }
    if (event.type === 'session.next.step.failed') group.failed = 'model_step_failed'
  }
  private async calibrate(signal?: AbortSignal) {
    for (let page = 0; page < 5; page++) {
      const history = await this.request(this.path(`/history?limit=200&after=${this.cursor}`), undefined, signal)
      if (!Array.isArray(history?.data)) throw new V2ProtocolError('v2 history contract changed')
      for (const event of history.data as Durable[]) {
        const seq = event.durable?.seq
        if (typeof seq === 'number' && seq > this.cursor) this.pending.set(seq, event)
      }
      this.drain()
      if (!history.hasMore) return true
    }
    return false
  }
  private drain() {
    while (this.pending.has(this.cursor + 1)) {
      const event = this.pending.get(++this.cursor)!
      this.pending.delete(this.cursor); this.consume(event)
    }
  }
  private async projections(signal?: AbortSignal): Promise<any[]> {
    const messages: any[] = []; let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const query = cursor ? `cursor=${encodeURIComponent(cursor)}` : 'order=asc'
      const result = await this.request(this.path(`/message?limit=100&${query}`), undefined, signal)
      if (!Array.isArray(result?.data)) throw new V2ProtocolError('v2 message contract changed')
      messages.push(...result.data)
      cursor = result.cursor?.next
      if (!cursor) return messages
    }
    throw new V2ProtocolError('Message history exceeds bounded projection budget')
  }
  private async settleIdle(signal?: AbortSignal) {
    try { await this.request(this.path('/wait'), {}, signal, Math.min(250, this.config.requestTimeoutMs)) } catch { return }
    if (!await this.calibrate(signal)) return
    const messages = await this.projections(signal)
    for (const group of [...this.groups.values()]) {
      if (group.inputs.size !== group.consumed.size && !group.failed) continue
      const owned = messages.filter(m => m.type === 'assistant' && group.messages.has(m.id))
      const last = owned.at(-1)
      if (!group.failed && (!last || !last.time?.completed || last.finish === 'tool-calls')) continue
      const texts = group.failed === 'external_input_detected' ? [] : owned.flatMap(message => (message.content ?? [])
        .filter((p: any) => p.type === 'text' && !p.synthetic && !p.ignored)
        .map((p: any) => ({ messageId: message.id, partId: p.id, text: p.text })))
      for (const message of owned) for (const part of message.content ?? []) {
        if (part.type !== 'tool' || part.state?.status !== 'completed') continue
        for (const attachment of part.state.attachments ?? []) if (attachment.uri?.startsWith('data:')) {
          this.callbacks.event(group.id, { type: 'attachment.completed', taskId: group.taskId, mime: attachment.mime, dataUrl: attachment.uri, filename: attachment.name })
        }
      }
      this.close(group, texts, { reason: group.failed })
    }
  }
  private checkTimeouts() {
    const now = Date.now()
    for (const group of [...this.groups.values()]) {
      if (now - group.started >= this.config.hardCapMs || now - group.lastProgress >= this.config.idleTimeoutMs) {
        // Provider stop is explicitly unconfirmed; do not claim cancellation.
        this.close(group, [...group.texts.values()], { reason: 'task_timeout', detail: `无进展上限 ${this.config.idleTimeoutMs / 1000}秒；总上限 ${this.config.hardCapMs / 1000}秒${this.lastError ? `；${this.lastError}` : ''}；远端可能仍在运行` })
      }
    }
    if (!this.groups.size) this.run?.abort()
  }
  private async observe(signal: AbortSignal) {
    const watchdog = setInterval(() => this.checkTimeouts(), Math.max(1, Math.min(1000, this.config.idleTimeoutMs, this.config.hardCapMs)))
    void this.stream(signal)
    try {
      while (this.groups.size && !signal.aborted) {
        try {
          await this.lock(async () => {
            this.drain()
            if (Date.now() - this.lastCalibration >= (this.config.calibrationMs ?? 5000)) {
              await this.calibrate(signal); this.lastCalibration = Date.now()
            }
            const requests = await this.request(this.path('/permission'), undefined, signal)
            for (const permission of requests?.data ?? []) {
              if (this.permissionGroups.has(permission.id) || this.resolvedPermissions.has(permission.id) || !this.current || this.current.failed) continue
              // Permission source must identify an owned assistant step, never session-only guessing.
              if (!this.current.messages.has(permission.source?.messageID)) continue
              this.permissionGroups.set(permission.id, this.current)
              this.callbacks.event(this.current.id, { type: 'permission.requested', taskId: this.current.taskId, requestId: permission.id,
                toolName: permission.action ?? 'tool', description: 'OpenCode 请求工具授权' })
            }
            await this.settleIdle(signal)
          })
        } catch { this.lastError = '进度连接异常'; this.config.onWarn?.('opencode v2: observation failed; retrying bounded calibration') }
        if (this.groups.size) await new Promise<void>(resolve => {
          const timer = setTimeout(done, this.config.pollMs ?? 1000)
          function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
          signal.addEventListener('abort', done, { once: true })
        })
      }
    } finally { clearInterval(watchdog) }
  }
  private close(group: Group, texts: TextPartSnapshot[], outcome: { reason?: string; detail?: string }) {
    if (!this.groups.delete(group.id)) return
    if (this.active === group) this.active = undefined
    if (this.current === group) this.current = undefined
    void this.callbacks.settled(group.id, texts, outcome).catch(() => this.config.onWarn?.('opencode v2: final delivery failed'))
  }
  async respondPermission(id: string, allow: boolean) {
    if (!this.permissionGroups.has(id)) throw new V2ProtocolError('Unknown v2 permission request')
    await this.request(this.path(`/permission/${encodeURIComponent(id)}/reply`), { reply: allow ? 'once' : 'reject' })
    this.permissionGroups.delete(id); this.resolvedPermissions.add(id)
  }
  async stop(source: string) {
    return this.lock(async () => {
      if ([...this.groups.values()].some(g => g.source !== source)) throw new V2ProtocolError('Session belongs to another chat')
      this.suspended = true // Future prompt must not accidentally wake pending queued input.
      await this.request(this.path('/interrupt'), {})
      for (const group of [...this.groups.values()]) this.close(group, [...group.texts.values()], { reason: 'interrupted', detail: '停止已请求；待处理输入未删除，不自动恢复执行' })
      this.run?.abort()
    })
  }
}
