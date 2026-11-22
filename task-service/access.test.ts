import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, renameSync, symlinkSync } from 'fs'
import { join } from 'path'
import { resolveWorkdir, workdirUnchanged, type AccessContext } from './access'
import { finalizeTaskServiceConfig, taskServiceConfigSchema, TaskServiceConfigError } from './config'
import { DomainError } from './errors'
import { tempRoot } from './test-helpers'

function setup(extra: Record<string, unknown> = {}, projects: Record<string, { workdir: string; allowedAgents: string[] }> = {}) {
  const dir = tempRoot('rtask-access-')
  const home = join(dir, 'home')
  const stateDir = join(home, '.claude', 'channels', 'feishu')
  const projectsRoot = join(home, 'Projects')
  const tmpRoot = join(dir, 'tmp')
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(projectsRoot, { recursive: true })
  mkdirSync(tmpRoot, { recursive: true })
  chmodSync(tmpRoot, 0o1777)
  const raw = taskServiceConfigSchema.parse({ enabled: true, dynamicWorkdirs: { roots: [projectsRoot, tmpRoot] }, ...extra })
  const config = finalizeTaskServiceConfig(raw, { projects, allowedRoots: [projectsRoot], stateDir, home })
  const ctx: AccessContext = { config, stateDir, uid: process.getuid!(), home }
  return { dir, home, stateDir, projectsRoot, tmpRoot, ctx }
}

const code = (fn: () => unknown) => { try { fn(); return 'ok' } catch (e) { return e instanceof DomainError ? `${e.code}:${e.details.reason ?? ''}` : String(e) } }

describe('dynamic workdirs', () => {
  test('accepts a new directory under a root and records its identity', () => {
    const s = setup()
    const wd = join(s.projectsRoot, 'wt-1')
    mkdirSync(wd)
    const r = resolveWorkdir(wd, null, s.ctx)
    expect(r.workdirSource).toBe('dynamic')
    expect(r.projectId).toBeNull()
    expect(workdirUnchanged(r.identity)).toBe(true)
  })

  test('accepts an owned directory under a world-writable temp root', () => {
    const s = setup()
    const wd = join(s.tmpRoot, 'job')
    mkdirSync(wd, { mode: 0o755 })
    chmodSync(wd, 0o755)
    expect(resolveWorkdir(wd, null, s.ctx).workdirSource).toBe('dynamic')
  })

  test('rejects group/other-writable components under a root', () => {
    const s = setup()
    const wd = join(s.tmpRoot, 'shared')
    mkdirSync(wd)
    chmodSync(wd, 0o777)
    expect(code(() => resolveWorkdir(wd, null, s.ctx))).toBe('WORKDIR_NOT_ALLOWED:ownership')
  })

  test('rejects outside roots, escapes, symlinks out, the root itself, denied paths and missing dirs', () => {
    const s = setup()
    const outside = join(s.dir, 'elsewhere')
    mkdirSync(outside)
    expect(code(() => resolveWorkdir(outside, null, s.ctx))).toBe('WORKDIR_NOT_ALLOWED:outside_roots')
    expect(code(() => resolveWorkdir(join(s.projectsRoot, '..', '..', 'elsewhere'), null, s.ctx))).toBe('WORKDIR_NOT_ALLOWED:outside_roots')
    const link = join(s.projectsRoot, 'link-out')
    symlinkSync(outside, link)
    expect(code(() => resolveWorkdir(link, null, s.ctx))).toBe('WORKDIR_NOT_ALLOWED:outside_roots')
    expect(code(() => resolveWorkdir(s.projectsRoot, null, s.ctx))).toBe('WORKDIR_NOT_ALLOWED:root_itself')
    expect(code(() => resolveWorkdir(s.stateDir, null, s.ctx))).toBe('WORKDIR_NOT_ALLOWED:denied')
    expect(code(() => resolveWorkdir(join(s.projectsRoot, 'nope'), null, s.ctx))).toBe('WORKDIR_NOT_ALLOWED:not_found')
    expect(code(() => resolveWorkdir('relative/path', null, s.ctx))).toBe('WORKDIR_NOT_ALLOWED:invalid_path')
  })

  test('requireGitWorktree', () => {
    const s = setup({ dynamicWorkdirs: { requireGitWorktree: true } })
    const wd = join(s.projectsRoot, 'plain')
    mkdirSync(wd)
    expect(code(() => resolveWorkdir(wd, null, s.ctx))).toBe('WORKDIR_NOT_ALLOWED:not_git')
    mkdirSync(join(wd, '.git'))
    expect(code(() => resolveWorkdir(wd, null, s.ctx))).toBe('ok')
  })

  test('a replaced directory is detected before dispatch', () => {
    const s = setup()
    const wd = join(s.projectsRoot, 'swap')
    mkdirSync(wd)
    const r = resolveWorkdir(wd, null, s.ctx)
    renameSync(wd, join(s.projectsRoot, 'swap-old'))
    mkdirSync(wd)
    expect(workdirUnchanged(r.identity)).toBe(false)
  })
})

describe('named projects', () => {
  test('projectId null inside a named project root gets that project rules', () => {
    const base = tempRoot('rtask-proj-')
    const home = join(base, 'home')
    const proj = join(home, 'Projects', 'app')
    mkdirSync(join(proj, 'sub'), { recursive: true })
    const stateDir = join(home, '.claude', 'channels', 'feishu')
    mkdirSync(stateDir, { recursive: true })
    const raw = taskServiceConfigSchema.parse({ enabled: true, projects: { app: { workdirRoots: [proj] } }, dynamicWorkdirs: { roots: [join(home, 'Projects')] } })
    const config = finalizeTaskServiceConfig(raw, { projects: { app: { workdir: proj, allowedAgents: ['opencode'] } }, allowedRoots: [join(home, 'Projects')], stateDir, home })
    const ctx: AccessContext = { config, stateDir, uid: process.getuid!(), home }
    const r = resolveWorkdir(join(proj, 'sub'), null, ctx)
    expect(r.workdirSource).toBe('project')
    expect(r.projectId).toBe('app')
    expect(r.allowedAgents).toEqual(['opencode'])
    expect(code(() => resolveWorkdir(join(proj, 'sub'), 'missing', ctx))).toBe('PROJECT_NOT_ALLOWED:')
  })
})

describe('config finalization', () => {
  test('rejects roots that contain home, the state dir, or are "/"', () => {
    const dir = tempRoot('rtask-cfg-')
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    const opts = { projects: {}, allowedRoots: [join(home, 'Projects')], stateDir: join(home, '.claude', 'channels', 'feishu'), home }
    for (const root of ['/', dir, home]) {
      const raw = taskServiceConfigSchema.parse({ dynamicWorkdirs: { roots: [root] } })
      expect(() => finalizeTaskServiceConfig(raw, opts)).toThrow(TaskServiceConfigError)
    }
    const unknownProject = taskServiceConfigSchema.parse({ projects: { x: {} } })
    expect(() => finalizeTaskServiceConfig(unknownProject, opts)).toThrow(/no such project/)
  })

  test('dangerous codex sandbox values are not representable', () => {
    expect(taskServiceConfigSchema.safeParse({ backends: { codex: { models: ['m'], sandbox: 'danger-full-access' } } }).success).toBe(false)
  })
})
