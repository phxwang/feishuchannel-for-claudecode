/**
 * TaskService: the single source of truth behind the MCP facade. Validates
 * arguments, applies idempotency, dispatches to handlers and owns the engine.
 */
import { randomUUID } from 'crypto'
import type { AccessContext } from '../access'
import type { BackendRegistry } from '../backends/registry'
import { DomainError, toDomainError } from '../errors'
import { MUTATION_TOOLS, TOOL_ARGS, LIMITS, type ToolName, type PrepareArgs } from '../schema/tools'
import type { TaskStore } from '../store/task-store'
import type { Clock } from '../time'
import { Committer, Notifier, taskEvent } from './commit'
import * as controls from './controls'
import { Engine } from './engine'
import { errorEnvelope, okEnvelope, ROUTER_CONTRACT_VERSION, type Envelope } from './envelope'
import { requestFinalize } from './finalize'
import { OperationRunner } from './operations'
import { loadCandidateCaps, prepareTask } from './prepare'
import { Queries } from './queries'
import { startupRecovery } from './recovery'
import { armTimer } from './timers'
import { newId } from '../ids'

export interface TaskServiceOptions {
  store: TaskStore
  clock: Clock
  registry: BackendRegistry
  access: AccessContext
  runRoot: string
  log: (msg: string) => void
  maxConcurrentTasks?: number
  releaseGraceMs?: number
  reconcileRetryMs?: number
  /** Drain mode: prepare/start rejected, everything else works (design doc §19). */
  drain?: boolean
}

export class TaskService {
  readonly engine: Engine
  readonly notifier = new Notifier()
  readonly committer: Committer
  private ops: OperationRunner
  private queries: Queries
  private recovering = true
  readonly routerInstanceId: string

  constructor(private o: TaskServiceOptions) {
    this.committer = new Committer(o.store, o.clock, this.notifier)
    this.engine = new Engine({
      store: o.store, committer: this.committer, clock: o.clock, registry: o.registry, runRoot: o.runRoot, log: o.log,
      releaseGraceMs: o.releaseGraceMs ?? 5000, reconcileRetryMs: o.reconcileRetryMs ?? 30_000, maxConcurrentTasks: o.maxConcurrentTasks,
    })
    this.committer.onCommitted = task => { if (!this.stopped) armTimer(this.engine, task) }
    this.ops = new OperationRunner(o.store, o.clock)
    this.queries = new Queries(o.store, this.notifier)
    let id = o.store.getMeta('router_instance_id')
    if (!id) { id = newId('rti'); o.store.setMeta('router_instance_id', id) }
    this.routerInstanceId = id
  }

  async start(): Promise<void> {
    this.recovering = true
    try { await startupRecovery(this.engine) } finally { this.recovering = false }
  }

  private stopped = false

  stop(): void { this.stopped = true; this.engine.stop() }

  /** Tasks not CLOSED (including UNKNOWN) keep the router from idling out. */
  hasLiveWork(): boolean {
    try { return this.o.store.listNonClosed().length > 0 } catch { return true }
  }

  async call(tool: string, rawArgs: unknown): Promise<Envelope> {
    const fallbackId = randomUUID()
    const rawRequestId = typeof (rawArgs as { requestId?: unknown })?.requestId === 'string' ? (rawArgs as { requestId: string }).requestId : fallbackId
    if (!(tool in TOOL_ARGS)) return errorEnvelope(rawRequestId, new DomainError('INVALID_REQUEST', `Unknown tool ${tool}.`))
    let size = 0
    try { size = Buffer.byteLength(JSON.stringify(rawArgs ?? {}), 'utf8') } catch { /* validated below */ }
    if (size > LIMITS.requestBytes) return errorEnvelope(rawRequestId, new DomainError('REQUEST_TOO_LARGE', 'The request exceeds the 1 MiB limit.'))
    const parsed = TOOL_ARGS[tool as ToolName].safeParse(rawArgs ?? {})
    if (!parsed.success) {
      return errorEnvelope(rawRequestId, new DomainError('INVALID_REQUEST', 'Invalid tool arguments.', {
        issues: parsed.error.issues.slice(0, 20).map(i => ({ path: i.path.join('.'), message: i.message })),
      }))
    }
    const args = parsed.data as Record<string, any>
    const requestId: string = args.requestId ?? fallbackId
    try {
      if (MUTATION_TOOLS.has(tool as ToolName)) return await this.mutate(tool as ToolName, args, requestId)
      return okEnvelope(requestId, await this.query(tool as ToolName, args))
    } catch (e) {
      return errorEnvelope(requestId, toDomainError(e))
    }
  }

  private async query(tool: ToolName, a: Record<string, any>): Promise<Record<string, unknown>> {
    switch (tool) {
      case 'router_health': return this.health()
      case 'router_capabilities': return this.capabilities()
      case 'router_task_get': return this.queries.get(a.taskId)
      case 'router_task_lookup': return this.queries.lookup(a.clientId, a.clientTaskId)
      case 'router_events_read': return this.queries.events(a as any)
      case 'router_task_result': return this.queries.result(a as any)
      case 'router_turn_text_read': return this.queries.turnText(a as any)
      default: throw new DomainError('INVALID_REQUEST', `Unknown query ${tool}.`)
    }
  }

  private async mutate(tool: ToolName, a: Record<string, any>, requestId: string): Promise<Envelope> {
    const e = this.engine
    const creating = tool === 'router_task_prepare' || tool === 'router_task_start'
    if (creating && this.recovering) throw new DomainError('RECOVERY_IN_PROGRESS', 'Recovery is still running.', { retryAfterMs: 1000 })
    if (creating && this.o.drain) throw new DomainError('SERVICE_UNAVAILABLE', 'The task service is draining; new tasks are not accepted.', {}, { retryable: false })
    const taskTarget = () => {
      const t = this.o.store.getTask(a.taskId)
      if (!t) throw new DomainError('TASK_NOT_FOUND', 'No such task.', { taskId: a.taskId })
      return { clientId: t.clientId, target: t.taskId }
    }
    if (tool === 'router_task_prepare') {
      const caps = await loadCandidateCaps(this.o.registry, a as PrepareArgs)
      return this.ops.run(tool, a as any, requestId, () => ({ clientId: a.clientId, target: 'create' }), () => ({
        data: prepareTask({ store: this.o.store, committer: this.committer, clock: this.o.clock, registry: this.o.registry, access: this.o.access }, a as PrepareArgs, caps),
        after: () => { const t = this.o.store.getTaskByClient(a.clientId, a.clientTaskId); if (t) armTimer(e, t) },
      }))
    }
    const handlers: Partial<Record<ToolName, () => ReturnType<typeof controls.startTask>>> = {
      router_task_start: () => controls.startTask(e, a as any),
      router_permission_reply: () => controls.replyPermission(e, a as any),
      router_task_seal: () => controls.sealTask(e, a as any),
      router_task_close: () => controls.closeTask(e, a as any),
      router_task_cancel: () => controls.cancelTask(e, a as any),
      router_task_add_turn: () => controls.addTurn(e, a as any),
      router_task_authorize: () => controls.authorizeTask(e, a as any),
    }
    return this.ops.run(tool, a as any, requestId, taskTarget, handlers[tool]!)
  }

  health(): Record<string, unknown> {
    try {
      this.o.store.setMeta('health_probe', String(this.o.clock.now()))
      this.o.store.getMeta('health_probe')
    } catch {
      throw new DomainError('STORAGE_UNAVAILABLE', 'The task store is not readable and writable.')
    }
    return { status: 'ok', routerInstanceId: this.routerInstanceId, routerContractVersion: ROUTER_CONTRACT_VERSION, recoveryInProgress: this.recovering }
  }

  async capabilities(): Promise<Record<string, unknown>> {
    const backends = (await this.o.registry.list()).map(c => ({
      kind: c.kind, mode: c.mode, available: c.available, availabilityReason: c.availabilityReason, features: c.features,
      permissionModes: c.permissionModes, maxConcurrentTasks: this.o.registry.cap(c.kind) ?? null,
      fallbackContractVersion: ROUTER_CONTRACT_VERSION,
      supportedFallbackTriggers: c.fallback.supportedFallbackTriggers,
      orderedFallback: c.fallback.orderedFallback, cleanFailureFallback: c.fallback.cleanFailureFallback,
      checkpointHandoff: c.fallback.checkpointHandoff, sameOwnerResetRecovery: c.fallback.sameOwnerResetRecovery, nativeGoal: c.fallback.nativeGoal,
    }))
    const { maxTurnTextBytes: _a, inlineFinalTextBytes: _b, maxSummariesPerPage: _c, preparedTtlSeconds: _d, transitionRequestMaxSeconds: _e, goalCapsuleMaxBytes: _f, ...limits } = LIMITS
    return {
      routerContractVersion: ROUTER_CONTRACT_VERSION,
      routerInstanceId: this.routerInstanceId,
      backends,
      limits: { ...limits, maxConcurrentTasks: this.o.maxConcurrentTasks ?? null },
    }
  }

  /** Resource reads (design doc §6 of the spec): snapshot and first result page, no envelope. */
  readResource(uri: string): { kind: 'ok'; data: Record<string, unknown> } | { kind: 'not_found' } | { kind: 'error'; code: string; retryable: boolean; message: string } {
    const m = /^router:\/\/tasks\/([^/]+)\/(snapshot|result)$/.exec(uri)
    if (!m) return { kind: 'not_found' }
    try {
      if (m[2] === 'snapshot') return { kind: 'ok', data: this.queries.get(m[1]).task as unknown as Record<string, unknown> }
      return { kind: 'ok', data: this.queries.result({ taskId: m[1] }) }
    } catch (e) {
      const d = toDomainError(e)
      if (d.code === 'TASK_NOT_FOUND') return { kind: 'not_found' }
      return { kind: 'error', code: d.code, retryable: d.retryable, message: d.message }
    }
  }

  // ── operator-only (never exposed through MCP) ───────────────────────────
  adminInspect(taskId: string): Record<string, unknown> {
    const t = this.o.store.getTask(taskId)
    if (!t) throw new DomainError('TASK_NOT_FOUND', 'No such task.', { taskId })
    return { task: t, attempts: this.o.store.listAttempts(taskId), turns: this.o.store.listTurns(taskId) }
  }

  adminRelease(taskId: string, note: string): Record<string, unknown> {
    const t = this.o.store.getTask(taskId)
    if (!t) throw new DomainError('TASK_NOT_FOUND', 'No such task.', { taskId })
    if (t.phase !== 'UNKNOWN') throw new DomainError('TASK_BUSY', 'Only an UNKNOWN task can be released by an operator.', { phase: t.phase })
    this.engine.stopObserving(taskId)
    this.committer.commit(taskId, cur => {
      const attempt = this.engine.currentAttempt(cur)
      return {
        task: { ...cur, owner: { ...cur.owner, state: 'released', generation: cur.owner.generation + 1 } },
        attempts: attempt ? [{ ...attempt, ownerReleased: true }] : [],
        control: true,
        events: [taskEvent('owner.reconciled', { source: 'operator', note })],
      }
    })
    requestFinalize(this.engine, taskId, { kind: 'terminate', reason: 'OPERATOR_RELEASED', graceSeconds: null })
    return { accepted: true }
  }

  /** Retention (design doc §10.5). */
  prune(now: number): { events: number; bodies: number } {
    const { store } = this.o
    let events = 0
    let bodies = 0
    for (const id of store.closedBefore(now - LIMITS.eventRetentionDays * 86400_000)) events += store.deleteEvents(id)
    for (const id of store.closedBefore(now - LIMITS.resultRetentionDays * 86400_000)) {
      const t = store.getTask(id)
      if (!t || t.resultExpired) continue
      store.tx(() => { store.deleteResultBodies(id); store.putTask({ ...t, resultExpired: true }) })
      bodies++
    }
    return { events, bodies }
  }
}
