import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadRouterConfig, resolveOpenCodeConfig, RouterConfigError, validateRouterConfig } from './config'

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agents-cfg-'))
  mkdirSync(join(dir, 'proj'), { recursive: true })
  // Canonicalize so assertions comparing against join(root, ...) match the
  // realpath'd workdir validateRouterConfig stores (macOS /var vs /private/var).
  return realpathSync(dir)
}

function baseConfig(root: string) {
  return {
    version: 1,
    defaults: { agent: { primary: 'claude', fallback: null }, routingKey: 'chat', stickyBackend: true },
    projects: { proj: { workdir: join(root, 'proj'), allowedAgents: ['claude', 'opencode'] } },
    fallback: { enabled: true, triggerOn: [], neverTriggerOn: [], maxAttempts: 1, cooldownSeconds: 300, notifyUser: true },
  }
}

describe('validateRouterConfig', () => {
  test('accepts a minimal valid config', () => {
    const root = tmpRoot()
    const cfg = validateRouterConfig(baseConfig(root), [root])
    expect(cfg.defaults.agent).toEqual({ primary: 'claude', fallback: null })
    expect(cfg.projects.proj.workdir).toBe(join(root, 'proj'))
  })

  test('rejects relative workdir', () => {
    const root = tmpRoot()
    const raw = baseConfig(root)
    raw.projects.proj.workdir = 'relative/path'
    expect(() => validateRouterConfig(raw, [root])).toThrow(RouterConfigError)
  })

  test('rejects workdir outside allowed roots', () => {
    const root = tmpRoot()
    const other = tmpRoot()
    const raw = baseConfig(root)
    expect(() => validateRouterConfig(raw, [other])).toThrow(RouterConfigError)
  })

  test('rejects primary === fallback', () => {
    const root = tmpRoot()
    const raw: any = baseConfig(root)
    raw.defaults.agent = { primary: 'claude', fallback: 'claude' }
    expect(() => validateRouterConfig(raw, [root])).toThrow(RouterConfigError)
  })

  test('rejects malformed schema (missing version)', () => {
    const root = tmpRoot()
    const raw: any = baseConfig(root)
    delete raw.version
    expect(() => validateRouterConfig(raw, [root])).toThrow(RouterConfigError)
  })

  test('accepts per-project opencode feature-flag overrides', () => {
    const root = tmpRoot()
    const raw: any = baseConfig(root)
    raw.projects.proj.opencode = { nativeV2: true, progressCards: true, model: 'deepseek/deepseek-flash' }
    const cfg = validateRouterConfig(raw, [root])
    expect(cfg.projects.proj.opencode).toEqual({ nativeV2: true, progressCards: true, model: 'deepseek/deepseek-flash' })
    expect(cfg.projects.proj.allowedAgents).toEqual(['claude', 'opencode'])
  })

  test('resolves per-project opencode overrides by workdir (routes carry the workdir, not the project key)', () => {
    const root = tmpRoot()
    const raw: any = baseConfig(root)
    raw.agents = { opencode: { type: 'opencode', baseUrl: 'http://127.0.0.1:4096', requestTimeoutSeconds: 30, taskTimeoutSeconds: 600, maxConcurrency: 4, nativeV2: false, progressCards: false } }
    raw.projects.proj.opencode = { nativeV2: true, progressCards: true, model: 'deepseek/deepseek-flash' }
    const cfg = validateRouterConfig(raw, [root])
    for (const workdir of [join(root, 'proj'), join(root, 'proj') + '/']) {
      const effective = resolveOpenCodeConfig(cfg, workdir)
      expect(effective?.nativeV2).toBe(true)
      expect(effective?.progressCards).toBe(true)
      expect(effective?.streamText).toBe(false)
      expect(effective?.model).toBe('deepseek/deepseek-flash')
      expect(effective?.taskTimeoutSeconds).toBe(600)
    }
    const globalOnly = resolveOpenCodeConfig(cfg, join(root, 'elsewhere'))
    expect(globalOnly?.nativeV2).toBe(false)
    expect(globalOnly?.progressCards).toBe(false)
  })

  test('rejects non-boolean per-project opencode overrides', () => {
    const root = tmpRoot()
    const raw: any = baseConfig(root)
    raw.projects.proj.opencode = { nativeV2: 'yes' }
    expect(() => validateRouterConfig(raw, [root])).toThrow(RouterConfigError)
  })

  test('does not require defaults.agent to be valid for any specific project — that is checked per-chat at resolve time', () => {
    const root = tmpRoot()
    const raw: any = baseConfig(root)
    raw.projects.proj.allowedAgents = ['claude'] // opencode not allowed for this project...
    raw.defaults.agent = { primary: 'opencode', fallback: null } // ...but that's fine at load time
    expect(() => validateRouterConfig(raw, [root])).not.toThrow()
  })
})

describe('loadRouterConfig', () => {
  test('returns null when file does not exist (legacy-only mode)', () => {
    const root = tmpRoot()
    expect(loadRouterConfig(join(root, 'no-such-agents.yaml'), [root])).toBeNull()
  })

  test('parses a real YAML file from disk', () => {
    const root = tmpRoot()
    const yamlPath = join(root, 'agents.yaml')
    writeFileSync(yamlPath, `
version: 1
defaults:
  agent:
    primary: claude
    fallback: null
projects:
  proj:
    workdir: ${join(root, 'proj')}
    allowedAgents: [claude]
`)
    const cfg = loadRouterConfig(yamlPath, [root])
    expect(cfg?.projects.proj.allowedAgents).toEqual(['claude'])
  })

  test('throws (fail-closed) on malformed YAML rather than falling back silently', () => {
    const root = tmpRoot()
    const yamlPath = join(root, 'agents.yaml')
    writeFileSync(yamlPath, 'defaults: [this is not, a valid config')
    expect(() => loadRouterConfig(yamlPath, [root])).toThrow()
  })
})

test('native insertion/progress/text require explicit opt-in and accept independent flags', () => {
  const root = tmpRoot()
  const raw: any = { ...baseConfig(root), agents: { opencode: { type: 'opencode', baseUrl: 'http://localhost:4096',
    requestTimeoutSeconds: 10, taskTimeoutSeconds: 3600, maxConcurrency: 4 } } }
  const legacy = validateRouterConfig(raw, [root]).agents.opencode!
  expect([legacy.nativeV2, legacy.progressCards, legacy.streamText]).toEqual([false, false, false])
  raw.agents.opencode.nativeV2 = true; raw.agents.opencode.progressCards = true
  const native = validateRouterConfig(raw, [root]).agents.opencode!
  expect([native.nativeV2, native.progressCards, native.streamText]).toEqual([true, true, false])
})
