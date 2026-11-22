/**
 * Durable record shapes. Records are immutable values: every change builds a
 * new object (spread) and the store replaces the row inside one transaction.
 */
import type { Phase } from './lifecycle'
import type { TaskPolicy, TriggerCode, TriggerStage } from './schema/policy'
import type { Candidate, OwnerRef } from './schema/primitives'

export type OwnerState = 'none' | 'starting' | 'live' | 'released' | 'unknown'

export interface Owner {
  state: OwnerState
  executionId: string | null
  generation: number
  backendSessionId: string | null
  pid: number | null
  processStartIdentity: string | null
}

export type ExecutionOutcome = 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'not_started'
export type TurnOutcome = 'completed' | 'failed' | 'cancelled' | 'timed_out'
export type TurnState = 'pending' | 'submitted' | 'running' | 'waiting_permission' | 'waiting_input' | 'ended' | 'unknown'
export type Delivery = 'not_sent' | 'accepted' | 'unknown'
export type FallbackState = 'idle' | 'evaluating' | 'pending' | 'waiting_authorization' | 'waiting_retry' | 'exhausted' | 'blocked'

export interface WorkdirIdentity {
  canonicalPath: string
  dev: number
  ino: number
}

export interface Grant {
  kind: 'start' | 'transition'
  revision: string
  expiresAtMs: number
  promptSha256: string
  contractSha256: string
  fallbackPlanSha256: string
  transitionSha256: string | null
  transitionRequestId: string | null
  state: 'valid' | 'consumed' | 'void'
}

export interface PendingAuthorization {
  transitionRequestId: string
  action: 'fallback_dispatch' | 'same_owner_resume'
  candidateIndex: number
  backend: Candidate
  executionAttemptId: string
  previousOwner: OwnerRef | null
  triggerCode: TriggerCode | 'grant_expired' | 'recovery_restart'
  evidenceDigest: string
  checkpointSha256: string | null
  effectiveInputSha256: string
  transitionSha256: string
  nonce: string
  expiresAtMs: number
  requiredBusinessChecks: string[]
}

export type PermissionState = 'pending' | 'decided' | 'resolved' | 'unresolved_unknown' | 'expired'

export interface PermissionRecord {
  permissionRequestId: string
  backendRequestId: string
  turnId: string
  executionAttemptId: string
  executionId: string
  generation: number
  toolCallId: string | null
  toolName: string
  description: string
  options: { optionId: string; kind: 'allow_once' | 'deny_once' }[]
  expiresAtMs: number
  state: PermissionState
  decision: 'allow_once' | 'deny_once' | null
  backendConfirmed: boolean
}

export interface Budgets {
  preparedExpiresAtMs: number
  startedAtMs: number | null
  runDeadlineAtMs: number | null
  recoveryUsedMs: number
  recoveryEnteredAtMs: number | null
  retryWakeAtMs: number | null
  quiescentDeadlineAtMs: number | null
  lastActivityAtMs: number | null
}

export interface Cleanup {
  ownerReleased: boolean | null
  backgroundWorkSettled: boolean | null
  detail: string | null
}

export interface TaskIntent {
  kind: 'close' | 'cancel' | 'expire' | 'deny' | 'terminate'
  reason: string
  graceSeconds: number | null
}

export interface TaskRecord {
  taskId: string
  clientId: string
  clientTaskId: string
  scopeKey: string
  correlation: Record<string, string>
  projectId: string | null
  workdirSource: 'project' | 'dynamic'
  workdir: WorkdirIdentity
  backend: Candidate
  assignment: { inputKind: 'text' | 'native_goal'; promptSha256: string; contractSha256: string; metadata: Record<string, string> }
  policy: TaskPolicy
  fallbackPlanSha256: string
  permissionPolicy: Record<string, unknown> | null
  frozenSha256: string
  phase: Phase
  controlVersion: number
  sealed: boolean
  owner: Owner
  currentTurnId: string | null
  executionOutcome: ExecutionOutcome | null
  lastSeq: number
  eventBytes: number
  createdAtMs: number
  updatedAtMs: number
  closedAtMs: number | null
  selectedCandidateIndex: number
  actualBackend: Candidate | null
  currentExecutionAttemptId: string | null
  executionAttemptCount: number
  switchesUsed: number
  fallbackState: FallbackState
  pendingAuthorization: PendingAuthorization | null
  grant: Grant | null
  permissions: PermissionRecord[]
  budgets: Budgets
  intent: TaskIntent | null
  terminalReason: string | null
  needsAttention: boolean
  cleanup: Cleanup
  resultExpired: boolean
}

export type AttemptDelivery = 'not_sent' | 'in_flight' | 'accepted' | 'unknown'
export type AttemptState = 'planned' | 'starting' | 'running' | 'ended' | 'skipped' | 'blocked'

export interface AttemptFailure {
  code: TriggerCode | 'delivery_unknown' | 'cancelled' | 'timeout' | 'other'
  stage: TriggerStage | null
  detail: string
  evidenceDigest: string | null
}

export interface AttemptOwnerFacts {
  backendSessionId: string | null
  pid: number | null
  pgid: number | null
  processStartIdentity: string | null
  extra: Record<string, string | number | null>
}

export interface AttemptRecord {
  executionAttemptId: string
  taskId: string
  ordinal: number
  candidateIndex: number
  backend: Candidate
  executionId: string
  generation: number
  triggerCode: string | null
  evidenceDigest: string | null
  inputSha256: string
  isStartupRetry: boolean
  delivery: AttemptDelivery
  effectStatus: 'none' | 'partial' | 'unknown'
  state: AttemptState
  outcome: ExecutionOutcome | null
  failure: AttemptFailure | null
  blockedReason: string | null
  owner: AttemptOwnerFacts
  ownerReleased: boolean | null
  startedAtMs: number
  endedAtMs: number | null
}

export interface TurnRecord {
  turnId: string
  taskId: string
  executionAttemptId: string
  candidateIndex: number
  backendTurnId: string
  state: TurnState
  delivery: Delivery
  outcome: TurnOutcome | null
  startedAtMs: number | null
  endedAtMs: number | null
  finalTextSha256: string | null
  finalTextBytes: number | null
  finalTextComplete: boolean
  protocol: { backendFinished: boolean | null; activeToolCount: number | null; stopReason: string | null }
  process: { exitCode: number | null; signal: string | null; controlledShutdown: boolean | null }
  evidence: { backendSessionId: string | null; backendTurnId: string | null; transcriptPath: string | null }
}

export interface TaskEvent {
  taskId: string
  seq: number
  type: string
  at: string
  executionId: string | null
  turnId: string | null
  executionAttemptId: string | null
  candidateIndex: number | null
  data: Record<string, unknown>
}
