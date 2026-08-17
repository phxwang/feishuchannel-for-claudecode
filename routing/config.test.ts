import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadRouterConfig, RouterConfigError, validateRouterConfig } from './config'

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agents-cfg-'))
  mkdirSync(join(dir, 'proj'), { recursive: true })
  return dir
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
