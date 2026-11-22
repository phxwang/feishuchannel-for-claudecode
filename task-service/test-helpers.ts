/** Shared fixtures for task-service tests. */
import { mkdirSync, mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { TaskBackend } from './backends/backend'
import { FakeBackend } from './backends/fake'
import { BackendRegistry } from './backends/registry'
import { finalizeTaskServiceConfig, taskServiceConfigSchema } from './config'
import type { Envelope } from './core/envelope'
import { TaskService } from './core/service'
import { sha256Hex } from './jcs'
import { fallbackPlanSha256 } from './fallback/policy'
import { TaskStore } from './store/task-store'
import { formatTimestamp, systemClock, type Clock } from './time'

export interface Harness {
  dir: string
  stateDir: string
  workdir: string
  dbPath: string
  fake: FakeBackend
  service: TaskService
  store: TaskStore
  clock: Clock
  ready: Promise<void>
  call: (tool: string, args: Record<string, unknown>) => Promise<Envelope>
  data: (tool: string, args: Record<string, unknown>) => Promise<any>
}

/** Short temp roots: Unix socket paths are limited to 104 bytes on macOS. */
export function tempRoot(prefix = 'rtask-'): string {
  const base = process.platform === 'darwin' ? '/tmp' : tmpdir()
  return realpathSync(mkdtempSync(join(base, prefix)))
}

export function makeHarness(opts: { dir?: string; fake?: FakeBackend; backends?: TaskBackend[]; clock?: Clock; config?: Record<string, unknown>; releaseGraceMs?: number } = {}): Harness {
  const dir = opts.dir ?? tempRoot()
  const stateDir = join(dir, 'state')
  const workRoot = join(dir, 'work')
  const workdir = join(workRoot, 'job')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  mkdirSync(workdir, { recursive: true, mode: 0o755 })
  const raw = taskServiceConfigSchema.parse({
    enabled: true,
    dynamicWorkdirs: { roots: [workRoot], allowedAgents: ['fake', 'opencode', 'claude', 'codex', 'agy'] },
    backends: { fake: { enabled: true, models: ['fake-a', 'fake-b', 'fake-c'] } },
    ...(opts.config ?? {}),
  })
  const config = finalizeTaskServiceConfig(raw, { projects: {}, allowedRoots: [workRoot], stateDir, home: join(dir, 'home') })
  const fake = opts.fake ?? new FakeBackend()
  const registry = new BackendRegistry([fake, ...(opts.backends ?? [])], config)
  const dbPath = join(stateDir, 'task-service.db')
  const store = new TaskStore(dbPath)
  const clock = opts.clock ?? systemClock
  const runRoot = join(stateDir, 'runs')
  mkdirSync(runRoot, { recursive: true, mode: 0o700 })
  const service = new TaskService({
    store, clock, registry, runRoot, log: () => {},
    access: { config, stateDir, uid: process.getuid!(), home: join(dir, 'home') },
    releaseGraceMs: opts.releaseGraceMs ?? 200, reconcileRetryMs: 100,
  })
  const ready = service.start()
  const call = async (tool: string, args: Record<string, unknown>) => { await ready; return service.call(tool, args) }
  const data = async (tool: string, args: Record<string, unknown>) => {
    const env = await call(tool, args)
    if (!env.ok) throw new Error(`${tool} failed: ${JSON.stringify(env.error)}`)
    return env.data
  }
  return { dir, stateDir, workdir, dbPath, fake, service, store, clock, call, data, ready }
}

export const CONTRACT = 'a'.repeat(64)

export function fallbackPolicy(candidates: string[], extra: Record<string, unknown> = {}) {
  const enabled = candidates.length > 1 || Boolean(extra.enabled)
  return {
    enabled,
    candidates: candidates.map(model => ({ kind: 'fake' as const, mode: 'exec' as const, model, variant: null })),
    triggerOn: [],
    maxSwitches: 0,
    startupRetriesPerCandidate: 0,
    retryDelaySeconds: 0,
    maxRecoverySeconds: 60,
    onExhausted: 'fail',
    sameOwnerReset: { enabled: false, maxWaitSeconds: 0, maxResumeActions: 0 },
    ...extra,
  }
}

export function prepareArgs(h: Harness, over: Record<string, any> = {}) {
  const candidates: string[] = over.candidates ?? ['fake-a']
  const fallback = over.fallback ?? fallbackPolicy(candidates, over.fallbackExtra)
  return {
    idempotencyKey: over.idempotencyKey ?? 'prep-1',
    clientId: over.clientId ?? 'test-client',
    clientTaskId: over.clientTaskId ?? 'job-1',
    scopeKey: over.scopeKey ?? 'scope-1',
    projectId: null,
    workdir: over.workdir ?? h.workdir,
    backend: fallback.candidates[0],
    assignment: { inputKind: 'text', prompt: over.prompt ?? 'Do the thing.', contractSha256: CONTRACT },
    policy: {
      inputMode: 'single_turn',
      fallback,
      permissionMode: over.permissionMode ?? 'broker',
      runTimeoutSeconds: over.runTimeoutSeconds ?? 600,
      idleTimeoutSeconds: 600,
      permissionTimeoutSeconds: 600,
      quiescentTimeoutSeconds: 600,
    },
    ...(over.correlation ? { correlation: over.correlation } : {}),
  }
}

export function authorization(args: ReturnType<typeof prepareArgs>, clock: Clock = systemClock, ttlMs = 30_000) {
  return {
    revision: 'rev-1',
    expiresAt: formatTimestamp(clock.now() + ttlMs),
    promptSha256: sha256Hex(Buffer.from(args.assignment.prompt, 'utf8')),
    contractSha256: CONTRACT,
    fallbackPlanSha256: fallbackPlanSha256(args.policy.fallback as any),
  }
}

/** Prepare + start; returns the prepared snapshot. */
export async function startTask(h: Harness, over: Record<string, any> = {}) {
  const args = prepareArgs(h, over)
  const prepared = await h.data('router_task_prepare', args)
  const task = prepared.task
  const started = await h.data('router_task_start', {
    taskId: task.taskId, idempotencyKey: `${args.clientTaskId}-start`, expectedControlVersion: task.controlVersion,
    authorization: authorization(args, h.clock),
  })
  return { args, task: started.task }
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 3000, stepMs = 10): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, stepMs))
  }
}

export async function waitPhase(h: Harness, taskId: string, phase: string, timeoutMs = 3000) {
  return waitFor(() => { const t = h.store.getTask(taskId); return t && t.phase === phase ? t : undefined }, timeoutMs)
}

export function eventTypes(h: Harness, taskId: string): string[] {
  return h.store.readEvents(taskId, 0, 10_000, 64 * 1024 * 1024).map(e => e.type)
}

export const ended = (text = 'done', outcome: 'completed' | 'failed' = 'completed', extra: Record<string, unknown> = {}) => ({
  type: 'turn.ended' as const, outcome, finalText: text,
  protocol: { backendFinished: true, activeToolCount: 0, stopReason: 'end_turn' },
  process: { exitCode: null, signal: null, controlledShutdown: false },
  ...extra,
})
