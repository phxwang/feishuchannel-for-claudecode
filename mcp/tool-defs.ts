/**
 * Published MCP tool definitions (design doc §7.2, §7.5): one zod source per
 * schema, converted to JSON Schema for tools/list and for the committed
 * `schemas/` files. Input schemas are the service's strict argument schemas.
 */
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { ERROR_CODES } from '../task-service/errors'
import { TOOL_ARGS, type ToolName } from '../task-service/schema/tools'

const obj = z.object({}).passthrough()
const nullableStr = z.string().nullable()

export const ownerSchema = z.object({
  state: z.enum(['none', 'starting', 'live', 'released', 'unknown']),
  executionId: nullableStr, generation: z.number().int(), backendSessionId: nullableStr,
  pid: z.number().int().nullable(), processStartIdentity: nullableStr,
}).passthrough()

export const snapshotSchema = z.object({
  taskId: z.string(), clientId: z.string(), clientTaskId: z.string(), scopeKey: z.string(), correlation: z.record(z.string()),
  projectId: nullableStr, workdirSource: z.enum(['project', 'dynamic']), workdir: z.string(), backend: obj, policy: obj,
  assignment: obj, phase: z.string(), controlVersion: z.number().int(), sealed: z.boolean(), owner: ownerSchema,
  currentTurn: obj.nullable(), executionOutcome: nullableStr, lastSeq: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
  fallbackPlanSha256: z.string(), selectedCandidateIndex: z.number().int(), actualBackend: obj.nullable(),
  currentExecutionAttemptId: nullableStr, executionAttemptCount: z.number().int(), fallbackState: z.string(), pendingAuthorization: obj.nullable(),
}).passthrough()

const taskData = z.object({ task: snapshotSchema }).passthrough()
const acceptedData = z.object({ accepted: z.literal(true), task: snapshotSchema }).passthrough()
const withResources = z.object({ task: snapshotSchema, resources: z.object({ snapshotUri: z.string(), resultUri: z.string() }) }).passthrough()

const eventSchema = z.object({
  taskId: z.string(), seq: z.number().int(), type: z.string(), at: z.string(),
  executionId: nullableStr, turnId: nullableStr, executionAttemptId: nullableStr, candidateIndex: z.number().int().nullable(), data: obj,
}).passthrough()

export const DATA_SCHEMAS: Record<ToolName, z.ZodTypeAny> = {
  router_health: z.object({ status: z.literal('ok'), routerInstanceId: z.string(), routerContractVersion: z.string(), recoveryInProgress: z.boolean() }).passthrough(),
  router_capabilities: z.object({ routerContractVersion: z.string(), routerInstanceId: z.string(), backends: z.array(obj), limits: obj }).passthrough(),
  router_task_prepare: withResources,
  router_task_get: withResources,
  router_task_lookup: withResources,
  router_task_start: acceptedData,
  router_events_read: z.object({
    taskId: z.string(), events: z.array(eventSchema), nextAfterSeq: z.number().int(), hasMore: z.boolean(),
    lastSeq: z.number().int(), minAvailableSeq: z.number().int(), taskPhase: z.string(),
  }).passthrough(),
  router_task_result: z.object({
    taskId: z.string(), phase: z.string(), controlVersion: z.number().int(), final: z.boolean(), executionOutcome: nullableStr,
    turns: z.array(obj), evidence: obj, cleanup: obj, businessAcceptance: z.literal('not_evaluated'), lastSeq: z.number().int(),
    executionAttempts: z.array(obj),
  }).passthrough(),
  router_turn_text_read: z.object({
    taskId: z.string(), turnId: z.string(), text: z.string(), offsetBytes: z.number().int(), nextOffsetBytes: z.number().int(),
    totalBytes: z.number().int(), sha256: z.string(), eof: z.boolean(),
  }).passthrough(),
  router_permission_reply: acceptedData,
  router_task_seal: taskData,
  router_task_close: acceptedData,
  router_task_cancel: acceptedData,
  router_task_add_turn: acceptedData,
  router_task_authorize: acceptedData,
}

export const errorBodySchema = z.object({
  code: z.enum(ERROR_CODES), message: z.string(), retryable: z.boolean(),
  sideEffects: z.enum(['none', 'accepted', 'unknown']), details: obj,
}).strict()

export function envelopeSchema(tool: ToolName) {
  const common = { routerContractVersion: z.string(), requestId: z.string(), replayed: z.boolean() }
  return z.discriminatedUnion('ok', [
    z.object({ ...common, ok: z.literal(true), data: DATA_SCHEMAS[tool], error: z.null() }).strict(),
    z.object({ ...common, ok: z.literal(false), data: z.null(), error: errorBodySchema }).strict(),
  ])
}

const DESCRIPTIONS: Record<ToolName, string> = {
  router_health: 'Report whether the task store is readable/writable and the service reachable. Says nothing about backend availability.',
  router_capabilities: 'List backends/modes with availability, features, permission modes, fallback triggers, and service limits.',
  router_task_prepare: 'Create a PREPARED task with a frozen assignment and policy. Never creates a backend session or sends input.',
  router_task_get: 'Read the current TaskSnapshot.',
  router_task_lookup: 'Find a task by clientId + clientTaskId (recovery path when a prepare reply was lost).',
  router_task_start: 'Start a PREPARED task under a short-lived authorization. Accepted means durable intent, not backend success.',
  router_events_read: 'Read committed task events after a cursor; optional long poll up to 20 s. Never consumes or changes the task.',
  router_task_result: 'Read the current result: turns, attempts, evidence and cleanup. businessAcceptance is always not_evaluated.',
  router_turn_text_read: 'Read a turn\'s immutable final text by UTF-8 byte offsets.',
  router_permission_reply: 'Answer one pending permission request for the exact task, turn and owner (allow_once or deny_once).',
  router_task_seal: 'Forbid any further input or dispatch for this task. Does not interrupt an accepted turn.',
  router_task_close: 'Close a QUIESCENT task: release only its exact owner, without sending any prompt.',
  router_task_cancel: 'Record cancellation intent, interrupt the exact owner and finalize. Accepted is not completion; wait for CLOSED.',
  router_task_add_turn: 'Future capability (same-primary multi-turn). Returns UNSUPPORTED_CAPABILITY in this version.',
  router_task_authorize: 'Allow or deny the pending fallback transition request with a fresh grant. Does not select a backend.',
}

const READ_ONLY = new Set<ToolName>(['router_health', 'router_capabilities', 'router_task_get', 'router_task_lookup', 'router_events_read', 'router_task_result', 'router_turn_text_read'])

function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const js = zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' }) as Record<string, unknown>
  delete js.$schema
  return js
}

export interface PublishedTool {
  name: ToolName
  title: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
}

/** MCP requires outputSchema to be an object schema: wrap the discriminated union under type: object. */
function outputSchemaFor(tool: ToolName): Record<string, unknown> {
  const union = jsonSchema(envelopeSchema(tool))
  return { type: 'object', ...union }
}

export function publishedTools(): PublishedTool[] {
  return (Object.keys(TOOL_ARGS) as ToolName[]).map(name => {
    const readOnly = READ_ONLY.has(name)
    return {
      name,
      title: name.replace(/^router_/, '').replace(/_/g, ' '),
      description: DESCRIPTIONS[name],
      inputSchema: { type: 'object', ...jsonSchema(TOOL_ARGS[name]) },
      outputSchema: outputSchemaFor(name),
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: !readOnly },
    }
  })
}

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY.has(name as ToolName)
}

export const EVENT_SCHEMA = eventSchema
export const SNAPSHOT_SCHEMA = snapshotSchema
export { jsonSchema }
