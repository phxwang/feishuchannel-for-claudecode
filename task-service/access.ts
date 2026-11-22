/**
 * Workdir admission (design doc §6, §9.3): named-project roots first, then
 * dynamic roots, deny list, per-component ownership for dynamic dirs, and a
 * dev/ino identity recorded for recheck before every dispatch.
 */
import { existsSync, lstatSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, relative, sep } from 'path'
import { canonicalPath, isWithin, type TaskServiceConfig } from './config'
import { DomainError } from './errors'
import type { WorkdirIdentity } from './model'

export interface AccessContext {
  config: TaskServiceConfig
  stateDir: string
  uid: number
  home?: string
}

export interface ResolvedWorkdir {
  identity: WorkdirIdentity
  workdirSource: 'project' | 'dynamic'
  projectId: string | null
  allowedAgents: string[]
}

// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f]/

const deny = (reason: string, message: string, extra: Record<string, unknown> = {}) =>
  new DomainError('WORKDIR_NOT_ALLOWED', message, { reason, ...extra })

function realDir(input: string): string {
  if (!isAbsolute(input) || BAD_CHARS.test(input)) throw deny('invalid_path', 'Workdir must be an absolute path without control characters.')
  if (!existsSync(input)) throw deny('not_found', 'Workdir does not exist. Create it before prepare.')
  let real: string
  try { real = realpathSync(input) } catch { throw deny('not_found', 'Workdir cannot be resolved.') }
  if (!statSync(real).isDirectory()) throw deny('not_directory', 'Workdir is not a directory.')
  return real
}

function rootFor(path: string, roots: string[]): string | undefined {
  return roots.filter(r => isWithin(path, r)).sort((a, b) => b.length - a.length)[0]
}

function checkOwnership(path: string, root: string, uid: number): void {
  // Every component strictly below the root, down to and including the workdir.
  const rel = relative(root, path)
  let cur = root
  for (const part of rel.split(sep).filter(Boolean)) {
    cur = join(cur, part)
    const st = lstatSync(cur)
    if (st.isSymbolicLink()) throw deny('ownership', 'A path component below the root is a symlink.', { path: cur })
    if (st.uid !== uid) throw deny('ownership', 'A path component below the root is not owned by the router user.', { path: cur })
    if ((st.mode & 0o022) !== 0) throw deny('ownership', 'A path component below the root is writable by group or others.', { path: cur })
  }
}

function hasGit(path: string): boolean {
  return existsSync(join(path, '.git'))
}

export function resolveWorkdir(input: string, projectId: string | null, ctx: AccessContext): ResolvedWorkdir {
  const real = realDir(input)
  const home = canonicalPath(ctx.home ?? homedir())
  const { config } = ctx

  const alwaysDenied = [canonicalPath(ctx.stateDir), canonicalPath(join(home, '.claude')), ...config.dynamicWorkdirs.denyPaths]
  if (real === home) throw deny('denied', 'The home directory itself cannot be a workdir.')
  for (const d of alwaysDenied) if (isWithin(real, d)) throw deny('denied', 'Workdir is inside a denied path.')

  // Named project rules apply whenever the path is under that project's roots.
  if (projectId && !config.projects[projectId]) {
    throw new DomainError('PROJECT_NOT_ALLOWED', 'Unknown projectId.', { projectId })
  }
  const named = Object.entries(config.projects)
    .map(([id, p]) => ({ id, p, root: rootFor(real, p.workdirRoots) }))
    .filter((x): x is { id: string; p: typeof x.p; root: string } => !!x.root)
    .sort((a, b) => b.root.length - a.root.length)
  const match = projectId ? named.find(x => x.id === projectId) : named[0]
  if (projectId && !match) throw deny('outside_project', 'Workdir is not under the project roots.', { projectId })

  let source: 'project' | 'dynamic'
  let root: string
  let allowedAgents: string[]
  let resolvedProject: string | null
  if (match) {
    source = 'project'; root = match.root; allowedAgents = match.p.allowedAgents; resolvedProject = match.id
  } else {
    if (!config.dynamicWorkdirs.enabled) throw deny('dynamic_disabled', 'Dynamic workdirs are disabled.')
    const dynRoot = rootFor(real, config.dynamicWorkdirs.roots)
    if (!dynRoot) throw deny('outside_roots', 'Workdir is outside every allowed root.')
    source = 'dynamic'; root = dynRoot; allowedAgents = config.dynamicWorkdirs.allowedAgents; resolvedProject = null
    checkOwnership(real, root, ctx.uid)
  }
  if (real === root && source === 'dynamic') throw deny('root_itself', 'A root itself cannot be a workdir.')
  if (config.dynamicWorkdirs.requireGitWorktree && !hasGit(real)) throw deny('not_git', 'Workdir must be a git worktree.')

  const st = statSync(real)
  return {
    identity: { canonicalPath: real, dev: st.dev, ino: st.ino },
    workdirSource: source,
    projectId: resolvedProject,
    allowedAgents,
  }
}

/** Recheck before dispatch: same canonical path, same device/inode. */
export function workdirUnchanged(id: WorkdirIdentity): boolean {
  try {
    const real = realpathSync(id.canonicalPath)
    if (real !== id.canonicalPath) return false
    const st = statSync(real)
    return st.isDirectory() && st.dev === id.dev && st.ino === id.ino
  } catch { return false }
}

/** The task-service private directory must be a real 0700 directory owned by us (design doc §5.1). */
export function checkPrivateDir(dir: string, uid: number): void {
  const st = lstatSync(dir)
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a real directory`)
  if (st.uid !== uid) throw new Error(`${dir} is not owned by uid ${uid}`)
  if ((st.mode & 0o077) !== 0) throw new Error(`${dir} must have mode 0700, has ${(st.mode & 0o777).toString(8)}`)
}
