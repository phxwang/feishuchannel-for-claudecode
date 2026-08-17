/**
 * router.yaml loader — schema validation + fail-closed startup checks.
 *
 * A missing router.yaml is not an error: callers should fall back to legacy
 * access.json-only behavior (see resolver.ts). A *present but invalid*
 * router.yaml IS an error — we never silently fall back to an arbitrary
 * workdir or agent.
 */
import { existsSync, readFileSync, realpathSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { z } from 'zod'
import type { AgentKind, RouterConfig } from './types'

const agentPolicySchema = z.object({
  primary: z.enum(['claude', 'opencode']),
  fallback: z.enum(['claude', 'opencode']).nullable().default(null),
  policy: z.literal('pre_execution_only').optional(),
}).refine(p => p.fallback === null || p.fallback !== p.primary, {
  message: 'agent.fallback must differ from agent.primary',
})

const routeConfigSchema = z.object({
  project: z.string().min(1),
  requireMention: z.boolean().optional(),
  agent: agentPolicySchema,
})

const routerConfigSchema = z.object({
  version: z.literal(1),
  defaults: z.object({
    project: z.string().min(1),
    agent: agentPolicySchema,
    routingKey: z.enum(['thread', 'chat']).default('chat'),
    stickyBackend: z.boolean().default(true),
  }),
  agents: z.object({
    claude: z.object({
      type: z.literal('claude-channel'),
      socket: z.string().min(1),
      health: z.object({ workerTtlSeconds: z.number().positive() }),
    }).optional(),
    opencode: z.object({
      type: z.literal('opencode'),
      baseUrl: z.string().url(),
      passwordEnv: z.string().optional(),
      requestTimeoutSeconds: z.number().positive(),
      taskTimeoutSeconds: z.number().positive(),
      maxConcurrency: z.number().int().positive(),
    }).optional(),
  }).default({}),
  projects: z.record(z.string(), z.object({
    workdir: z.string().min(1),
    allowedAgents: z.array(z.enum(['claude', 'opencode'])).min(1),
  })),
  routes: z.object({
    dms: z.record(z.string(), routeConfigSchema).default({}),
    groups: z.record(z.string(), routeConfigSchema).default({}),
  }).default({ dms: {}, groups: {} }),
  fallback: z.object({
    enabled: z.boolean().default(true),
    triggerOn: z.array(z.enum(['backend_unavailable', 'startup_timeout', 'rate_limited', 'capacity_exhausted'])).default([]),
    neverTriggerOn: z.array(z.string()).default([]),
    maxAttempts: z.number().int().min(0).default(1),
    cooldownSeconds: z.number().min(0).default(300),
    notifyUser: z.boolean().default(true),
  }).default({}),
})

export class RouterConfigError extends Error {}

/**
 * Validate a parsed config object against the schema, then enforce the
 * cross-field / filesystem invariants that zod can't express:
 *   - every project.workdir must be an absolute path that canonicalizes to
 *     somewhere inside `allowedRoots`
 *   - every route's `project` must reference a declared project
 *   - every route's primary/fallback agent must be in that project's allowedAgents
 * Throws RouterConfigError on any violation — callers must fail closed.
 */
export function validateRouterConfig(raw: unknown, allowedRoots: string[]): RouterConfig {
  const parsed = routerConfigSchema.safeParse(raw)
  if (!parsed.success) {
    throw new RouterConfigError(`router.yaml schema invalid: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }
  const cfg = parsed.data as RouterConfig

  for (const [projectId, proj] of Object.entries(cfg.projects)) {
    if (!isAbsolute(proj.workdir)) {
      throw new RouterConfigError(`project "${projectId}": workdir must be an absolute path, got "${proj.workdir}"`)
    }
    let real: string
    try {
      real = existsSync(proj.workdir) ? realpathSync(proj.workdir) : resolve(proj.workdir)
    } catch (e) {
      throw new RouterConfigError(`project "${projectId}": cannot resolve workdir "${proj.workdir}": ${e}`)
    }
    const withinAllowedRoot = allowedRoots.some(root => {
      const rroot = resolve(root)
      return real === rroot || real.startsWith(rroot + '/')
    })
    if (!withinAllowedRoot) {
      throw new RouterConfigError(`project "${projectId}": workdir "${real}" is outside allowed roots [${allowedRoots.join(', ')}]`)
    }
  }

  const checkRoute = (scope: string, chatId: string, route: RouterConfig['routes']['dms'][string]) => {
    const proj = cfg.projects[route.project]
    if (!proj) throw new RouterConfigError(`route ${scope}.${chatId}: unknown project "${route.project}"`)
    checkAgentAllowed(scope, chatId, route.project, proj.allowedAgents, route.agent.primary, 'primary')
    if (route.agent.fallback) checkAgentAllowed(scope, chatId, route.project, proj.allowedAgents, route.agent.fallback, 'fallback')
  }
  const checkAgentAllowed = (scope: string, chatId: string, projectId: string, allowed: AgentKind[], agent: AgentKind, role: string) => {
    if (!allowed.includes(agent)) {
      throw new RouterConfigError(`route ${scope}.${chatId}: ${role} agent "${agent}" not in project "${projectId}".allowedAgents [${allowed.join(', ')}]`)
    }
  }

  const defaultProj = cfg.projects[cfg.defaults.project]
  if (!defaultProj) throw new RouterConfigError(`defaults.project "${cfg.defaults.project}" is not a declared project`)
  checkAgentAllowed('defaults', '(default)', cfg.defaults.project, defaultProj.allowedAgents, cfg.defaults.agent.primary, 'primary')
  if (cfg.defaults.agent.fallback) checkAgentAllowed('defaults', '(default)', cfg.defaults.project, defaultProj.allowedAgents, cfg.defaults.agent.fallback, 'fallback')

  for (const [chatId, route] of Object.entries(cfg.routes.dms)) checkRoute('dms', chatId, route)
  for (const [chatId, route] of Object.entries(cfg.routes.groups)) checkRoute('groups', chatId, route)

  return cfg
}

/**
 * Load router.yaml from disk. Returns null if the file does not exist
 * (legacy-only mode). Throws RouterConfigError if the file exists but is
 * malformed or violates an invariant — never returns a partially-valid config.
 */
export function loadRouterConfig(path: string, allowedRoots: string[]): RouterConfig | null {
  if (!existsSync(path)) return null
  let raw: unknown
  try {
    raw = Bun.YAML.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new RouterConfigError(`router.yaml failed to parse: ${e}`)
  }
  return validateRouterConfig(raw, allowedRoots)
}
