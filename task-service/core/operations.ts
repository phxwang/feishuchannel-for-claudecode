/**
 * Idempotent mutation pipeline (design doc §9.1, spec §4.2).
 *
 * The operation row, the state transition and its events commit in ONE outer
 * IMMEDIATE transaction (the handler's own commits nest as savepoints).
 * Backend side effects run only after that commit, via the returned `after`.
 */
import { DomainError, toDomainError } from '../errors'
import { newId } from '../ids'
import { operationFingerprint } from '../jcs'
import type { TaskStore } from '../store/task-store'
import type { Clock } from '../time'
import { errorEnvelope, okEnvelope, replayEnvelope, type Envelope } from './envelope'

const NOT_RECORDED: ReadonlySet<string> = new Set([
  'INTERNAL_ERROR', 'STORAGE_UNAVAILABLE', 'VERSION_CONFLICT', 'OWNER_MISMATCH', 'TASK_NOT_QUIESCENT',
  'TASK_BUSY', 'PERMISSION_STALE', 'AUTHORIZATION_STALE', 'SCOPE_BUSY', 'OWNER_UNVERIFIED',
])

export interface MutationOutcome {
  data: Record<string, unknown>
  /** Post-commit work (e.g. kick the engine). Never runs if the transaction rolled back. */
  after?: () => void
}

export interface OperationTarget {
  clientId: string
  target: string
}

export class OperationRunner {
  constructor(private store: TaskStore, private clock: Clock) {}

  run(
    tool: string,
    args: Record<string, unknown> & { idempotencyKey: string },
    requestId: string,
    resolveTarget: () => OperationTarget,
    handler: () => MutationOutcome,
  ): Envelope {
    let target: OperationTarget
    try { target = resolveTarget() } catch (e) { return errorEnvelope(requestId, toDomainError(e)) }
    const fingerprint = operationFingerprint(args)

    const prior = this.safeGet(target, tool, args.idempotencyKey)
    if (prior instanceof DomainError) return errorEnvelope(requestId, prior)
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        return errorEnvelope(requestId, new DomainError('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with different arguments.', { tool }))
      }
      if (prior.state === 'pending' || !prior.envelope) {
        return errorEnvelope(requestId, new DomainError('OPERATION_IN_PROGRESS', 'The original operation is still being processed.', { retryAfterMs: 500 }))
      }
      return replayEnvelope(JSON.parse(prior.envelope) as Envelope, requestId)
    }

    let after: (() => void) | undefined
    let envelope: Envelope
    try {
      envelope = this.store.tx(() => {
        let env: Envelope
        try {
          // Nested so a failing handler rolls back only its own writes, keeping the decision recordable.
          const outcome = this.store.tx(handler)
          after = outcome.after
          env = okEnvelope(requestId, outcome.data)
        } catch (e) {
          const err = toDomainError(e)
          // Retryable and state-dependent rejections are not recorded: retrying the same key
          // after the task has moved on must re-evaluate, not replay a stale rejection.
          if (err.retryable || NOT_RECORDED.has(err.code)) throw err
          env = errorEnvelope(requestId, err)
        }
        this.store.putOperation({
          clientId: target.clientId, tool, target: target.target, idempotencyKey: args.idempotencyKey,
          fingerprint, state: 'completed', operationId: newId('op'), envelope: JSON.stringify(env), createdAt: this.clock.now(),
        })
        return env
      })
    } catch (e) {
      return errorEnvelope(requestId, toDomainError(e))
    }
    if (envelope.ok && after) {
      try { after() } catch { /* post-commit work reports through the task ledger */ }
    }
    return envelope
  }

  private safeGet(target: OperationTarget, tool: string, key: string) {
    try { return this.store.getOperation(target.clientId, tool, target.target, key) } catch {
      return new DomainError('STORAGE_UNAVAILABLE', 'The task store is unavailable.')
    }
  }
}
