/**
 * Backend lookup + candidate validation against the server-side config
 * (model allowlists, variants, which kinds are configured at all).
 */
import type { TaskServiceConfig } from '../config'
import { DomainError } from '../errors'
import type { PermissionMode } from '../schema/policy'
import type { BackendKind, BackendMode, Candidate } from '../schema/primitives'
import type { BackendCapabilities, TaskBackend } from './backend'

/** Known combinations that exist in the contract vocabulary but have no task adapter yet. */
const NOT_IMPLEMENTED: { kind: BackendKind; mode: BackendMode }[] = [
  { kind: 'claude', mode: 'tmux' },
  { kind: 'opencode', mode: 'acp' },
]

function stub(kind: BackendKind, mode: BackendMode): BackendCapabilities {
  return {
    kind, mode, available: false, availabilityReason: 'not_implemented',
    features: { isolatedSession: false, samePrimaryTurns: false, recoverAcceptedTurn: false, permissionReply: false, cancel: false, eventReplay: false },
    permissionModes: [],
    fallback: { orderedFallback: false, supportedFallbackTriggers: [], cleanFailureFallback: false, checkpointHandoff: false, sameOwnerResetRecovery: false, nativeGoal: false },
  }
}

export class BackendRegistry {
  constructor(private backends: TaskBackend[], private config: TaskServiceConfig) {}

  get(c: { kind: BackendKind; mode: BackendMode }): TaskBackend | undefined {
    return this.backends.find(b => b.kind === c.kind && b.mode === c.mode)
  }

  async capabilitiesFor(c: { kind: BackendKind; mode: BackendMode }): Promise<BackendCapabilities | undefined> {
    const b = this.get(c)
    if (b) return b.capabilities()
    if (NOT_IMPLEMENTED.some(n => n.kind === c.kind && n.mode === c.mode)) return stub(c.kind, c.mode)
    return undefined
  }

  async list(): Promise<BackendCapabilities[]> {
    const real = await Promise.all(this.backends.map(b => b.capabilities()))
    return [...real, ...NOT_IMPLEMENTED.filter(n => !this.get(n)).map(n => stub(n.kind, n.mode))]
  }

  backendConfig(kind: BackendKind): { models: string[]; maxConcurrentTasks?: number } | undefined {
    const b = this.config.backends as Record<string, { models: string[]; maxConcurrentTasks?: number; enabled?: boolean } | undefined>
    const entry = b[kind]
    if (!entry) return undefined
    if (kind === 'fake' && !entry.enabled) return undefined
    return entry
  }

  /** Throws when the candidate is not usable for tasks on this server. */
  validateCandidate(c: Candidate, index: number): void {
    const cfg = this.backendConfig(c.kind)
    if (!cfg) throw new DomainError('UNSUPPORTED_CAPABILITY', `Backend ${c.kind} is not configured for tasks.`, { candidateIndex: index, kind: c.kind })
    if (!this.get(c) && !NOT_IMPLEMENTED.some(n => n.kind === c.kind && n.mode === c.mode)) {
      throw new DomainError('UNSUPPORTED_CAPABILITY', `Backend ${c.kind}/${c.mode} is not available.`, { candidateIndex: index, kind: c.kind, mode: c.mode })
    }
    if (!cfg.models.includes(c.model)) throw new DomainError('INVALID_REQUEST', 'Model is not in the server allowlist for this backend.', { candidateIndex: index, model: c.model })
    if (c.variant !== null && c.kind !== 'fake') {
      throw new DomainError('UNSUPPORTED_CAPABILITY', 'Model variants are not supported by this backend in phase 1.', { candidateIndex: index })
    }
  }

  /** The non-interactive policy a backend_policy task will run under, as recorded in the snapshot. */
  permissionPolicy(c: Candidate, mode: PermissionMode): Record<string, unknown> | null {
    if (mode === 'broker') return null
    const b = this.config.backends
    switch (c.kind) {
      case 'codex': return { kind: 'codex', sandbox: b.codex?.sandbox ?? 'workspace-write', approval: 'never' }
      case 'claude': return { kind: 'claude', permissionPrompts: 'none', permissionMode: 'default' }
      case 'agy': return { kind: 'agy', permissionMode: b.agy?.permissionMode ?? null, dialogs: 'deny' }
      case 'opencode': return { kind: 'opencode', permissions: 'reject' }
      case 'fake': return { kind: 'fake' }
    }
  }

  cap(kind: BackendKind): number | undefined {
    return this.backendConfig(kind)?.maxConcurrentTasks
  }
}
