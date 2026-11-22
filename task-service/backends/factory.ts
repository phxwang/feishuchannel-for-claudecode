/**
 * Builds the task backends from the finalized `taskService` config. Every
 * backend runs through the router's EXISTING execution objects: OpenCode
 * through the router's OpenCodeAdapter and per-workdir session binding;
 * Claude, agy and Codex through the router's TmuxCliManager instances (the
 * same per-workdir tmux sessions chat uses). The task service only adds the
 * MCP-facing ledger on top.
 */
import { existsSync } from 'fs'
import type { OpenCodeAdapter } from '../../adapters/opencode/opencode-adapter'
import type { TmuxCliManager } from '../../tmux/manager'
import type { SpawnOptions } from '../../tmux/profile'
import type { TaskServiceConfig } from '../config'
import type { TaskServicePaths } from '../index'
import type { Candidate } from '../schema/primitives'
import type { TaskBackend } from './backend'
import { FakeBackend } from './fake'
import { OpenCodeTaskBackend } from './opencode'
import { SharedTmuxBackend, type TmuxTaskKind } from './tmux-shared'

export interface TmuxCliDeps {
  manager: TmuxCliManager
  /** The CLI binary that the manager's profile will spawn. */
  bin: string
  spawnFor: (candidate: Candidate, workdir: string) => SpawnOptions
  unavailableReason?: (workdir: string) => string | null
  onStopError?: (workdir: string, error: string) => void
}

export interface FactoryDeps {
  openCodeAdapter: OpenCodeAdapter | null
  /** The router's per-workdir OpenCode session lookup/creation. */
  openCodeSessionFor?: (directory: string) => Promise<string>
  openCodeSessionMissing?: (directory: string, sessionId: string) => void
  tmux: Partial<Record<TmuxTaskKind, TmuxCliDeps>>
  log: (msg: string) => void
}

function binAvailable(bin: string): () => Promise<{ ok: boolean; reason?: string }> {
  return async () => {
    const tmux = Bun.which('tmux') ?? (existsSync('/opt/homebrew/bin/tmux') ? '/opt/homebrew/bin/tmux' : null)
    if (!tmux) return { ok: false, reason: 'tmux is not installed' }
    const resolved = bin.includes('/') ? (existsSync(bin) ? bin : null) : Bun.which(bin)
    return resolved ? { ok: true } : { ok: false, reason: `${bin} not found` }
  }
}

export function createTaskBackends(config: TaskServiceConfig, _paths: TaskServicePaths, deps: FactoryDeps): TaskBackend[] {
  const out: TaskBackend[] = []
  const b = config.backends
  if (b.opencode) {
    if (deps.openCodeAdapter) out.push(new OpenCodeTaskBackend(deps.openCodeAdapter, { sessionFor: deps.openCodeSessionFor, onSessionMissing: deps.openCodeSessionMissing }))
    else deps.log('task-service: backends.opencode is configured but agents.opencode is missing; OpenCode tasks are unavailable')
  }
  for (const kind of ['claude', 'agy', 'codex'] as const) {
    if (!b[kind]) continue
    const t = deps.tmux[kind]
    if (!t) { deps.log(`task-service: backends.${kind} is configured but the router has no ${kind} tmux manager; ${kind} tasks are unavailable`); continue }
    out.push(new SharedTmuxBackend({
      kind, manager: t.manager, spawnFor: t.spawnFor, available: binAvailable(t.bin),
      unavailableReason: t.unavailableReason, onStopError: t.onStopError,
    }))
  }
  if (b.fake?.enabled) out.push(new FakeBackend())
  return out
}
