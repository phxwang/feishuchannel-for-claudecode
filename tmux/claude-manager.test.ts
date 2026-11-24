/**
 * Integration tests: the real TmuxCliManager + Claude profile driving a fake
 * claude CLI (tmux/test-fixtures/fake-claude.ts) inside a real tmux session.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TmuxCliManager } from './manager'
import { claudeProfile, isInterruptLine, isLocalCommandResultLine } from './profiles/claude'
import type { TmuxCliProfile } from './profile'

const FAKE = join(import.meta.dir, 'test-fixtures', 'fake-claude.ts')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-mgr-')))
const managers: { m: TmuxCliManager; workdir: string }[] = []

/** The real Claude profile, with the binary and file locations pointed at the fake. */
function setup() {
  const workdir = realpathSync(mkdtempSync(join(root, 'w-')))
  const transcript = join(root, `${workdir.split('/').pop()}.jsonl`)
  const stopSignal = join(root, `${workdir.split('/').pop()}.stop`)
  const profile: TmuxCliProfile = {
    ...claudeProfile,
    sessionName: (w: string) => `${claudeProfile.sessionName(w)}-test`,
    prepareSpawn: () => {},
    planSpawn: () => ({ argv: [process.execPath, FAKE, transcript, stopSignal], env: {}, sessionId: 'test-session' }),
    transcriptPath: () => transcript,
    findLatestTranscript: () => transcript,
    stopSignalPath: () => stopSignal,
    afterStop: () => ({ wait: 'done' }),
  }
  const m = new TmuxCliManager(profile, { postStopQuietMs: 200, dialogCheckMs: 300, startupTimeoutMs: 8_000, replyTimeoutMs: 60_000 })
  managers.push({ m, workdir })
  return { m, workdir }
}

afterAll(async () => {
  for (const { m, workdir } of managers) await m.killSession(workdir)
})

describe('isLocalCommandResultLine', () => {
  test('matches both recorded shapes of a local command result', () => {
    expect(isLocalCommandResultLine(JSON.stringify({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>Kept model as `Opus`</local-command-stdout>' }))).toBe(true)
    expect(isLocalCommandResultLine(JSON.stringify({ type: 'user', message: { content: '<local-command-stderr>nope</local-command-stderr>' } }))).toBe(true)
  })
  test('ignores the command-name record, assistant text quoting the tag, and malformed lines', () => {
    expect(isLocalCommandResultLine(JSON.stringify({ type: 'system', subtype: 'local_command', content: '<command-name>/model</command-name>' }))).toBe(false)
    expect(isLocalCommandResultLine(JSON.stringify({ type: 'assistant', message: { content: '<local-command-stdout>x</local-command-stdout>' } }))).toBe(false)
    expect(isLocalCommandResultLine('{"type":"system","subtype":"local_command","content":"<local-command-stdout>')).toBe(false)
  })
})

describe('isInterruptLine', () => {
  const user = (content: unknown) => JSON.stringify({ type: 'user', message: { role: 'user', content } })
  test('matches the record Claude Code writes when a turn is interrupted', () => {
    expect(isInterruptLine(user([{ type: 'text', text: '[Request interrupted by user]' }]))).toBe(true)
    expect(isInterruptLine(user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]))).toBe(true)
    expect(isInterruptLine(user('[Request interrupted by user]'))).toBe(true)
  })
  test('ignores assistant text or user prose that merely mentions it, and malformed lines', () => {
    expect(isInterruptLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }))).toBe(false)
    expect(isInterruptLine(user('why did I see [Request interrupted by user] earlier?'))).toBe(false)
    expect(isInterruptLine('{"type":"user","message":{"content":"[Request interrupted by user]')).toBe(false)
  })
})

describe('TmuxCliManager + Claude profile (fake claude in real tmux)', () => {
  test('an interrupted turn (Escape, no Stop hook) ends the reply wait instead of holding the session', async () => {
    const { m, workdir } = setup()
    const ends: string[] = []
    const done = m.sendAndAwaitReply(workdir, 'hang build', { onWaitEnded: reason => { ends.push(reason) } })
    await new Promise(r => setTimeout(r, 1_500))
    expect(m.isBusy(workdir)).toBe(true)
    const escapedAt = Date.now()
    await m.sendEscape(workdir)
    expect(await done).toBe('WORKING: build')
    expect(Date.now() - escapedAt).toBeLessThan(5_000)
    expect(ends).toEqual(['interrupted'])
    expect(m.isBusy(workdir)).toBe(false)
    expect(await m.sendAndAwaitReply(workdir, 'after')).toBe('ECHO: after')
  }, 30_000)

  test('a local slash command (no Stop hook) finishes instead of blocking the session', async () => {
    const { m, workdir } = setup()
    const startedAt = Date.now()
    expect(await m.sendAndAwaitReply(workdir, '/model')).toBe('Kept model as `Opus`')
    expect(Date.now() - startedAt).toBeLessThan(15_000)
    expect(m.isBusy(workdir)).toBe(false)
    // The next message goes through normally.
    expect(await m.sendAndAwaitReply(workdir, 'hello')).toBe('ECHO: hello')
  }, 30_000)

  test('a native /goal is followed through its self-continued turns until achieved, not cut at the first Stop', async () => {
    const { m, workdir } = setup()
    const ends: { reason: string; goal?: string }[] = []
    const reply = await m.sendAndAwaitReply(workdir, '/goal turns=3 finish', { onWaitEnded: (reason, info) => { ends.push({ reason, goal: info?.goal }) } })
    expect(reply).toBe('Goal set: turns=3 finish\n\nWORK 1\n\nWORK 2\n\nWORK 3')
    expect(ends).toEqual([{ reason: 'stop', goal: 'achieved' }])
    expect(m.isBusy(workdir)).toBe(false)
  }, 40_000)

  test('an active goal that will not finish keeps the wait open until it is cleared', async () => {
    const { m, workdir } = setup()
    const ends: { reason: string; goal?: string }[] = []
    const done = m.sendAndAwaitReply(workdir, '/goal hold never', { onWaitEnded: (reason, info) => { ends.push({ reason, goal: info?.goal }) } })
    await new Promise(r => setTimeout(r, 6_000))
    expect(ends).toEqual([])
    expect(m.isBusy(workdir)).toBe(true)
    expect(await m.sendLine(workdir, '/goal clear')).toBe(true)
    expect(await done).toBe('Goal set: hold never\n\nWORK 1\n\nGoal cleared: c')
    expect(ends).toEqual([{ reason: 'stop', goal: 'cleared' }])
  }, 40_000)

  test('an ordinary message reports no goal', async () => {
    const { m, workdir } = setup()
    const ends: { reason: string; goal?: string }[] = []
    expect(await m.sendAndAwaitReply(workdir, 'hi', { onWaitEnded: (reason, info) => { ends.push({ reason, goal: info?.goal }) } })).toBe('ECHO: hi')
    expect(ends).toEqual([{ reason: 'stop', goal: 'none' }])
  }, 30_000)
})
