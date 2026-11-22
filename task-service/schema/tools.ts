/** Per-tool argument schemas (strict; unknown fields are INVALID_REQUEST). Design doc §9, spec §5. */
import { z } from 'zod'
import { taskPolicySchema } from './policy'
import {
  candidateSchema, idempotencyKey, identifier, nonNegInt, ownerRefSchema, reason, requestId, sha256, tagMap, utf8Bytes,
} from './primitives'

export const LIMITS = {
  requestBytes: 1048576,
  promptBytes: 262144,
  eventBytes: 65536,
  eventPageBytes: 262144,
  textChunkBytes: 65536,
  startAuthorizationMaxSeconds: 60,
  eventRetentionDays: 7,
  resultRetentionDays: 30,
  maxTurnTextBytes: 16 * 1024 * 1024,
  inlineFinalTextBytes: 16 * 1024,
  maxSummariesPerPage: 32,
  preparedTtlSeconds: 600,
  transitionRequestMaxSeconds: 300,
  goalCapsuleMaxBytes: 900,
} as const

const tracing = { requestId: requestId.optional() }
const timestamp = z.string().min(20).max(40)

export const authorizationSchema = z.object({
  revision: identifier,
  expiresAt: timestamp,
  promptSha256: sha256,
  contractSha256: sha256,
  fallbackPlanSha256: sha256,
}).strict()
export type Authorization = z.infer<typeof authorizationSchema>

export const transitionAuthorizationSchema = authorizationSchema.extend({ transitionSha256: sha256 }).strict()
export type TransitionAuthorization = z.infer<typeof transitionAuthorizationSchema>

const prompt = z.string().refine(s => utf8Bytes(s) >= 1 && utf8Bytes(s) <= LIMITS.promptBytes, {
  message: `prompt must be 1-${LIMITS.promptBytes} UTF-8 bytes`,
})

export const assignmentSchema = z.object({
  inputKind: z.enum(['text', 'native_goal']),
  prompt,
  contractSha256: sha256,
  metadata: tagMap(128).optional(),
}).strict()

export const healthArgs = z.object({ ...tracing }).strict()
export const capabilitiesArgs = z.object({ ...tracing }).strict()

export const prepareArgs = z.object({
  ...tracing,
  idempotencyKey,
  clientId: identifier,
  clientTaskId: identifier,
  scopeKey: identifier,
  correlation: tagMap(256).optional(),
  projectId: identifier.nullable(),
  workdir: z.string().min(1).max(4096),
  backend: candidateSchema,
  assignment: assignmentSchema,
  policy: taskPolicySchema,
}).strict()
export type PrepareArgs = z.infer<typeof prepareArgs>

export const getArgs = z.object({ ...tracing, taskId: identifier }).strict()
export const lookupArgs = z.object({ ...tracing, clientId: identifier, clientTaskId: identifier }).strict()

export const startArgs = z.object({
  ...tracing,
  taskId: identifier,
  idempotencyKey,
  expectedControlVersion: nonNegInt,
  authorization: authorizationSchema,
}).strict()

export const eventsReadArgs = z.object({
  ...tracing,
  taskId: identifier,
  afterSeq: nonNegInt,
  limit: z.number().int().min(1).max(100).optional(),
  waitSeconds: z.number().int().min(0).max(20).optional(),
}).strict()

export const resultArgs = z.object({
  ...tracing,
  taskId: identifier,
  afterTurnId: identifier.optional(),
  afterExecutionAttemptId: identifier.optional(),
}).strict()

export const turnTextReadArgs = z.object({
  ...tracing,
  taskId: identifier,
  turnId: identifier,
  offsetBytes: nonNegInt,
  maxBytes: z.number().int().min(1).max(65536).optional(),
}).strict()

const control = {
  ...tracing,
  taskId: identifier,
  idempotencyKey,
  expectedControlVersion: nonNegInt,
  expectedOwner: ownerRefSchema.nullable(),
}

export const permissionReplyArgs = z.object({
  ...control,
  turnId: identifier,
  permissionRequestId: identifier,
  optionId: identifier,
  authorizationRevision: identifier,
}).strict()

export const sealArgs = z.object({ ...control, reason }).strict()
export const closeArgs = z.object({ ...control, reason }).strict()
export const cancelArgs = z.object({ ...control, reason, graceSeconds: z.number().int().min(1).max(30) }).strict()

export const addTurnArgs = z.object({
  ...control,
  clientTurnId: identifier,
  prompt,
  authorization: authorizationSchema,
}).strict()

export const authorizeArgs = z.object({
  ...control,
  transitionRequestId: identifier,
  decision: z.enum(['allow', 'deny']),
  authorization: transitionAuthorizationSchema.nullable(),
}).strict()

export const TOOL_ARGS = {
  router_health: healthArgs,
  router_capabilities: capabilitiesArgs,
  router_task_prepare: prepareArgs,
  router_task_get: getArgs,
  router_task_lookup: lookupArgs,
  router_task_start: startArgs,
  router_events_read: eventsReadArgs,
  router_task_result: resultArgs,
  router_turn_text_read: turnTextReadArgs,
  router_permission_reply: permissionReplyArgs,
  router_task_seal: sealArgs,
  router_task_close: closeArgs,
  router_task_cancel: cancelArgs,
  router_task_add_turn: addTurnArgs,
  router_task_authorize: authorizeArgs,
} as const

export type ToolName = keyof typeof TOOL_ARGS
export const TOOL_NAMES = Object.keys(TOOL_ARGS) as ToolName[]

export const MUTATION_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'router_task_prepare', 'router_task_start', 'router_permission_reply', 'router_task_seal',
  'router_task_close', 'router_task_cancel', 'router_task_add_turn', 'router_task_authorize',
])
