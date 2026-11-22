/**
 * Pure fallback decision (design doc §12.3). The runner persists the result
 * and performs effects; nothing here touches storage or backends.
 */
import type { FallbackPolicy, TriggerCode, TriggerStage } from '../schema/policy'
import { ruleEdges } from './policy'

export interface ClassifiedFailure {
  /** null = not a classifiable infrastructure trigger (e.g. a completed-but-failed answer, cancellation). */
  code: TriggerCode | null
  stage: TriggerStage | null
  /** Delivery/ownership/cleanup could not be proven. Never eligible. */
  uncertain: boolean
  /** Owner and all owned work are verified settled. */
  ownerSettled: boolean
  effectStatus: 'none' | 'partial' | 'unknown'
  detail: string
}

export interface DecideInput {
  fallback: FallbackPolicy
  currentIndex: number
  currentIsStartupRetry: boolean
  switchesUsed: number
  sealed: boolean
  recoveryRemainingMs: number
  runRemainingMs: number
  failure: ClassifiedFailure
}

export type Decision =
  | { kind: 'terminate'; reason: 'not_eligible' | 'fallback_disabled' | 'sealed' | 'never_trigger' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'blocked'; reason: string; toIndex: number }
  | { kind: 'exhausted'; reason: 'max_switches' | 'budget' | 'no_candidate' }
  | { kind: 'retry_same'; delayMs: number }
  | { kind: 'switch'; toIndex: number; delayMs: number; needsFreshGrant: boolean; stage: TriggerStage }

export function decide(input: DecideInput): Decision {
  const { fallback: f, failure } = input
  if (input.sealed) return { kind: 'terminate', reason: 'sealed' }
  if (failure.uncertain) return { kind: 'unknown', reason: failure.detail }
  if (!failure.code || !failure.stage) return { kind: 'terminate', reason: 'never_trigger' }
  if (!f.enabled) return { kind: 'terminate', reason: 'fallback_disabled' }

  const delayMs = f.retryDelaySeconds * 1000
  const budgetOk = input.recoveryRemainingMs > delayMs && input.runRemainingMs > delayMs

  const rules = f.triggerOn.filter(r => r.code === failure.code && r.stage === failure.stage)
  if (!rules.length) return { kind: 'terminate', reason: 'not_eligible' }

  if (failure.code === 'startup_failed' && failure.stage === 'before_delivery'
    && !input.currentIsStartupRetry && f.startupRetriesPerCandidate > 0) {
    if (!failure.ownerSettled) return { kind: 'unknown', reason: 'startup owner not settled' }
    return budgetOk ? { kind: 'retry_same', delayMs } : { kind: 'exhausted', reason: 'budget' }
  }

  const targets = new Set<number>()
  for (const r of rules) {
    for (const e of ruleEdges(r, f.candidates.length)) if (e.from === input.currentIndex) targets.add(e.to)
  }
  const next = [...targets].sort((a, b) => a - b)[0]
  if (next === undefined) return { kind: 'exhausted', reason: 'no_candidate' }
  if (input.switchesUsed >= f.maxSwitches) return { kind: 'exhausted', reason: 'max_switches' }
  if (!budgetOk) return { kind: 'exhausted', reason: 'budget' }

  if (!failure.ownerSettled) return { kind: 'blocked', reason: 'previous owner not verified released', toIndex: next }
  if (failure.stage === 'clean_failure' && failure.effectStatus !== 'none') {
    return { kind: 'blocked', reason: 'side effects not proven absent', toIndex: next }
  }
  if (failure.stage === 'checkpoint_handoff' && failure.effectStatus === 'unknown') {
    return { kind: 'blocked', reason: 'effects manifest unknown', toIndex: next }
  }
  return { kind: 'switch', toIndex: next, delayMs, needsFreshGrant: failure.stage !== 'before_delivery', stage: failure.stage }
}
