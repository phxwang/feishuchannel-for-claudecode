import { describe, expect, test } from 'bun:test'
import { resolveRoute, type LegacyAccess } from './resolver'
import type { RouterConfig } from './types'

const infra: RouterConfig = {
  version: 1,
  defaults: { agent: { primary: 'claude', fallback: null }, routingKey: 'chat', stickyBackend: true },
  agents: {},
  projects: {
    inv: { workdir: '/Users/openclaw/Projects/inv', allowedAgents: ['claude', 'opencode'] },
    feishuchannel: { workdir: '/Users/openclaw/Projects/feishuchannel', allowedAgents: ['claude', 'opencode'] },
    inv1: { workdir: '/Users/openclaw/Projects/inv1', allowedAgents: ['claude'] }, // opencode NOT allowed here
  },
  fallback: { enabled: true, triggerOn: [], neverTriggerOn: [], maxAttempts: 1, cooldownSeconds: 300, notifyUser: true },
}

const access: LegacyAccess = {
  groups: {
    oc_opencode_group: { workdir: '/Users/openclaw/Projects/feishuchannel', agent: { primary: 'opencode', fallback: null } },
    oc_claude_only_group: { workdir: '/Users/openclaw/Projects/inv', requireMention: false },
    oc_untrusted_group: { workdir: '/Users/openclaw/Projects/inv1', agent: { primary: 'opencode', fallback: null } }, // requests opencode, but inv1 doesn't allow it
    oc_unknown_project_group: { workdir: '/Users/openclaw/Projects/not-declared-anywhere', agent: { primary: 'opencode', fallback: null } },
  },
  defaultWorkdir: '/Users/openclaw/Projects/inv',
}

describe('resolveRoute — project always comes from access.json', () => {
  test('group with an explicit agent override uses it (when infra allows it)', () => {
    const r = resolveRoute({ chatType: 'group', chatId: 'oc_opencode_group' }, infra, access)
    expect(r?.source).toBe('access_json')
    expect(r?.project).toBe('/Users/openclaw/Projects/feishuchannel')
    expect(r?.agent).toEqual({ primary: 'opencode', fallback: null })
  })

  test('group with no agent override falls back to infra defaults.agent', () => {
    const r = resolveRoute({ chatType: 'group', chatId: 'oc_claude_only_group' }, infra, access)
    expect(r?.agent).toEqual({ primary: 'claude', fallback: null })
    expect(r?.requireMention).toBe(false)
  })

  test('thread override wins over the access.json entry', () => {
    const r = resolveRoute(
      { chatType: 'group', chatId: 'oc_claude_only_group', threadOverride: { project: 'feishuchannel', agent: { primary: 'opencode', fallback: null } } },
      infra, access,
    )
    expect(r?.source).toBe('thread_override')
    expect(r?.project).toBe('feishuchannel')
  })

  test('unconfigured chat falls back to defaultWorkdir', () => {
    const r = resolveRoute({ chatType: 'group', chatId: 'oc_never_seen' }, infra, access)
    expect(r?.workdir).toBe('/Users/openclaw/Projects/inv')
  })

  test('p2p uses defaultWorkdir', () => {
    const r = resolveRoute({ chatType: 'p2p', chatId: 'ou_someone' }, infra, access)
    expect(r?.workdir).toBe('/Users/openclaw/Projects/inv')
  })

  test('returns null (fail closed) when nothing matches', () => {
    const noDefault: LegacyAccess = { groups: {} }
    expect(resolveRoute({ chatType: 'group', chatId: 'oc_unknown' }, infra, noDefault)).toBeNull()
  })
})

describe('resolveRoute — sanitizes an access.json agent request against infra whitelist (fail closed, not startup-time)', () => {
  test('requested agent not in that project.allowedAgents -> falls back to Claude-only', () => {
    const r = resolveRoute({ chatType: 'group', chatId: 'oc_untrusted_group' }, infra, access)
    expect(r?.agent).toEqual({ primary: 'claude', fallback: null })
  })

  test('workdir not declared in infra projects at all -> falls back to Claude-only', () => {
    const r = resolveRoute({ chatType: 'group', chatId: 'oc_unknown_project_group' }, infra, access)
    expect(r?.agent).toEqual({ primary: 'claude', fallback: null })
  })

  test('no infra config at all -> always Claude-only regardless of access.json agent field', () => {
    const r = resolveRoute({ chatType: 'group', chatId: 'oc_opencode_group' }, null, access)
    expect(r?.agent).toEqual({ primary: 'claude', fallback: null })
  })

  test('requested fallback not allowed, but primary is -> keeps primary, drops fallback', () => {
    const withFallback: LegacyAccess = {
      groups: { oc_g: { workdir: '/Users/openclaw/Projects/inv1', agent: { primary: 'claude', fallback: 'opencode' } } },
    }
    const r = resolveRoute({ chatType: 'group', chatId: 'oc_g' }, infra, withFallback)
    expect(r?.agent).toEqual({ primary: 'claude', fallback: null })
  })
})
