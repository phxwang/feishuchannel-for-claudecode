/**
 * Integration tests: the real TmuxCliManager + Claude profile driving a fake
 * claude CLI (tmux/test-fixtures/fake-claude.ts) inside a real tmux session.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TmuxCliManager } from './manager'
import { claudeProfile, isLocalCommandResultLine } from './profiles/claude'
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

describe('TmuxCliManager + Claude profile (fake claude in real tmux)', () => {
  test('a local slash command (no Stop hook) finishes instead of blocking the session', async () => {
    const { m, workdir } = setup()
    const startedAt = Date.now()
    expect(await m.sendAndAwaitReply(workdir, '/model')).toBe('Kept model as `Opus`')
    expect(Date.now() - startedAt).toBeLessThan(15_000)
    expect(m.isBusy(workdir)).toBe(false)
    // The next message goes through normally.
    expect(await m.sendAndAwaitReply(workdir, 'hello')).toBe('ECHO: hello')
  }, 30_000)
})
