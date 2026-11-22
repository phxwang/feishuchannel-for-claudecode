/** Prepare-time policy schema (spec §5.3, §12.1). Structural only; cross-field rules live in fallback/policy.ts. */
import { z } from 'zod'
import { candidateSchema } from './primitives'

export const TRIGGER_CODES = [
  'backend_unavailable', 'capability_unavailable', 'authentication_invalid', 'startup_failed',
  'rate_limited', 'quota_exhausted', 'provider_unavailable', 'model_unavailable', 'context_exhausted',
  'execution_failed', 'idle_timeout', 'run_timeout',
] as const
export type TriggerCode = (typeof TRIGGER_CODES)[number]

export const TRIGGER_STAGES = ['before_delivery', 'clean_failure', 'checkpoint_handoff'] as const
export type TriggerStage = (typeof TRIGGER_STAGES)[number]

const indexList = z.array(z.number().int().min(0).max(7)).min(1).max(8)
  .refine(a => new Set(a).size === a.length, { message: 'indexes must be unique' })

export const triggerRuleSchema = z.object({
  code: z.enum(TRIGGER_CODES),
  stage: z.enum(TRIGGER_STAGES),
  fromCandidateIndexes: indexList.optional(),
  toCandidateIndexes: indexList.optional(),
}).strict()
export type TriggerRule = z.infer<typeof triggerRuleSchema>

export const fallbackPolicySchema = z.object({
  enabled: z.boolean(),
  candidates: z.array(candidateSchema).min(1).max(8),
  triggerOn: z.array(triggerRuleSchema).max(64),
  maxSwitches: z.number().int().min(0).max(7),
  startupRetriesPerCandidate: z.number().int().min(0).max(1),
  retryDelaySeconds: z.number().int().min(0).max(60),
  maxRecoverySeconds: z.number().int().min(1).max(43200),
  onExhausted: z.literal('fail'),
  sameOwnerReset: z.object({
    enabled: z.boolean(),
    maxWaitSeconds: z.number().int().min(0).max(43200),
    maxResumeActions: z.number().int().min(0).max(1),
  }).strict(),
}).strict()
export type FallbackPolicy = z.infer<typeof fallbackPolicySchema>

export const PERMISSION_MODES = ['broker', 'backend_policy'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

export const taskPolicySchema = z.object({
  inputMode: z.enum(['single_turn', 'same_primary']),
  fallback: fallbackPolicySchema,
  permissionMode: z.enum(PERMISSION_MODES),
  runTimeoutSeconds: z.number().int().min(10).max(43200),
  idleTimeoutSeconds: z.number().int().min(10).max(3600),
  permissionTimeoutSeconds: z.number().int().min(30).max(7200),
  quiescentTimeoutSeconds: z.number().int().min(60).max(86400),
}).strict()
export type TaskPolicy = z.infer<typeof taskPolicySchema>
