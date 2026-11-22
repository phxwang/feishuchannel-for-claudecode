/**
 * startTaskService(): wiring used by router.ts (design doc §5.1).
 *   1. private 0700 directory STATE_DIR/task-service
 *   2. task-service.db + migrations + instance id
 *   3. recovery with admission closed
 *   4. task.sock (0600)
 * Fails closed: on any error the task service does not start, the chat
 * router keeps running.
 */
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { checkPrivateDir } from './access'
import type { TaskBackend } from './backends/backend'
import { BackendRegistry } from './backends/registry'
import { finalizeTaskServiceConfig, type TaskServiceConfig, type TaskServiceConfigInput } from './config'
import { TaskService } from './core/service'
import { IpcServer } from './ipc/server'
import type { PermissionAskParams } from './ipc/protocol'
import { TaskStore } from './store/task-store'
import { systemClock } from './time'

export interface StartOptions {
  input: TaskServiceConfigInput
  projects: Record<string, { workdir: string; allowedAgents: string[] }>
  allowedRoots: string[]
  stateDir: string
  log: (msg: string) => void
  /** Build backends once the config is finalized (and the socket path is known). */
  buildBackends: (config: TaskServiceConfig, paths: TaskServicePaths) => TaskBackend[]
  /** Optional permission relay handler (Claude print backend). */
  permissionAsk?: (p: PermissionAskParams, signal: AbortSignal) => Promise<unknown>
}

export interface TaskServicePaths {
  dir: string
  socketPath: string
  dbPath: string
  runRoot: string
}

export interface RunningTaskService {
  service: TaskService
  ipc: IpcServer | null
  paths: TaskServicePaths
  drain: boolean
  hasLiveWork(): boolean
  stop(): void
}

const RETENTION_INTERVAL_MS = 60 * 60 * 1000

export function taskServicePaths(stateDir: string): TaskServicePaths {
  const dir = join(stateDir, 'task-service')
  return { dir, socketPath: join(dir, 'task.sock'), dbPath: join(dir, 'task-service.db'), runRoot: join(dir, 'runs') }
}

/**
 * Returns null when the service must not run (disabled with no live tasks).
 * With enabled=false but live tasks in the DB, runs in drain mode.
 */
export async function startTaskService(o: StartOptions): Promise<RunningTaskService | null> {
  const paths = taskServicePaths(o.stateDir)
  const enabled = o.input.enabled
  if (!enabled && !existsSync(paths.dbPath)) return null

  const config = finalizeTaskServiceConfig(o.input, { projects: o.projects, allowedRoots: o.allowedRoots, stateDir: o.stateDir })
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 })
  checkPrivateDir(paths.dir, process.getuid!())
  mkdirSync(paths.runRoot, { recursive: true, mode: 0o700 })

  const store = new TaskStore(paths.dbPath)
  const liveAtStart = store.listNonClosed()
  if (!enabled && liveAtStart.length === 0) { store.close(); return null }
  const drain = !enabled
  if (drain) o.log(`task-service: disabled but ${liveAtStart.length} task(s) are not CLOSED; running in drain mode: ${liveAtStart.map(t => t.taskId).join(', ')}`)

  const registry = new BackendRegistry(o.buildBackends(config, paths), config)
  const service = new TaskService({
    store, clock: systemClock, registry, runRoot: paths.runRoot, log: o.log,
    access: { config, stateDir: o.stateDir, uid: process.getuid!() },
    maxConcurrentTasks: config.maxConcurrentTasks, drain,
  })
  await service.start()

  const ipc = new IpcServer({ socketPath: paths.socketPath, service, log: o.log, permissionAsk: o.permissionAsk })
  await ipc.listen()
  o.log(`task-service: listening on ${paths.socketPath}${drain ? ' (drain mode)' : ''}`)

  const prune = setInterval(() => {
    try {
      const r = service.prune(Date.now())
      if (r.events || r.bodies) o.log(`task-service: pruned events of ${r.events} rows, ${r.bodies} result bodies`)
    } catch (e) { o.log(`task-service: retention failed: ${String(e)}`) }
  }, RETENTION_INTERVAL_MS)
  prune.unref?.()

  return {
    service, ipc, paths, drain,
    hasLiveWork: () => service.hasLiveWork() || ipc.connectionCount > 0,
    stop: () => { clearInterval(prune); ipc.close(); service.stop(); store.close() },
  }
}
