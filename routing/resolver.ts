/**
 * Route resolution — decides which project + agent policy a conversation
 * uses.
 *
 * access.json is the single source of truth for chat -> project mapping
 * (via `groups[chatId].workdir` / `defaultWorkdir`, unchanged from before)
 * AND, now, for any per-chat agent override (`groups[chatId].agent` /
 * `defaultAgent`) — see docs/multi-agent-router-design.md's revision after
 * the original design duplicated this mapping across access.json and a
 * separate router.yaml `routes` section.
 *
 * agents.yaml (routing/config.ts's RouterConfig) supplies only: the default
 * agent policy used when access.json doesn't specify one, and the
 * project/agent whitelist used to sanitize whatever access.json requests —
 * access.json can be edited live via /feishu:access without a router
 * restart, so it cannot be trusted to only ever name whitelisted agents;
 * an unrecognized or disallowed choice is not an error, it just falls
 * closed to Claude-only for that resolution.
 */
import type { AgentPolicy, RouterConfig } from './types'

export interface ResolvedRoute {
  project: string
  workdir: string
  agent: AgentPolicy
  requireMention: boolean
  source: 'thread_override' | 'access_json'
}

/** Shape of this repo's access.json, extended with an optional per-chat agent override. */
export interface LegacyAccess {
  groups: Record<string, { requireMention?: boolean; workdir?: string; agent?: AgentPolicy }>
  defaultWorkdir?: string
  defaultAgent?: AgentPolicy
}

export interface ResolveInput {
  chatType: 'p2p' | 'group'
  chatId: string
  /** admin-set temporary override for a specific thread/chat, e.g. via `/agent use` */
  threadOverride?: { project: string; agent: AgentPolicy }
}

const CLAUDE_ONLY: AgentPolicy = { primary: 'claude', fallback: null }

/**
 * Resolve a route. Returns null only when access.json has no workdir for
 * this chat (no group entry and no defaultWorkdir) — callers must drop the
 * message (fail closed), never guess a directory.
 */
export function resolveRoute(input: ResolveInput, infra: RouterConfig | null, access: LegacyAccess): ResolvedRoute | null {
  if (input.threadOverride) {
    const proj = infra?.projects[input.threadOverride.project]
    if (proj) {
      return {
        project: input.threadOverride.project,
        workdir: proj.workdir,
        agent: input.threadOverride.agent,
        requireMention: groupRequireMention(input, access),
        source: 'thread_override',
      }
    }
  }

  const groupEntry = input.chatType === 'group' ? access.groups[input.chatId] : undefined
  const workdir = groupEntry?.workdir ?? access.defaultWorkdir
  if (!workdir) return null

  const requested = (input.chatType === 'group' ? groupEntry?.agent : access.defaultAgent) ?? infra?.defaults.agent ?? CLAUDE_ONLY
  const agent = sanitizeAgentPolicy(requested, infra, workdir)

  return {
    project: workdir,
    workdir,
    agent,
    requireMention: groupRequireMention(input, access),
    source: 'access_json',
  }
}

function groupRequireMention(input: ResolveInput, access: LegacyAccess): boolean {
  if (input.chatType !== 'group') return true
  return access.groups[input.chatId]?.requireMention ?? true
}

/**
 * Falls back to Claude-only whenever `infra` can't vouch for the requested
 * policy — no agents.yaml at all, no project declared for this workdir, or
 * the requested primary/fallback isn't in that project's allowedAgents.
 */
function sanitizeAgentPolicy(requested: AgentPolicy, infra: RouterConfig | null, workdir: string): AgentPolicy {
  if (!infra) return CLAUDE_ONLY
  const project = Object.values(infra.projects).find(p => p.workdir === workdir)
  if (!project) return CLAUDE_ONLY
  if (!project.allowedAgents.includes(requested.primary)) return CLAUDE_ONLY
  const fallbackOk = requested.fallback === null || project.allowedAgents.includes(requested.fallback)
  return { ...requested, fallback: fallbackOk ? requested.fallback : null }
}
