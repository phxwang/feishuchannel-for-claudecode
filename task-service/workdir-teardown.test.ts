import { describe, expect, test } from 'bun:test'
import type { TmuxCliManager } from '../tmux/manager'
import { teardownTaskScopedWorkdir } from './workdir-teardown'

function manager(kind: string, busy = false) {
  const kills: { workdir: string; forget?: boolean }[] = []
  const m = {
    profile: { kind },
    isBusy: () => busy,
    killSession: async (workdir: string, opts: { forget?: boolean } = {}) => { kills.push({ workdir, forget: opts.forget }) },
  }
  return { m: m as unknown as TmuxCliManager, kills }
}

describe('teardownTaskScopedWorkdir', () => {
  test('a temporary workdir: kills each tmux session (forgetting it) and releases the OpenCode binding', async () => {
    const claude = manager('claude')
    const codex = manager('codex')
    const released: string[] = []
    const r = await teardownTaskScopedWorkdir('/tmp/job', {
      configuredWorkdirs: () => ['/somewhere/else'], tmuxManagers: [claude.m, codex.m],
      releaseOpenCodeBinding: w => { released.push(w) }, log: () => {},
    })
    expect(r).toBe('released')
    expect(claude.kills).toEqual([{ workdir: '/tmp/job', forget: true }])
    expect(codex.kills).toEqual([{ workdir: '/tmp/job', forget: true }])
    expect(released).toEqual(['/tmp/job'])
  })

  test('a mapped workdir is left alone', async () => {
    const claude = manager('claude')
    const released: string[] = []
    const r = await teardownTaskScopedWorkdir('/tmp/job', {
      configuredWorkdirs: () => [undefined, '/tmp/job'], tmuxManagers: [claude.m],
      releaseOpenCodeBinding: w => { released.push(w) }, log: () => {},
    })
    expect(r).toBe('mapped')
    expect(claude.kills).toEqual([])
    expect(released).toEqual([])
  })

  test('a session that is busy again is not killed; a failing kill does not stop the rest', async () => {
    const busy = manager('claude', true)
    const failing = { profile: { kind: 'agy' }, isBusy: () => false, killSession: async () => { throw new Error('boom') } } as unknown as TmuxCliManager
    const codex = manager('codex')
    const logs: string[] = []
    await teardownTaskScopedWorkdir('/tmp/job', { configuredWorkdirs: () => [], tmuxManagers: [busy.m, failing, codex.m], log: l => { logs.push(l) } })
    expect(busy.kills).toEqual([])
    expect(codex.kills).toHaveLength(1)
    expect(logs.some(l => l.includes('busy again'))).toBe(true)
    expect(logs.some(l => l.includes('boom'))).toBe(true)
  })
})
