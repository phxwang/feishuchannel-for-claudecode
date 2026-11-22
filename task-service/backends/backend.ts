/**
 * Task-scoped backend contract (design doc §11.1). Narrower than the chat
 * AgentAdapter: turn identity is caller-visible and persisted before input is
 * sent, observation is re-attachable, and backends own no time limits.
 */
import type { TurnOutcome, WorkdirIdentity } from '../model'
import type { PermissionMode, TriggerCode, TriggerStage } from '../schema/policy'
import type { BackendKind, BackendMode, Candidate } from '../schema/primitives'

export interface BackendFeatures {
  isolatedSession: boolean
  samePrimaryTurns: boolean
  recoverAcceptedTurn: boolean
  permissionReply: boolean
  cancel: boolean
  eventReplay: boolean
}

export interface FallbackFeatures {
  orderedFallback: boolean
  supportedFallbackTriggers: { code: TriggerCode; stage: TriggerStage }[]
  cleanFailureFallback: boolean
  checkpointHandoff: boolean
  sameOwnerResetRecovery: boolean
  nativeGoal: boolean
}

export interface BackendCapabilities {
  kind: BackendKind
  mode: BackendMode
  available: boolean
  availabilityReason: string | null
  features: BackendFeatures
  permissionModes: PermissionMode[]
  fallback: FallbackFeatures
}

/** Everything a backend needs to know about one execution attempt. */
export interface AttemptContext {
  taskId: string
  executionAttemptId: string
  executionId: string
  turnId: string
  candidate: Candidate
  workdir: WorkdirIdentity
  permissionMode: PermissionMode
  /** Private 0700 directory for this attempt (run files, signal dirs). */
  runDir: string
}

/** Persisted identity of the backend-side owner; enough to reattach after a router restart. */
export interface BackendHandle {
  backendSessionId: string | null
  backendTurnId: string
  pid: number | null
  pgid: number | null
  processStartIdentity: string | null
  extra: Record<string, string | number | null>
}

export type NotSentCode = Extract<TriggerCode,
  'backend_unavailable' | 'startup_failed' | 'rate_limited' | 'provider_unavailable' | 'model_unavailable' | 'capability_unavailable' | 'authentication_invalid'>

/** Positive proof that the assignment input never reached the backend. */
export interface NotSent {
  kind: 'not_sent'
  code: NotSentCode
  detail: string
  /** True when the backend left nothing running that needs release. */
  ownerSettled: boolean
}

export type OpenResult = { kind: 'opened'; handle: BackendHandle } | NotSent
export type SubmitResult =
  | { kind: 'accepted'; handle?: BackendHandle }
  /** Input handed off; acceptance will be reported by a `delivery` event from observe(). */
  | { kind: 'pending'; handle?: BackendHandle }
  | NotSent
  | { kind: 'unknown'; detail: string }

export interface TurnProtocol { backendFinished: boolean | null; activeToolCount: number | null; stopReason: string | null }
export interface TurnProcess { exitCode: number | null; signal: string | null; controlledShutdown: boolean | null }

export type BackendEvent =
  | { type: 'delivery'; status: 'accepted' }
  | { type: 'delivery'; status: 'not_sent'; failure: NotSent }
  | { type: 'delivery'; status: 'unknown'; detail: string }
  | { type: 'handle'; handle: BackendHandle }
  /** `snapshot` replaces the stream's full text so far; `append` adds to it. */
  | { type: 'text'; streamId: string; text: string; mode: 'snapshot' | 'append' }
  | { type: 'tool'; toolCallId: string; name: string; status: 'started' | 'completed' | 'failed'; detail?: string }
  | { type: 'permission.requested'; backendRequestId: string; toolCallId: string | null; toolName: string; description: string }
  | { type: 'permission.cleared'; backendRequestId: string }
  | { type: 'interaction.required'; detail: string }
  | { type: 'activity'; label: string }
  | { type: 'diagnostic'; detail: string }
  | {
    type: 'turn.ended'; outcome: TurnOutcome; finalText: string | null; protocol: TurnProtocol; process: TurnProcess
    failureCode?: NotSentCode | 'execution_failed' | 'quota_exhausted' | 'context_exhausted' | 'idle_timeout'
    /** Backend's evidence about side effects of the turn; default 'unknown'. */
    effects?: 'none' | 'partial' | 'unknown'
  }
  /** Observation lost and the owner's state cannot be proven; the task becomes UNKNOWN. */
  | { type: 'lost'; detail: string }

export type LocateResult = 'absent' | 'running' | 'ended' | 'missing' | 'unreachable'

export interface ReleaseResult {
  released: boolean | null
  backgroundWorkSettled: boolean | null
  detail: string
}

export interface TaskBackend {
  readonly kind: BackendKind
  readonly mode: BackendMode
  capabilities(): Promise<BackendCapabilities>
  /** Availability/prerequisite check. Never sends input. */
  preflight(ctx: AttemptContext, signal: AbortSignal): Promise<{ kind: 'ok' } | NotSent>
  /** Create the isolated owner (session / run dir) without sending input. */
  open(ctx: AttemptContext, signal: AbortSignal): Promise<OpenResult>
  /** Send the single assignment input. The caller has persisted delivery=in_flight beforehand. */
  submit(ctx: AttemptContext, handle: BackendHandle, input: { inputKind: 'text' | 'native_goal'; prompt: string }, signal: AbortSignal): Promise<SubmitResult>
  /** Observe the turn to its end. Must be safe to call again after a router restart with the persisted handle. */
  observe(ctx: AttemptContext, handle: BackendHandle, signal: AbortSignal): AsyncIterable<BackendEvent>
  replyPermission(ctx: AttemptContext, handle: BackendHandle, backendRequestId: string, decision: 'allow_once' | 'deny_once'): Promise<'confirmed' | 'unknown'>
  /** Ask the exact owner to stop the in-flight turn. */
  interrupt(ctx: AttemptContext, handle: BackendHandle): Promise<void>
  /** Stop (after grace) and verify that nothing the attempt owns is still running. Never touches shared services. */
  release(ctx: AttemptContext, handle: BackendHandle, graceMs: number): Promise<ReleaseResult>
  /** Recovery: where is this turn now? */
  locate(ctx: AttemptContext, handle: BackendHandle): Promise<LocateResult>
}

export function emptyHandle(backendTurnId: string): BackendHandle {
  return { backendSessionId: null, backendTurnId, pid: null, pgid: null, processStartIdentity: null, extra: {} }
}

export function notSent(code: NotSentCode, detail: string, ownerSettled = true): NotSent {
  return { kind: 'not_sent', code, detail, ownerSettled }
}
