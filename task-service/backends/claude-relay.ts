/**
 * Router-side half of the Claude permission relay (design doc §9.8, §11.4).
 * `claude-permission-mcp.ts` (started by Claude through mcp.json) forwards
 * each `--permission-prompt-tool` call over task.sock as `permission.ask`;
 * the IPC server hands it to `ask()`, which parks it until the task service
 * replies, the caller goes away, or the attempt is released. The relay never
 * decides anything itself: every non-reply path is a deny.
 */
import { timingSafeEqual } from 'crypto'
import type { PermissionAskParams, PermissionAskResult } from '../ipc/protocol'
import type { BackendEvent } from './backend'

/** Claude's permission-prompt-tool contract: allow must echo the (possibly updated) tool input. */
export type ClaudePermissionDecision = PermissionAskResult & { updatedInput?: Record<string, unknown> }

type RelayEvent = Extract<BackendEvent, { type: 'permission.requested' | 'permission.cleared' }>

interface PendingAsk {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  description: string
  settle: (d: ClaudePermissionDecision) => void
}

interface AttemptRelay {
  token: string
  pending: Map<string, PendingAsk>
  listeners: Set<(e: RelayEvent) => void>
}

const REGISTRATION_WAIT_MS = 15_000
const DESCRIPTION_MAX = 300
const SUMMARY_KEYS = ['command', 'file_path', 'path', 'url', 'pattern', 'description', 'prompt']

export function deny(message: string): ClaudePermissionDecision {
  return { behavior: 'deny', message }
}

export function describeToolInput(toolName: string, input: Record<string, unknown>): string {
  const key = SUMMARY_KEYS.find(k => typeof input[k] === 'string' && input[k])
  let summary: string
  try { summary = key ? String(input[key]) : JSON.stringify(input) } catch { summary = '' }
  const text = summary ? `${toolName}: ${summary}` : toolName
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

function validParams(p: PermissionAskParams): string | null {
  if (!p || typeof p !== 'object') return 'malformed request'
  if (typeof p.executionAttemptId !== 'string' || !p.executionAttemptId) return 'missing executionAttemptId'
  if (typeof p.relayToken !== 'string' || !p.relayToken) return 'missing relayToken'
  if (typeof p.toolUseId !== 'string' || !p.toolUseId) return 'missing toolUseId'
  if (typeof p.toolName !== 'string' || !p.toolName) return 'missing toolName'
  if (!p.input || typeof p.input !== 'object' || Array.isArray(p.input)) return 'input must be an object'
  return null
}

export class PermissionRelay {
  private attempts = new Map<string, AttemptRelay>()
  private waiters = new Map<string, Set<() => void>>()

  register(attemptId: string, token: string): void {
    const existing = this.attempts.get(attemptId)
    if (existing && existing.token === token) return
    if (existing) this.denyAll(attemptId, 'relay token rotated')
    this.attempts.set(attemptId, { token, pending: new Map(), listeners: existing?.listeners ?? new Set() })
    for (const wake of this.waiters.get(attemptId) ?? []) wake()
    this.waiters.delete(attemptId)
  }

  /** Deny everything still parked and forget the attempt. */
  unregister(attemptId: string, reason = 'attempt released'): void {
    this.denyAll(attemptId, reason)
    this.attempts.delete(attemptId)
  }

  isRegistered(attemptId: string): boolean {
    return this.attempts.has(attemptId)
  }

  /** Called (via the IPC server) for each relay request. Resolves to Claude's decision. */
  async ask(params: PermissionAskParams, signal: AbortSignal): Promise<ClaudePermissionDecision> {
    const problem = validParams(params)
    if (problem) return deny(`permission request rejected: ${problem}`)
    const entry = await this.waitForAttempt(params.executionAttemptId, signal)
    if (!entry) return deny('permission request rejected: unknown attempt')
    if (!sameToken(entry.token, params.relayToken)) return deny('permission request rejected: bad relay token')
    if (entry.pending.has(params.toolUseId)) return deny('permission request rejected: duplicate tool_use_id')
    if (signal.aborted) return deny('permission request cancelled')
    return new Promise<ClaudePermissionDecision>(resolve => {
      const ask: PendingAsk = {
        toolUseId: params.toolUseId, toolName: params.toolName, input: params.input,
        description: describeToolInput(params.toolName, params.input),
        settle: resolve,
      }
      const onAbort = () => {
        if (entry.pending.get(ask.toolUseId) !== ask) return
        entry.pending.delete(ask.toolUseId)
        resolve(deny('permission request cancelled'))
        this.notify(entry, { type: 'permission.cleared', backendRequestId: ask.toolUseId })
      }
      ask.settle = d => { signal.removeEventListener('abort', onAbort); resolve(d) }
      entry.pending.set(ask.toolUseId, ask)
      signal.addEventListener('abort', onAbort, { once: true })
      this.notify(entry, requestedEvent(ask))
    })
  }

  /** Answer one parked request. True only when a pending relay call was resolved. */
  reply(attemptId: string, toolUseId: string, decision: 'allow_once' | 'deny_once'): boolean {
    const entry = this.attempts.get(attemptId)
    const ask = entry?.pending.get(toolUseId)
    if (!entry || !ask) return false
    entry.pending.delete(toolUseId)
    ask.settle(decision === 'allow_once' ? { behavior: 'allow', updatedInput: ask.input } : deny('Denied by the task owner.'))
    return true
  }

  denyAll(attemptId: string, reason: string): void {
    const entry = this.attempts.get(attemptId)
    if (!entry) return
    const asks = [...entry.pending.values()]
    entry.pending.clear()
    for (const ask of asks) {
      ask.settle(deny(reason))
      this.notify(entry, { type: 'permission.cleared', backendRequestId: ask.toolUseId })
    }
  }

  /** Receive relay events for an attempt; currently parked requests are replayed immediately. */
  subscribe(attemptId: string, listener: (e: RelayEvent) => void): () => void {
    const entry = this.attempts.get(attemptId)
    if (!entry) return () => undefined
    entry.listeners.add(listener)
    for (const ask of entry.pending.values()) listener(requestedEvent(ask))
    return () => { entry.listeners.delete(listener) }
  }

  private notify(entry: AttemptRelay, e: RelayEvent): void {
    for (const l of entry.listeners) l(e)
  }

  /** After a router restart the relay may call before observe() re-registers the attempt. */
  private async waitForAttempt(attemptId: string, signal: AbortSignal): Promise<AttemptRelay | undefined> {
    const found = this.attempts.get(attemptId)
    if (found || signal.aborted) return found
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); this.waiters.get(attemptId)?.delete(done); resolve() }
      const timer = setTimeout(done, REGISTRATION_WAIT_MS)
      signal.addEventListener('abort', done, { once: true })
      this.waiters.set(attemptId, new Set([...(this.waiters.get(attemptId) ?? []), done]))
    })
    return this.attempts.get(attemptId)
  }
}

function requestedEvent(ask: PendingAsk): RelayEvent {
  return { type: 'permission.requested', backendRequestId: ask.toolUseId, toolCallId: ask.toolUseId, toolName: ask.toolName, description: ask.description }
}
