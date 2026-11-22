/**
 * Task phase machine (design doc §8.3). Pure: callers build a new record with
 * the next phase; this module only says whether the move is legal.
 */

export const PHASES = [
  'PREPARED', 'STARTING', 'ACTIVE', 'WAITING_PERMISSION', 'WAITING_INPUT', 'QUIESCENT',
  'FALLBACK_PENDING', 'WAITING_AUTHORIZATION', 'WAITING_RETRY', 'FINALIZING', 'CLOSED', 'UNKNOWN',
] as const
export type Phase = (typeof PHASES)[number]

const TRANSITIONS: Record<Phase, readonly Phase[]> = {
  PREPARED: ['STARTING', 'FINALIZING', 'CLOSED'],
  STARTING: ['ACTIVE', 'WAITING_PERMISSION', 'WAITING_INPUT', 'QUIESCENT', 'FALLBACK_PENDING', 'WAITING_AUTHORIZATION', 'FINALIZING', 'UNKNOWN'],
  ACTIVE: ['WAITING_PERMISSION', 'WAITING_INPUT', 'QUIESCENT', 'FALLBACK_PENDING', 'FINALIZING', 'UNKNOWN'],
  WAITING_PERMISSION: ['ACTIVE', 'WAITING_INPUT', 'QUIESCENT', 'FALLBACK_PENDING', 'FINALIZING', 'UNKNOWN'],
  WAITING_INPUT: ['ACTIVE', 'QUIESCENT', 'FALLBACK_PENDING', 'FINALIZING', 'UNKNOWN'],
  QUIESCENT: ['FINALIZING'],
  FALLBACK_PENDING: ['WAITING_AUTHORIZATION', 'WAITING_RETRY', 'STARTING', 'FINALIZING', 'UNKNOWN'],
  WAITING_AUTHORIZATION: ['STARTING', 'FINALIZING', 'UNKNOWN'],
  WAITING_RETRY: ['STARTING', 'WAITING_AUTHORIZATION', 'FINALIZING', 'UNKNOWN'],
  FINALIZING: ['CLOSED', 'UNKNOWN'],
  UNKNOWN: ['FINALIZING', 'ACTIVE', 'QUIESCENT', 'FALLBACK_PENDING', 'WAITING_AUTHORIZATION'],
  CLOSED: [],
}

export class InvalidPhaseTransition extends Error {}

export function canTransition(from: Phase, to: Phase): boolean {
  return from === to || TRANSITIONS[from].includes(to)
}

export function assertTransition(from: Phase, to: Phase): void {
  if (!canTransition(from, to)) throw new InvalidPhaseTransition(`cannot move task from ${from} to ${to}`)
}

/** Phases in which an execution owner may be live (an attempt is in flight). */
export const OWNER_PHASES: ReadonlySet<Phase> = new Set<Phase>(['STARTING', 'ACTIVE', 'WAITING_PERMISSION', 'WAITING_INPUT', 'QUIESCENT', 'FINALIZING'])

/** Phases that count against the optional concurrency caps. */
export const RUNNING_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'STARTING', 'ACTIVE', 'WAITING_PERMISSION', 'WAITING_INPUT', 'QUIESCENT',
  'FALLBACK_PENDING', 'WAITING_AUTHORIZATION', 'WAITING_RETRY', 'FINALIZING', 'UNKNOWN',
])

export function isTerminal(phase: Phase): boolean {
  return phase === 'CLOSED'
}
