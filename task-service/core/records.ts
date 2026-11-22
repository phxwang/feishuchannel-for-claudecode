/** Pure builders for new/updated records. No I/O. */
import { newId } from '../ids'
import type { AttemptRecord, ExecutionOutcome, Owner, TaskRecord, TurnRecord } from '../model'
import type { Candidate } from '../schema/primitives'

export const NO_OWNER: Owner = { state: 'none', executionId: null, generation: 0, backendSessionId: null, pid: null, processStartIdentity: null }

export function newAttempt(task: TaskRecord, candidateIndex: number, opts: {
  ordinal: number; generation: number; inputSha256: string; triggerCode: string | null; evidenceDigest: string | null; isStartupRetry: boolean; now: number
}): AttemptRecord {
  const backend: Candidate = task.policy.fallback.candidates[candidateIndex]
  return {
    executionAttemptId: newId('xatt'),
    taskId: task.taskId,
    ordinal: opts.ordinal,
    candidateIndex,
    backend,
    executionId: newId('exec'),
    generation: opts.generation,
    triggerCode: opts.triggerCode,
    evidenceDigest: opts.evidenceDigest,
    inputSha256: opts.inputSha256,
    isStartupRetry: opts.isStartupRetry,
    delivery: 'not_sent',
    effectStatus: 'none',
    state: 'planned',
    outcome: null,
    failure: null,
    blockedReason: null,
    owner: { backendSessionId: null, pid: null, pgid: null, processStartIdentity: null, extra: {} },
    ownerReleased: null,
    startedAtMs: opts.now,
    endedAtMs: null,
  }
}

export function newTurn(task: TaskRecord, attempt: AttemptRecord, backendTurnId: string): TurnRecord {
  return {
    turnId: newId('turn'),
    taskId: task.taskId,
    executionAttemptId: attempt.executionAttemptId,
    candidateIndex: attempt.candidateIndex,
    backendTurnId,
    state: 'pending',
    delivery: 'not_sent',
    outcome: null,
    startedAtMs: null,
    endedAtMs: null,
    finalTextSha256: null,
    finalTextBytes: null,
    finalTextComplete: false,
    protocol: { backendFinished: null, activeToolCount: null, stopReason: null },
    process: { exitCode: null, signal: null, controlledShutdown: null },
    evidence: { backendSessionId: null, backendTurnId, transcriptPath: null },
  }
}

export function ownerFor(attempt: AttemptRecord, state: Owner['state']): Owner {
  return {
    state,
    executionId: attempt.executionId,
    generation: attempt.generation,
    backendSessionId: attempt.owner.backendSessionId,
    pid: attempt.owner.pid,
    processStartIdentity: attempt.owner.processStartIdentity,
  }
}

/**
 * Final task outcome (spec §12.4 step 6): the selected final attempt's turn
 * outcome; never `not_started` if any attempt's input was accepted.
 */
export function finalOutcome(attempts: AttemptRecord[], turns: TurnRecord[], cancelled: boolean): ExecutionOutcome {
  const delivered = (a: AttemptRecord) => a.delivery === 'accepted' || a.delivery === 'unknown' || a.delivery === 'in_flight'
  const lastAttempt = attempts[attempts.length - 1]
  const lastTurn = lastAttempt ? turns.find(t => t.executionAttemptId === lastAttempt.executionAttemptId) : undefined
  if (lastTurn?.state === 'ended' && lastTurn.outcome) return lastTurn.outcome
  if (lastAttempt && delivered(lastAttempt)) return cancelled ? 'cancelled' : 'failed'
  // The latest candidate never received input: report the last accepted attempt, if any.
  const latestEnded = [...turns].reverse().find(t => t.state === 'ended' && t.outcome)
  if (latestEnded?.outcome) return latestEnded.outcome
  return attempts.some(delivered) ? (cancelled ? 'cancelled' : 'failed') : 'not_started'
}
