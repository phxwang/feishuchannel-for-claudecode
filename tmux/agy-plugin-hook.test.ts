import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const HOOK = join(import.meta.dir, '..', 'agy-plugin', 'hook.sh')

function runHook(event: string, payload: string, env: Record<string, string>) {
  const proc = Bun.spawnSync(['sh', HOOK, event], { stdin: Buffer.from(payload), env: { PATH: process.env.PATH ?? '', ...env } })
  return { code: proc.exitCode, stdout: proc.stdout.toString() }
}

describe('agy-plugin hook.sh', () => {
  test('is a no-op outside router-spawned sessions (no signal dir env)', () => {
    expect(runHook('Stop', '{"conversationId":"c"}', {})).toEqual({ code: 0, stdout: '{}\n' })
  })

  test('is a no-op when the signal dir does not exist', () => {
    expect(runHook('Stop', '{}', { FEISHU_AGY_SIGNAL_DIR: '/nonexistent/feishu-agy' })).toEqual({ code: 0, stdout: '{}\n' })
  })

  test('writes <Event>.json and last.json atomically, answering {}', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-hook-'))
    const payload = '{"conversationId":"c1","fullyIdle":true}'
    expect(runHook('Stop', payload, { FEISHU_AGY_SIGNAL_DIR: dir })).toEqual({ code: 0, stdout: '{}\n' })
    expect(readFileSync(join(dir, 'Stop.json'), 'utf8')).toBe(payload)
    expect(readFileSync(join(dir, 'last.json'), 'utf8')).toBe(payload)
    expect(readdirSync(dir).filter(n => n.startsWith('.'))).toEqual([])  // no temp files left behind
  })

  test('ignores unknown or unsafe event names (no path traversal)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-hook-'))
    expect(runHook('../evil', '{}', { FEISHU_AGY_SIGNAL_DIR: dir }).stdout).toBe('{}\n')
    expect(runHook('PreToolUse', '{}', { FEISHU_AGY_SIGNAL_DIR: dir }).stdout).toBe('{}\n')
    expect(readdirSync(dir)).toEqual([])
    expect(existsSync(join(dir, '..', 'evil.json'))).toBe(false)
  })

  test('hooks.json never registers PreToolUse (agy reads {} as deny)', () => {
    const hooks = JSON.parse(readFileSync(join(import.meta.dir, '..', 'agy-plugin', 'hooks.json'), 'utf8'))
    expect(Object.keys(hooks['feishu-router']).sort()).toEqual(['PostToolUse', 'SessionStart', 'Stop'])
  })
})
