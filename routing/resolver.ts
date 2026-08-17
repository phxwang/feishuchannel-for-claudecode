/**
 * Route resolution — decides which project + agent policy a conversation
 * uses. See design doc §5 (解析优先级：主题临时绑定 → 群/私聊显式 route → defaults → 旧 access.json 兼容映射).
 */
import type { AgentPolicy, RouteConfig, RouterConfig } from './types'

export interface ResolvedRoute {
  project: string
  workdir: string
  agent: AgentPolicy
  requireMention: boolean
  /** which tier of the priority chain produced this result, for observability/testing */
  source: 'thread_override' | 'explicit_route' | 'defaults' | 'legacy_access'
}

/** Minimal shape of the legacy access.json this repo already uses. */
export interface LegacyAccess {
  groups: Record<string, { requireMention?: boolean; workdir?: string }>
  defaultWorkdir?: string
}

export interface ResolveInput {
  chatType: 'p2p' | 'group'
  chatId: string
  /** admin-set temporary override for a specific thread/chat, e.g. via `/agent use` */
  threadOverride?: { project: string; agent: AgentPolicy }
}

const CLAUDE_ONLY: AgentPolicy = { primary: 'claude', fallback: null }

/**
 * Resolve a route. Returns null only when neither router.yaml nor legacy
 * access.json can produce a workdir for this chat — callers must drop the
 * message (fail closed), never guess a directory.
 */
export function resolveRoute(input: ResolveInput, config: RouterConfig | null, legacy: LegacyAccess): ResolvedRoute | null {
  if (input.threadOverride) {
    const proj = config?.projects[input.threadOverride.project]
    if (proj) {
      return {
        project: input.threadOverride.project,
        workdir: proj.workdir,
        agent: input.threadOverride.agent,
        requireMention: explicitRoute(input, config)?.requireMention ?? true,
        source: 'thread_override',
      }
    }
  }

  const explicit = explicitRoute(input, config)
  if (explicit && config) {
    const proj = config.projects[explicit.project]
    if (proj) {
      return {
        project: explicit.project,
        workdir: proj.workdir,
        agent: explicit.agent,
        requireMention: explicit.requireMention ?? true,
        source: 'explicit_route',
      }
    }
  }

  if (config) {
    const proj = config.projects[config.defaults.project]
    if (proj) {
      return {
        project: config.defaults.project,
        workdir: proj.workdir,
        agent: config.defaults.agent,
        requireMention: true,
        source: 'defaults',
      }
    }
  }

  // Legacy access.json fallback: agent is always Claude-only. access.json has no
  // project registry, so `project` here is the workdir itself, NOT a key into
  // RouterConfig.projects like every other branch returns — callers that treat
  // ResolvedRoute.project as a config.projects lookup key must special-case
  // source === 'legacy_access' (it's still a stable, unique id, just not that kind).
  const legacyWorkdir = input.chatType === 'group' ? legacy.groups[input.chatId]?.workdir : undefined
  const workdir = legacyWorkdir ?? legacy.defaultWorkdir
  if (!workdir) return null
  return {
    project: workdir,
    workdir,
    agent: CLAUDE_ONLY,
    requireMention: input.chatType === 'group' ? (legacy.groups[input.chatId]?.requireMention ?? true) : true,
    source: 'legacy_access',
  }
}

function explicitRoute(input: ResolveInput, config: RouterConfig | null): RouteConfig | undefined {
  if (!config) return undefined
  return input.chatType === 'group' ? config.routes.groups[input.chatId] : config.routes.dms[input.chatId]
}
