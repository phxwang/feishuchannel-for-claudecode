import { describe, expect, test } from 'bun:test'
import { resolveRoute, type LegacyAccess } from './resolver'
import type { RouterConfig } from './types'

const config: RouterConfig = {
  version: 1,
  defaults: { project: 'inv', agent: { primary: 'claude', fallback: null }, routingKey: 'chat', stickyBackend: true },
  agents: {},
  projects: {
    inv: { workdir: '/Users/openclaw/Projects/inv', allowedAgents: ['claude', 'opencode'] },
    feishuchannel: { workdir: '/Users/openclaw/Projects/feishuchannel', allowedAgents: ['claude', 'opencode'] },
  },
  routes: {
    dms: {},
    groups: {
      oc_group_for_inv: { project: 'inv', requireMention: true, agent: { primary: 'claude', fallback: 'opencode' } },
      oc_group_for_opencode: { project: 'feishuchannel', agent: { primary: 'opencode', fallback: null } },
    },
  },
  fallback: { enabled: true, triggerOn: [], neverTriggerOn: [], maxAttempts: 1, cooldownSeconds: 300, notifyUser: true },
}

const legacy: LegacyAccess = {
  groups: { oc_legacy: { workdir: '/Users/openclaw/Projects/inv1', requireMention: false } },
  defaultWorkdir: '/Users/openclaw/Projects/inv',
}

describe('resolveRoute', () => {
  test('explicit group route wins over defaults', () => {
    const r = resolveRoute({ chatType: 'group', chatId: 'oc_group_for_opencode' }, config, legacy)
    expect(r?.source).toBe('explicit_route')
    expect(r?.agent.primary).toBe('opencode')
    expect(r?.project).toBe('feishuchannel')
  })

  test('thread override wins over explicit route', () => {
    const r = resolveRoute(
      { chatType: 'group', chatId: 'oc_group_for_inv', threadOverride: { project: 'feishuchannel', agent: { primary: 'opencode', fallback: null } } },
      config, legacy,
    )
    expect(r?.source).toBe('thread_override')
    expect(r?.project).toBe('feishuchannel')
  })

  test('falls back to defaults when chat has no explicit route but config exists', () => {
    const r = resolveRoute({ chatType: 'group', chatId: 'oc_unconfigured' }, config, legacy)
    expect(r?.source).toBe('defaults')
    expect(r?.project).toBe('inv')
  })

  test('falls back to legacy access.json when no router.yaml at all', () => {
    const r = resolveRoute({ chatType: 'group', chatId: 'oc_legacy' }, null, legacy)
    expect(r?.source).toBe('legacy_access')
    expect(r?.agent).toEqual({ primary: 'claude', fallback: null })
    expect(r?.workdir).toBe('/Users/openclaw/Projects/inv1')
  })

  test('legacy p2p falls back to defaultWorkdir', () => {
    const r = resolveRoute({ chatType: 'p2p', chatId: 'ou_someone' }, null, legacy)
    expect(r?.workdir).toBe('/Users/openclaw/Projects/inv')
    expect(r?.source).toBe('legacy_access')
  })

  test('returns null (fail closed) when nothing matches', () => {
    const noDefault: LegacyAccess = { groups: {} }
    const r = resolveRoute({ chatType: 'group', chatId: 'oc_unknown' }, null, noDefault)
    expect(r).toBeNull()
  })
})
