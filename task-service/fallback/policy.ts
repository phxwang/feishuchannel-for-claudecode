/** Frozen policy validation (design doc §12.1, spec §12.1). Pure. */
import type { BackendCapabilities } from '../backends/backend'
import { DomainError } from '../errors'
import { jcsSha256 } from '../jcs'
import type { FallbackPolicy, TaskPolicy, TriggerCode, TriggerRule, TriggerStage } from '../schema/policy'
import { sameCandidate, type Candidate } from '../schema/primitives'

/** Which stages each trigger code may be enabled for (spec §12.2). run_timeout is never allowed. */
export const ALLOWED_STAGES: Record<TriggerCode, readonly TriggerStage[]> = {
  backend_unavailable: ['before_delivery'],
  capability_unavailable: ['before_delivery'],
  authentication_invalid: ['before_delivery', 'clean_failure'],
  startup_failed: ['before_delivery'],
  rate_limited: ['before_delivery', 'clean_failure', 'checkpoint_handoff'],
  quota_exhausted: ['before_delivery', 'clean_failure', 'checkpoint_handoff'],
  provider_unavailable: ['before_delivery'],
  model_unavailable: ['before_delivery', 'clean_failure', 'checkpoint_handoff'],
  context_exhausted: ['before_delivery', 'clean_failure', 'checkpoint_handoff'],
  execution_failed: ['clean_failure', 'checkpoint_handoff'],
  idle_timeout: ['clean_failure', 'checkpoint_handoff'],
  run_timeout: [],
}

const invalid = (message: string, details: Record<string, unknown> = {}) => new DomainError('FALLBACK_POLICY_INVALID', message, details)
const unsupported = (message: string, details: Record<string, unknown> = {}) => new DomainError('UNSUPPORTED_CAPABILITY', message, details)

export function fallbackPlanSha256(fallback: FallbackPolicy): string {
  return jcsSha256(fallback)
}

/** Forward edges (from → to) a rule permits, honouring optional index filters. */
export function ruleEdges(rule: TriggerRule, candidateCount: number): { from: number; to: number }[] {
  const edges: { from: number; to: number }[] = []
  for (let from = 0; from < candidateCount; from++) {
    if (rule.fromCandidateIndexes && !rule.fromCandidateIndexes.includes(from)) continue
    for (let to = from + 1; to < candidateCount; to++) {
      if (rule.toCandidateIndexes && !rule.toCandidateIndexes.includes(to)) continue
      edges.push({ from, to })
    }
  }
  return edges
}

function validateShape(f: FallbackPolicy, backend: Candidate): void {
  if (!sameCandidate(f.candidates[0], backend)) throw invalid('fallback.candidates[0] must equal backend.')
  for (let i = 0; i < f.candidates.length; i++) {
    for (let j = i + 1; j < f.candidates.length; j++) {
      if (sameCandidate(f.candidates[i], f.candidates[j])) throw invalid('fallback.candidates must not repeat a tuple.', { index: j })
    }
  }
  const r = f.sameOwnerReset
  if (r.enabled ? (r.maxWaitSeconds < 1 || r.maxResumeActions !== 1) : (r.maxWaitSeconds !== 0 || r.maxResumeActions !== 0)) {
    throw invalid('sameOwnerReset limits do not match its enabled flag.')
  }
  if (!f.enabled) {
    if (f.candidates.length !== 1 || f.triggerOn.length || f.maxSwitches || f.startupRetriesPerCandidate || r.enabled) {
      throw invalid('A disabled fallback policy must list only the primary, no triggers and zero limits.')
    }
    return
  }
  if (f.maxSwitches > f.candidates.length - 1) throw invalid('maxSwitches exceeds candidates.length - 1.')
  if (r.enabled && r.maxWaitSeconds > f.maxRecoverySeconds) throw invalid('sameOwnerReset.maxWaitSeconds exceeds maxRecoverySeconds.')
  const seen = new Set<string>()
  for (const rule of f.triggerOn) {
    if (!ALLOWED_STAGES[rule.code].includes(rule.stage)) throw invalid(`Trigger ${rule.code} is not allowed at stage ${rule.stage}.`, { code: rule.code, stage: rule.stage })
    for (const idx of [...(rule.fromCandidateIndexes ?? []), ...(rule.toCandidateIndexes ?? [])]) {
      if (idx >= f.candidates.length) throw invalid('Trigger candidate index out of range.', { index: idx })
    }
    const key = JSON.stringify([rule.code, rule.stage, rule.fromCandidateIndexes ?? null, rule.toCandidateIndexes ?? null])
    if (seen.has(key)) throw invalid('Duplicate trigger rule.', { code: rule.code, stage: rule.stage })
    seen.add(key)
    if (!ruleEdges(rule, f.candidates.length).length) throw invalid('Trigger rule permits no forward edge.', { code: rule.code })
  }
}

function validateCapabilities(policy: TaskPolicy, inputKind: 'text' | 'native_goal', caps: (BackendCapabilities | undefined)[]): void {
  const f = policy.fallback
  caps.forEach((c, i) => {
    if (!c || c.availabilityReason === 'not_implemented') throw unsupported('Candidate backend/mode is not implemented.', { candidateIndex: i })
    if (!c.permissionModes.includes(policy.permissionMode)) {
      throw unsupported(`Candidate does not support permissionMode ${policy.permissionMode}.`, { candidateIndex: i })
    }
    if (inputKind === 'native_goal' && !c.fallback.nativeGoal) throw unsupported('Candidate does not support native_goal input.', { candidateIndex: i })
    if (policy.inputMode === 'same_primary' && !c.features.samePrimaryTurns) throw unsupported('Candidate does not support same_primary input.', { candidateIndex: i })
    if (f.sameOwnerReset.enabled && !c.fallback.sameOwnerResetRecovery) throw unsupported('Candidate does not support same-owner reset recovery.', { candidateIndex: i })
  })
  for (const rule of f.triggerOn) {
    for (const { from, to } of ruleEdges(rule, f.candidates.length)) {
      const src = caps[from]!
      if (!src.fallback.supportedFallbackTriggers.some(t => t.code === rule.code && t.stage === rule.stage)) {
        throw unsupported(`Candidate ${from} cannot detect ${rule.code} at ${rule.stage}.`, { candidateIndex: from, code: rule.code, stage: rule.stage })
      }
      if (rule.stage === 'clean_failure' && !src.fallback.cleanFailureFallback) throw unsupported('Clean-failure fallback is not supported by the source candidate.', { candidateIndex: from })
      if (rule.stage === 'checkpoint_handoff' && !(src.fallback.checkpointHandoff && caps[to]!.fallback.checkpointHandoff)) {
        throw unsupported('Checkpoint handoff is not supported on this edge.', { from, to })
      }
    }
  }
}

export function validateTaskPolicy(policy: TaskPolicy, backend: Candidate, inputKind: 'text' | 'native_goal', caps: (BackendCapabilities | undefined)[]): void {
  validateShape(policy.fallback, backend)
  validateCapabilities(policy, inputKind, caps)
}
