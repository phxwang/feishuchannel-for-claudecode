import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveAgySpawnOptions, RouterConfigError, validateRouterConfig } from './config'
import { resolveRoute, type LegacyAccess } from './resolver'

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cfg-'))
  mkdirSync(join(dir, 'proj'), { recursive: true })
  mkdirSync(join(dir, 'other'), { recursive: true })
  return realpathSync(dir)
}

function config(root: string, extra: Record<string, unknown> = {}, projectExtra: Record<string, unknown> = {}) {
  return {
    version: 1,
    defaults: { agent: { primary: 'claude', fallback: null } },
    projects: {
      proj: { workdir: join(root, 'proj'), allowedAgents: ['claude', 'opencode', 'agy'], ...projectExtra },
      other: { workdir: join(root, 'other'), allowedAgents: ['claude'] },
    },
    ...extra,
  }
}

describe('agents.yaml — agy backend', () => {
  test('agy is accepted in allowedAgents with no agents.agy block at all (zero config)', () => {
    const root = tmpRoot()
    const cfg = validateRouterConfig(config(root), [root])
    expect(cfg.projects.proj.allowedAgents).toContain('agy')
    expect(cfg.agents.agy).toBeUndefined()
  })

  test('agy is accepted as a default primary and as a fallback', () => {
    const root = tmpRoot()
    const cfg = validateRouterConfig(config(root, { defaults: { agent: { primary: 'claude', fallback: 'agy' } } }), [root])
    expect(cfg.defaults.agent.fallback).toBe('agy')
    const cfg2 = validateRouterConfig(config(root, { defaults: { agent: { primary: 'agy', fallback: 'opencode' } } }), [root])
    expect(cfg2.defaults.agent.primary).toBe('agy')
  })

  test('rejects fallback equal to primary for agy too', () => {
    const root = tmpRoot()
    expect(() => validateRouterConfig(config(root, { defaults: { agent: { primary: 'agy', fallback: 'agy' } } }), [root])).toThrow(RouterConfigError)
  })

  test('accepts optional global and per-project agy settings', () => {
    const root = tmpRoot()
    const cfg = validateRouterConfig(config(root,
      { agents: { agy: { bin: '/opt/agy', model: 'gemini-3.8-flash-high', effort: 'medium', permissionMode: 'accept-edits' } } },
      { agy: { model: 'claude-opus-4-6-thinking', effort: 'high' } },
    ), [root])
    expect(cfg.agents.agy?.bin).toBe('/opt/agy')
    expect(cfg.projects.proj.agy?.model).toBe('claude-opus-4-6-thinking')
  })

  test('rejects an unknown permissionMode or effort', () => {
    const root = tmpRoot()
    expect(() => validateRouterConfig(config(root, { agents: { agy: { permissionMode: 'yolo' } } }), [root])).toThrow(RouterConfigError)
    expect(() => validateRouterConfig(config(root, {}, { agy: { effort: 'extreme' } }), [root])).toThrow(RouterConfigError)
  })
})

describe('resolveAgySpawnOptions — chat > project > global > agy default', () => {
  test('everything unset means no flags (agy defaults)', () => {
    const root = tmpRoot()
    const cfg = validateRouterConfig(config(root), [root])
    expect(resolveAgySpawnOptions(cfg, join(root, 'proj'), {})).toEqual({})
    expect(resolveAgySpawnOptions(null, join(root, 'proj'), {})).toEqual({})
  })

  test('project overrides global, chat overrides project', () => {
    const root = tmpRoot()
    const cfg = validateRouterConfig(config(root,
      { agents: { agy: { model: 'global-model', effort: 'low', permissionMode: 'plan' } } },
      { agy: { model: 'project-model' } },
    ), [root])
    expect(resolveAgySpawnOptions(cfg, join(root, 'proj'), {})).toEqual({ model: 'project-model', effort: 'low', permissionMode: 'plan' })
    expect(resolveAgySpawnOptions(cfg, join(root, 'proj'), { model: 'chat-model', effort: 'max' })).toEqual({ model: 'chat-model', effort: 'max', permissionMode: 'plan' })
    // A project without its own override inherits the global block only.
    expect(resolveAgySpawnOptions(cfg, join(root, 'other'), {})).toEqual({ model: 'global-model', effort: 'low', permissionMode: 'plan' })
  })
})

describe('resolveRoute — agy routes', () => {
  const root = '/Users/openclaw/Projects'
  const infra = validateRouterConfig({
    version: 1,
    defaults: { agent: { primary: 'claude', fallback: null } },
    projects: {
      inv4: { workdir: `${root}/inv4`, allowedAgents: ['claude', 'opencode', 'agy'] },
      inv1: { workdir: `${root}/inv1`, allowedAgents: ['claude', 'opencode'] },
    },
  }, [root])

  test('agy primary is kept when whitelisted, with its fallback', () => {
    const access: LegacyAccess = { groups: { oc_a: { workdir: `${root}/inv4`, agent: { primary: 'agy', fallback: 'opencode', model: 'm' } } } }
    const route = resolveRoute({ chatType: 'group', chatId: 'oc_a' }, infra, access)!
    expect(route.agent).toMatchObject({ primary: 'agy', fallback: 'opencode', model: 'm' })
    expect(route.agentSanitized).toBe(false)
  })

  test('agy primary is downgraded to Claude-only when the project does not allow it', () => {
    const access: LegacyAccess = { groups: { oc_b: { workdir: `${root}/inv1`, agent: { primary: 'agy', fallback: null } } } }
    const route = resolveRoute({ chatType: 'group', chatId: 'oc_b' }, infra, access)!
    expect(route.agent.primary).toBe('claude')
    expect(route.agentSanitized).toBe(true)
  })

  test('agy fallback is dropped when not whitelisted, claude primary kept', () => {
    const access: LegacyAccess = { groups: { oc_c: { workdir: `${root}/inv1`, agent: { primary: 'claude', fallback: 'agy', mode: 'tmux' } } } }
    const route = resolveRoute({ chatType: 'group', chatId: 'oc_c' }, infra, access)!
    expect(route.agent).toMatchObject({ primary: 'claude', fallback: null, mode: 'tmux' })
  })

  test('a non-string effort from access.json is dropped', () => {
    const access: LegacyAccess = { groups: { oc_d: { workdir: `${root}/inv4`, agent: { primary: 'agy', fallback: null, effort: 42 as unknown as string } } } }
    const route = resolveRoute({ chatType: 'group', chatId: 'oc_d' }, infra, access)!
    expect(route.agent.effort).toBeUndefined()
  })
})
