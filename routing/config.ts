/**
 * agents.yaml loader — schema validation + fail-closed startup checks.
 *
 * Backend/infra config only (agents, projects, fallback policy) — NOT
 * access control and NOT chat->project routing. That lives in access.json
 * (see resolver.ts's LegacyAccess type), which is the single source of
 * truth for which chat maps to which project and, optionally, which agent.
 *
 * A missing agents.yaml is not an error: callers fall back to Claude-only
 * behavior driven entirely by access.json (see resolver.ts). A *present but
 * invalid* agents.yaml IS an error — we never silently start with a
 * partially-valid infra config.
 */
import { existsSync, readFileSync, realpathSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { z } from 'zod'
import type { RouterConfig } from './types'

const agentPolicySchema = z.object({
  primary: z.enum(['claude', 'opencode']),
  fallback: z.enum(['claude', 'opencode']).nullable().default(null),
  policy: z.literal('pre_execution_only').optional(),
}).refine(p => p.fallback === null || p.fallback !== p.primary, {
  message: 'agent.fallback must differ from agent.primary',
})

const routerConfigSchema = z.object({
  version: z.literal(1),
  defaults: z.object({
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
 *   - defaults.agent's primary/fallback don't need to be valid for any
 *     specific project here — that's checked per-chat at resolve time
 *     (resolver.ts), since which project a chat uses comes from access.json
 *     and can change without restarting the router.
 * Throws RouterConfigError on any violation — callers must fail closed.
 */
export function validateRouterConfig(raw: unknown, allowedRoots: string[]): RouterConfig {
  const parsed = routerConfigSchema.safeParse(raw)
  if (!parsed.success) {
    throw new RouterConfigError(`agents.yaml schema invalid: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
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

  return cfg
}

/**
 * Load agents.yaml from disk. Returns null if the file does not exist
 * (legacy-only mode). Throws RouterConfigError if the file exists but is
 * malformed or violates an invariant — never returns a partially-valid config.
 */
export function loadRouterConfig(path: string, allowedRoots: string[]): RouterConfig | null {
  if (!existsSync(path)) return null
  let raw: unknown
  try {
    raw = Bun.YAML.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new RouterConfigError(`agents.yaml failed to parse: ${e}`)
  }
  return validateRouterConfig(raw, allowedRoots)
}
