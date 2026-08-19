/**
 * Unified Agent Adapter interface — design doc §4.
 *
 * Router/Gateway code talks to this interface only; it never sees Claude's
 * MCP notification shapes or OpenCode's SSE event shapes directly. Each
 * backend (adapters/claude, adapters/opencode) normalizes its own protocol
 * into these types.
 */
import type { AgentKind } from '../routing/types'

export interface AgentTarget {
  workdir: string
}

export interface HealthStatus {
  healthy: boolean
  detail?: string
  checkedAt: string
}

export interface ConversationContext {
  conversationKey: string
  projectId: string
  workdir: string
}

export interface AgentSession {
  sessionId: string
  agent: AgentKind
}

export interface AgentTask {
  taskId: string
  sessionId: string
  prompt: string
}

export type PermissionBehavior = 'allow' | 'deny'

export interface PermissionDecision {
  requestId: string
  behavior: PermissionBehavior
}

export interface FinalMessage {
  taskId: string
  text: string
}

export interface FileDiff {
  path: string
  diff: string
}

// Design doc §4: "task.started、text.delta、text.completed、tool.started、
// tool.completed、tool.failed、permission.requested、session.idle、
// task.failed、task.aborted"
export type AgentEvent =
  | { type: 'task.started'; taskId: string }
  | { type: 'text.delta'; taskId: string; text: string }
  | { type: 'text.completed'; taskId: string; text: string }
  | { type: 'tool.started'; taskId: string; toolName: string }
  | { type: 'tool.completed'; taskId: string; toolName: string }
  | { type: 'tool.failed'; taskId: string; toolName: string; error: string }
  | { type: 'permission.requested'; taskId: string; requestId: string; toolName: string; description: string }
  | { type: 'attachment.completed'; taskId: string; mime: string; dataUrl: string; filename?: string }
  | { type: 'session.idle'; taskId: string }
  | { type: 'task.failed'; taskId: string; reason: string }
  | { type: 'task.aborted'; taskId: string }

export interface AgentAdapter {
  readonly kind: AgentKind
  health(target: AgentTarget): Promise<HealthStatus>
  createSession(ctx: ConversationContext): Promise<AgentSession>
  resumeSession(sessionId: string): Promise<AgentSession>
  send(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent>
  abort(sessionId: string, taskId: string): Promise<void>
  respondPermission(requestId: string, decision: PermissionDecision): Promise<void>
  getFinalMessage(sessionId: string, taskId: string): Promise<FinalMessage>
  getDiff(sessionId: string, taskId?: string): Promise<FileDiff[]>
}
