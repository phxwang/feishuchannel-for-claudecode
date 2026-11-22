/**
 * Shared types for the multi-agent router (Claude Code + OpenCode).
 * See docs/multi-agent-router-design.md for the full design.
 */

export type AgentKind = 'claude' | 'opencode' | 'agy'

export interface AgentPolicy {
  primary: AgentKind
  fallback: AgentKind | null
  policy?: 'pre_execution_only'
  /**
   * How a `primary: 'claude'` task is delivered. 'socket' (default) is the
   * existing Unix-socket worker protocol (worker-link.ts / server.ts running
   * as an MCP plugin). 'tmux' drives a real interactive `claude` CLI in a
   * detached tmux session instead — see claude-tmux-worker.ts. Ignored when
   * primary is 'opencode'.
   */
  mode?: 'socket' | 'tmux'
  /**
   * Model to pass as `--model` when spawning a tmux-mode session (e.g.
   * "fable", "opus", "sonnet", or a full model name). Empty/undefined uses
   * the CLI's own default. Only read at spawn time — changing it has no
   * effect on an already-running tmux session; ignored outside mode:'tmux'.
   */
  model?: string
  /**
   * OpenCode-only: thinking/reasoning variant (`low` | `high` | `max` for
   * deepseek-flash), applied to the native v2 session when it is idle.
   */
  variant?: string
  /**
   * agy-only: reasoning effort passed as `--effort` when the tmux session is
   * spawned. Overrides `projects.<id>.agy.effort` / `agents.agy.effort`;
   * unset uses agy's own default.
   */
  effort?: string
}

export interface ProjectConfig {
  workdir: string
  allowedAgents: AgentKind[]
  /** Per-project overrides for the `agents.opencode` feature flags, so an
   *  experimental route (e.g. native v2) can be enabled without changing
   *  every other OpenCode group. Unset values inherit from
   *  `agents.opencode`. */
  opencode?: {
    nativeV2?: boolean
    streamText?: boolean
    /** Native v2 model as `providerID/modelID`. */
    model?: string
  }
  /** Per-project overrides for `agents.agy`. Unset values inherit. */
  agy?: AgySpawnSettings
}

export const AGY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const AGY_PERMISSION_MODES = ['accept-edits', 'auto', 'plan'] as const

/** agy spawn-time flags. Every field is optional: unset = agy's own default. */
export interface AgySpawnSettings {
  model?: string
  effort?: (typeof AGY_EFFORTS)[number]
  permissionMode?: (typeof AGY_PERMISSION_MODES)[number]
}

/**
 * Antigravity CLI (`agy`) run interactively in tmux. The whole block is
 * optional — a project only has to list `agy` in allowedAgents.
 */
export interface AgyAgentConfig extends AgySpawnSettings {
  /** Binary path; default resolves `agy` from PATH, then ~/.local/bin/agy. */
  bin?: string
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
  /** No-progress timeout: re-armed by observed tool/text activity. */
  taskTimeoutSeconds: number
  /** Absolute cap regardless of progress (seconds). Defaults to 8 hours. */
  taskHardCapSeconds?: number
  maxConcurrency: number
  /** Native v2 admission/coordinator; opt-in, never migrates legacy bindings. Always shows a progress card. */
  nativeV2?: boolean
  streamText?: boolean
  /** Native v2 model as `providerID/modelID` (e.g. `deepseek/deepseek-flash`). */
  model?: string
}

export type AgentBackendConfig = ClaudeAgentConfig | OpenCodeAgentConfig | AgyAgentConfig

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

/**
 * Backend/infra config only — NOT access control and NOT chat->project
 * routing. Which project a chat maps to, and any per-chat agent override,
 * live in access.json (extended with an optional `agent` field per group/DM)
 * so there is exactly one place that owns "who can reach the bot and where
 * their messages go" — see docs/multi-agent-router-design.md's revision
 * after the original two-file split turned out to duplicate that mapping.
 */
export interface RouterConfig {
  version: 1
  defaults: {
    /** Agent policy used when a chat's access.json entry doesn't specify one. */
    agent: AgentPolicy
    routingKey: 'thread' | 'chat'
    stickyBackend: boolean
  }
  // Keyed per-agent-kind (not Partial<Record<AgentKind, AgentBackendConfig>>) so
  // `agents.opencode` narrows to OpenCodeAgentConfig instead of the union —
  // matches routing/config.ts's zod schema shape field-for-field.
  agents: { claude?: ClaudeAgentConfig; opencode?: OpenCodeAgentConfig; agy?: AgyAgentConfig }
  projects: Record<string, ProjectConfig>
  fallback: FallbackConfig
  /** Router task MCP block, validated by task-service/config.ts. */
  taskService?: import('../task-service/config').TaskServiceConfigInput
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
