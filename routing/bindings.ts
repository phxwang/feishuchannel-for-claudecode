/**
 * Conversation key construction + binding store interface.
 * See design doc §6 (路由与会话绑定).
 */
import type { AgentKind, ConversationBinding } from './types'

export type ChatContext =
  | { kind: 'p2p'; userOpenId: string; projectId: string }
  | { kind: 'group_thread'; chatId: string; rootMessageId: string; projectId: string }
  | { kind: 'group'; chatId: string; projectId: string }

export function conversationKey(ctx: ChatContext): string {
  switch (ctx.kind) {
    case 'p2p': return `p2p:${ctx.userOpenId}:${ctx.projectId}`
    case 'group_thread': return `group:${ctx.chatId}:thread:${ctx.rootMessageId}:${ctx.projectId}`
    case 'group': return `group:${ctx.chatId}:${ctx.projectId}`
  }
}

/** In-memory conversation binding store. A SQLite-backed implementation satisfies the same interface (see design doc §9). */
export interface BindingStore {
  get(key: string): ConversationBinding | undefined
  put(binding: ConversationBinding): void
  delete(key: string): void
}

export class InMemoryBindingStore implements BindingStore {
  private map = new Map<string, ConversationBinding>()
  get(key: string) { return this.map.get(key) }
  put(binding: ConversationBinding) { this.map.set(binding.conversationKey, binding) }
  delete(key: string) { this.map.delete(key) }
}

/**
 * Resolve which agent a conversation should actually use, honoring sticky
 * backend semantics (design doc §6): once a session exists, subsequent
 * messages keep using activeAgent regardless of config changes, until
 * `/agent reset` clears the binding.
 */
export function activeAgentFor(
  store: BindingStore,
  key: string,
  configuredPrimary: AgentKind,
): AgentKind {
  return store.get(key)?.activeAgent ?? configuredPrimary
}

export function createBinding(
  key: string,
  projectId: string,
  configuredPrimary: AgentKind,
  configuredFallback: AgentKind | null,
  agentSessionId: string,
  routeVersion: string,
  now: string,
): ConversationBinding {
  return {
    conversationKey: key,
    projectId,
    configuredPrimary,
    configuredFallback,
    activeAgent: configuredPrimary,
    agentSessionId,
    routeVersion,
    createdAt: now,
    updatedAt: now,
  }
}

/** Switch a binding's active backend after a successful fallback (design doc §6/§7). New session id required — no context is migrated. */
export function switchActiveAgent(binding: ConversationBinding, agent: AgentKind, newSessionId: string, now: string): ConversationBinding {
  return { ...binding, activeAgent: agent, agentSessionId: newSessionId, updatedAt: now }
}
