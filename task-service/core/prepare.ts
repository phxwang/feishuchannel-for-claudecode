/** router_task_prepare (design doc §9.3). No backend I/O. */
import { resolveWorkdir, type AccessContext } from '../access'
import type { BackendCapabilities } from '../backends/backend'
import type { BackendRegistry } from '../backends/registry'
import { DomainError } from '../errors'
import { fallbackPlanSha256, validateTaskPolicy } from '../fallback/policy'
import { newId } from '../ids'
import { jcsSha256, sha256Hex } from '../jcs'
import type { TaskRecord } from '../model'
import { LIMITS, type PrepareArgs } from '../schema/tools'
import type { TaskStore } from '../store/task-store'
import type { Clock } from '../time'
import { taskEvent, type Committer } from './commit'
import { NO_OWNER } from './records'
import { resourceUris, toSnapshot } from './snapshot'

export interface PrepareDeps {
  store: TaskStore
  committer: Committer
  clock: Clock
  registry: BackendRegistry
  access: AccessContext
}

/** Capabilities are looked up before the synchronous transaction runs. */
export async function loadCandidateCaps(registry: BackendRegistry, args: PrepareArgs): Promise<(BackendCapabilities | undefined)[]> {
  return Promise.all(args.policy.fallback.candidates.map(c => registry.capabilitiesFor(c)))
}

function validateGoalInput(args: PrepareArgs): void {
  if (args.assignment.inputKind !== 'native_goal') return
  const p = args.assignment.prompt
  if (!p.startsWith('/goal ') || /[\r\n]/.test(p) || Buffer.byteLength(p.slice(6), 'utf8') > LIMITS.goalCapsuleMaxBytes || !p.slice(6).trim()) {
    throw new DomainError('INVALID_REQUEST', 'native_goal input must be "/goal <single-line capsule>" with at most 900 bytes.')
  }
}

export function prepareTask(deps: PrepareDeps, args: PrepareArgs, caps: (BackendCapabilities | undefined)[]): Record<string, unknown> {
  const { store, clock, registry } = deps
  validateGoalInput(args)
  const resolved = resolveWorkdir(args.workdir, args.projectId, deps.access)
  args.policy.fallback.candidates.forEach((c, i) => {
    registry.validateCandidate(c, i)
    if (!resolved.allowedAgents.includes(c.kind)) {
      throw new DomainError('PROJECT_NOT_ALLOWED', `Backend ${c.kind} is not allowed for this workdir.`, { candidateIndex: i, kind: c.kind })
    }
  })
  if (args.policy.permissionMode !== 'broker' && args.policy.permissionMode !== 'backend_policy') {
    throw new DomainError('INVALID_REQUEST', 'Unsupported permissionMode.')
  }
  validateTaskPolicy(args.policy, args.backend, args.assignment.inputKind, caps)

  const promptSha256 = sha256Hex(Buffer.from(args.assignment.prompt, 'utf8'))
  const planSha = fallbackPlanSha256(args.policy.fallback)
  const assignment = {
    inputKind: args.assignment.inputKind,
    promptSha256,
    contractSha256: args.assignment.contractSha256,
    metadata: args.assignment.metadata ?? {},
  }
  const correlation = args.correlation ?? {}
  // Semantic frozen content (excludes tracing/idempotency) — identical prepare replays the same task.
  const frozenSha256 = jcsSha256({
    clientId: args.clientId, clientTaskId: args.clientTaskId, scopeKey: args.scopeKey, correlation,
    projectId: args.projectId, workdir: resolved.identity.canonicalPath, backend: args.backend, assignment, policy: args.policy,
  })

  const existing = store.getTaskByClient(args.clientId, args.clientTaskId)
  if (existing) {
    if (existing.frozenSha256 !== frozenSha256) {
      throw new DomainError('CLIENT_TASK_CONFLICT', 'This clientTaskId already names a task with different content.', { taskId: existing.taskId })
    }
    return { task: toSnapshot(existing, undefined), resources: resourceUris(existing.taskId) }
  }
  const busy = store.findActiveScope(args.clientId, args.scopeKey)
  if (busy) throw new DomainError('SCOPE_BUSY', 'Another task holds this scope until it is CLOSED.', { taskId: busy.taskId })

  const now = clock.now()
  const task: TaskRecord = {
    taskId: newId('task'),
    clientId: args.clientId,
    clientTaskId: args.clientTaskId,
    scopeKey: args.scopeKey,
    correlation,
    projectId: resolved.projectId,
    workdirSource: resolved.workdirSource,
    workdir: resolved.identity,
    backend: args.backend,
    assignment,
    policy: args.policy,
    fallbackPlanSha256: planSha,
    permissionPolicy: registry.permissionPolicy(args.backend, args.policy.permissionMode),
    frozenSha256,
    phase: 'PREPARED',
    controlVersion: 0,
    sealed: false,
    owner: NO_OWNER,
    currentTurnId: null,
    executionOutcome: null,
    lastSeq: 0,
    eventBytes: 0,
    createdAtMs: now,
    updatedAtMs: now,
    closedAtMs: null,
    selectedCandidateIndex: 0,
    actualBackend: null,
    currentExecutionAttemptId: null,
    executionAttemptCount: 0,
    switchesUsed: 0,
    fallbackState: 'idle',
    pendingAuthorization: null,
    grant: null,
    permissions: [],
    budgets: {
      preparedExpiresAtMs: now + LIMITS.preparedTtlSeconds * 1000,
      startedAtMs: null, runDeadlineAtMs: null, recoveryUsedMs: 0, recoveryEnteredAtMs: null,
      retryWakeAtMs: null, quiescentDeadlineAtMs: null, lastActivityAtMs: null,
    },
    intent: null,
    terminalReason: null,
    needsAttention: false,
    cleanup: { ownerReleased: null, backgroundWorkSettled: null, detail: null },
    resultExpired: false,
  }
  store.insertTask(task, args.assignment.prompt)
  const res = deps.committer.commit(task.taskId, t => ({
    task: t,
    events: [taskEvent('task.prepared', { clientTaskId: t.clientTaskId, workdirSource: t.workdirSource, fallbackPlanSha256: t.fallbackPlanSha256 })],
  }))
  const stored = res?.task ?? task
  return { task: toSnapshot(stored, undefined), resources: resourceUris(stored.taskId) }
}
