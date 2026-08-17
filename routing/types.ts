/**
 * Shared types for the multi-agent router (Claude Code + OpenCode).
 * See docs/multi-agent-router-design.md for the full design.
 */

export type AgentKind = 'claude' | 'opencode'

export interface AgentPolicy {
  primary: AgentKind
  fallback: AgentKind | null
  policy?: 'pre_execution_only'
}

export interface RouteConfig {
  project: string
  requireMention?: boolean
  agent: AgentPolicy
}

export interface ProjectConfig {
  workdir: string
  allowedAgents: AgentKind[]
}

export interface ClaudeAgentConfig {
  type: 'claude-channel'
  socket: string
  health: { workerTtlSeconds: number }
}

export interface OpenCodeAgentConfig {
  type: 'opencode'
  baseUrl: string
  passwordEnv?: string
  requestTimeoutSeconds: number
  taskTimeoutSeconds: number
  maxConcurrency: number
}

export type AgentBackendConfig = ClaudeAgentConfig | OpenCodeAgentConfig

export interface FallbackConfig {
  enabled: boolean
  triggerOn: FallbackTrigger[]
  neverTriggerOn: string[]
  maxAttempts: number
  cooldownSeconds: number
  notifyUser: boolean
}

export type FallbackTrigger =
  | 'backend_unavailable'
  | 'startup_timeout'
  | 'rate_limited'
  | 'capacity_exhausted'

export interface RouterConfig {
  version: 1
  defaults: {
    project: string
    agent: AgentPolicy
    routingKey: 'thread' | 'chat'
    stickyBackend: boolean
  }
  agents: Partial<Record<AgentKind, AgentBackendConfig>>
  projects: Record<string, ProjectConfig>
  routes: {
    dms: Record<string, RouteConfig>
    groups: Record<string, RouteConfig>
  }
  fallback: FallbackConfig
}

// ── Conversation binding ─────────────────────────────────────────────────

export interface ConversationBinding {
  conversationKey: string
  projectId: string
  configuredPrimary: AgentKind
  configuredFallback: AgentKind | null
  activeAgent: AgentKind
  agentSessionId: string
  routeVersion: string
  createdAt: string
  updatedAt: string
}

// ── Task state machine ───────────────────────────────────────────────────

export type TaskState =
  | 'RECEIVED'
  | 'PRIMARY_SELECTED'
  | 'PRIMARY_PREFLIGHT'
  | 'SUBMITTED'
  | 'RUNNING'
  | 'WAITING_PERMISSION'
  | 'COMPLETED'
  | 'FAILED'
  | 'ABORTED'
  | 'FALLBACK_ELIGIBLE'
  | 'FALLBACK_PREFLIGHT'

export interface TaskContext {
  taskId: string
  conversationKey: string
  state: TaskState
  primary: AgentKind
  fallback: AgentKind | null
  attemptedAgents: AgentKind[]
  /** true once the primary has produced any visible text, tool call, file change, or permission request */
  hasSideEffect: boolean
  /**
   * Only meaningful in SUBMITTED: true once the Adapter has positive proof the
   * backend never received the task (e.g. an immediate connection-refused/4xx
   * before any ack). Design doc §7 allows fallback only for "已确认未接收"
   * SUBMITTED tasks — without this proof, SUBMITTED must NOT be treated as
   * fallback-eligible just because no side effect has been observed yet, since
   * the backend may simply not have started executing yet.
   */
  confirmedNotReceived?: boolean
  failureReason?: FallbackTrigger | 'permission_denied' | 'user_abort' | 'invalid_request' | 'tool_failure' | 'partial_execution' | 'unknown'
}
