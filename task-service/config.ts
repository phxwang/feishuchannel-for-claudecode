/**
 * `taskService` block of agents.yaml (design doc §6). Parsed by the same
 * loader as the rest of agents.yaml (routing/config.ts) and finalized here:
 * roots canonicalized, unsafe roots and dangerous backend settings rejected.
 */
import { existsSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, resolve } from 'path'
import { z } from 'zod'

const REAL_KINDS = ['opencode', 'claude', 'codex', 'agy'] as const
export const DEFAULT_HTTP_PORT = 8767
const cap = z.number().int().positive().optional()
/** Optional allowlist. Omitted = no restriction: the candidate's model is passed through to the agent CLI as-is. */
const models = z.array(z.string().min(1).max(256)).min(1).optional()

export const taskServiceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxConcurrentTasks: cap,
  projects: z.record(z.string(), z.object({
    workdirRoots: z.array(z.string().min(1)).min(1).optional(),
  }).strict()).default({}),
  dynamicWorkdirs: z.object({
    enabled: z.boolean().default(true),
    roots: z.array(z.string().min(1)).min(1).optional(),
    allowedAgents: z.array(z.enum([...REAL_KINDS, 'fake'])).default([...REAL_KINDS]),
    requireGitWorktree: z.boolean().default(false),
    denyPaths: z.array(z.string().min(1)).default([]),
  }).strict().default({}),
  /** router-task MCP over Streamable HTTP, served by the router itself (mcp/http.ts). */
  http: z.object({
    enabled: z.boolean().default(true),
    host: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(DEFAULT_HTTP_PORT),
    /** Optional file holding a bearer token clients must send (Authorization: Bearer …). */
    bearerTokenFile: z.string().min(1).optional(),
  }).strict().default({}),
  backends: z.object({
    opencode: z.object({ models, maxConcurrentTasks: cap }).strict().optional(),
    claude: z.object({
      bin: z.string().min(1).nullable().optional(),
      models,
      maxConcurrentTasks: cap,
    }).strict().optional(),
    codex: z.object({
      bin: z.string().min(1).nullable().optional(),
      models,
      sandbox: z.enum(['read-only', 'workspace-write']).default('workspace-write'),
      maxConcurrentTasks: cap,
    }).strict().optional(),
    agy: z.object({
      bin: z.string().min(1).nullable().optional(),
      models,
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
      permissionMode: z.enum(['accept-edits', 'auto', 'plan']).nullable().optional(),
      maxConcurrentTasks: cap,
    }).strict().optional(),
    fake: z.object({
      enabled: z.boolean().default(false),
      models,
      maxConcurrentTasks: cap,
    }).strict().optional(),
  }).strict().default({}),
}).strict()

export type TaskServiceConfigInput = z.infer<typeof taskServiceConfigSchema>

export interface TaskServiceConfig extends Omit<TaskServiceConfigInput, 'projects' | 'dynamicWorkdirs'> {
  projects: Record<string, { workdirRoots: string[]; allowedAgents: string[] }>
  dynamicWorkdirs: Omit<TaskServiceConfigInput['dynamicWorkdirs'], 'roots' | 'denyPaths'> & { roots: string[]; denyPaths: string[] }
}

export class TaskServiceConfigError extends Error {}

export function canonicalPath(p: string): string {
  try { return existsSync(p) ? realpathSync(p) : resolve(p) } catch { return resolve(p) }
}

export function isWithin(child: string, root: string): boolean {
  const r = root.endsWith('/') && root !== '/' ? root.slice(0, -1) : root
  return child === r || child.startsWith(r === '/' ? '/' : r + '/')
}

export interface FinalizeOptions {
  /** agents.yaml `projects` (already canonicalized by validateRouterConfig). */
  projects: Record<string, { workdir: string; allowedAgents: string[] }>
  /** AGENTS_ALLOWED_ROOTS — default dynamic root. */
  allowedRoots: string[]
  stateDir: string
  home?: string
}

/** Cross-field validation + canonicalization. Throws TaskServiceConfigError (callers fail closed). */
export function finalizeTaskServiceConfig(input: TaskServiceConfigInput, opts: FinalizeOptions): TaskServiceConfig {
  const home = canonicalPath(opts.home ?? homedir())
  const forbiddenInside = [home, canonicalPath(opts.stateDir), canonicalPath(join(home, '.claude'))]

  const checkRoot = (raw: string, where: string): string => {
    if (!isAbsolute(raw)) throw new TaskServiceConfigError(`${where}: root must be an absolute path, got "${raw}"`)
    const root = canonicalPath(raw)
    if (root === '/') throw new TaskServiceConfigError(`${where}: "/" cannot be a root`)
    for (const f of forbiddenInside) {
      if (isWithin(f, root)) throw new TaskServiceConfigError(`${where}: root "${root}" contains ${f}, which is not allowed`)
    }
    return root
  }

  const projects: TaskServiceConfig['projects'] = {}
  for (const [id, p] of Object.entries(input.projects)) {
    const base = opts.projects[id]
    if (!base) throw new TaskServiceConfigError(`taskService.projects.${id}: no such project under top-level "projects"`)
    const roots = (p.workdirRoots ?? [base.workdir]).map(r => checkRoot(r, `taskService.projects.${id}.workdirRoots`))
    projects[id] = { workdirRoots: roots, allowedAgents: [...base.allowedAgents] }
  }

  const dyn = input.dynamicWorkdirs
  const dynRoots = (dyn.roots ?? opts.allowedRoots).map(r => checkRoot(r, 'taskService.dynamicWorkdirs.roots'))
  const denyPaths = dyn.denyPaths.map(p => {
    if (!isAbsolute(p)) throw new TaskServiceConfigError(`taskService.dynamicWorkdirs.denyPaths: "${p}" must be absolute`)
    return canonicalPath(p)
  })

  return { ...input, projects, dynamicWorkdirs: { ...dyn, roots: dynRoots, denyPaths } }
}
