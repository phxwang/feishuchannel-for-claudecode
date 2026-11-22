/**
 * Domain error codes for the router task service (design doc §13, spec §8).
 * Only the service builds envelopes; handlers throw DomainError and the
 * envelope layer turns it into `{ok:false, error}`.
 */

export const ERROR_CODES = [
  // validation / access
  'INVALID_REQUEST', 'INVALID_DIGEST', 'REQUEST_TOO_LARGE', 'PROJECT_NOT_ALLOWED', 'WORKDIR_NOT_ALLOWED', 'PEER_NOT_ALLOWED',
  // identity / concurrency
  'TASK_NOT_FOUND', 'TURN_NOT_FOUND', 'CLIENT_TASK_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'OPERATION_IN_PROGRESS',
  'VERSION_CONFLICT', 'SCOPE_BUSY', 'OWNER_MISMATCH', 'OWNER_UNVERIFIED',
  // lifecycle / policy
  'TASK_BUSY', 'TASK_SEALED', 'TASK_NOT_QUIESCENT', 'PERMISSION_STALE', 'INVALID_OPTION', 'UNSUPPORTED_CAPABILITY',
  'AUTHORIZATION_EXPIRED', 'ASSIGNMENT_MISMATCH', 'RESULT_NOT_READY',
  // observation / retention
  'INVALID_CURSOR', 'EVENT_CURSOR_EXPIRED', 'RESULT_EXPIRED',
  // capacity / availability
  'CAPACITY_EXHAUSTED', 'BACKEND_UNAVAILABLE', 'SERVICE_UNAVAILABLE', 'STORAGE_UNAVAILABLE', 'RECOVERY_IN_PROGRESS', 'INTERNAL_ERROR',
  // fallback / grants
  'AUTHORIZATION_STALE', 'FALLBACK_POLICY_INVALID', 'FALLBACK_EXHAUSTED', 'FALLBACK_BLOCKED', 'CHECKPOINT_INVALID', 'EFFECTS_UNVERIFIED',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** Asynchronous execution reasons recorded in task/events, never returned as a tool error. */
export const EXECUTION_REASONS = [
  'OUTPUT_LIMIT_EXCEEDED', 'EVENT_LIMIT_EXCEEDED', 'RUN_TIMEOUT', 'IDLE_TIMEOUT', 'PERMISSION_TIMEOUT',
  'QUIESCENT_TIMEOUT', 'BACKEND_FAILED', 'DELIVERY_UNKNOWN', 'CLEANUP_UNKNOWN', 'AUTHORIZATION_EXPIRED',
  'AUTHORIZATION_DENIED', 'PREPARED_EXPIRED', 'WORKDIR_CHANGED', 'FALLBACK_EXHAUSTED', 'FALLBACK_BLOCKED',
  'CANCELLED', 'CLOSED_BY_CLIENT', 'RECOVERY_UNRESOLVED', 'OPERATOR_RELEASED',
] as const
export type ExecutionReason = (typeof EXECUTION_REASONS)[number]

export type SideEffects = 'none' | 'accepted' | 'unknown'

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'OPERATION_IN_PROGRESS', 'CAPACITY_EXHAUSTED', 'BACKEND_UNAVAILABLE', 'SERVICE_UNAVAILABLE',
  'STORAGE_UNAVAILABLE', 'RECOVERY_IN_PROGRESS', 'RESULT_NOT_READY',
])

export interface DomainErrorBody {
  code: ErrorCode
  message: string
  retryable: boolean
  sideEffects: SideEffects
  details: Record<string, unknown>
}

export class DomainError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly sideEffects: SideEffects
  readonly details: Record<string, unknown>

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}, opts: { retryable?: boolean; sideEffects?: SideEffects } = {}) {
    super(message)
    this.code = code
    this.retryable = opts.retryable ?? RETRYABLE.has(code)
    this.sideEffects = opts.sideEffects ?? 'none'
    this.details = details
  }

  toBody(): DomainErrorBody {
    return { code: this.code, message: this.message, retryable: this.retryable, sideEffects: this.sideEffects, details: this.details }
  }
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError
}

/** Wrap anything unexpected as INTERNAL_ERROR without leaking stack traces or secrets. */
export function toDomainError(e: unknown): DomainError {
  if (isDomainError(e)) return e
  return new DomainError('INTERNAL_ERROR', 'Internal error in the task service.', {}, { retryable: false, sideEffects: 'unknown' })
}
