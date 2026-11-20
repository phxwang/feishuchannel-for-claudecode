/**
 * Integration tests: the real TmuxCliManager + agy profile driving a fake
 * agy CLI (tmux/test-fixtures/fake-agy.ts) inside real tmux sessions.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TmuxCliManager, matchStoppedOwner } from './manager'
import { createAgyProfile } from './profiles/agy'
import type { Dialog } from './dialog'

const FAKE = join(import.meta.dir, 'test-fixtures', 'fake-agy.ts')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-mgr-')))
const brainDir = join(root, 'brain')
const signalRoot = join(root, 'signals')
const managers: { m: TmuxCliManager; workdirs: string[] }[] = []

function setup(bin: string | string[] = [process.execPath, FAKE, '--brain', brainDir], extra: Record<string, number> = {}) {
  const store = new Map<string, string>()
  const persistence = { get: (w: string) => store.get(w), set: (w: string, id: string) => { store.set(w, id) }, delete: (w: string) => { store.delete(w) } }
  const m = new TmuxCliManager(createAgyProfile({ bin, brainDir, signalRoot }), {
    persistence, postStopQuietMs: 200, dialogCheckMs: 300, startupTimeoutMs: 8_000, replyTimeoutMs: 60_000, ...extra,
  })
  const workdir = realpathSync(mkdtempSync(join(root, 'w-')))
  managers.push({ m, workdirs: [workdir] })
  return { m, workdir, store }
}

afterAll(async () => {
  for (const { m, workdirs } of managers) for (const w of workdirs) await m.killSession(w)
})

describe('matchStoppedOwner', () => {
  test('matches the queued owner whose input agy reports', () => {
    expect(matchStoppedOwner(['one', 'two', 'three'], 'two')).toBe(1)
    expect(matchStoppedOwner(['one', 'two'], '  two\n')).toBe(1)
  })
  test('defaults to the head when the stop carries no usable input', () => {
    expect(matchStoppedOwner(['one', 'two'], undefined)).toBe(0)
    expect(matchStoppedOwner(['one', 'two'], 'something else')).toBe(0)
  })
  test('exact match only: a short input never settles a longer queued one', () => {
    expect(matchStoppedOwner(['继续', '继续做X'], '继续')).toBe(0)
    expect(matchStoppedOwner(['ok', 'ok then'], 'ok')).toBe(0)
  })
  test('a repeated message settles every earlier identical owner', () => {
    expect(matchStoppedOwner(['same', 'same', 'other'], 'same')).toBe(1)
  })
})

describe('TmuxCliManager + agy profile (fake agy in real tmux)', () => {
  test('delivers a message, streams its reply, and learns the conversation id', async () => {
    const { m, workdir, store } = setup()
    const chunks: string[] = []
    const reply = await m.sendAndAwaitReply(workdir, 'hello', { onTextChunk: t => chunks.push(t) })
    expect(reply).toBe('ECHO: hello')
    expect(chunks).toEqual(['ECHO: hello'])
    expect(store.get(workdir)).toMatch(/^[0-9a-f-]{36}$/)
  }, 20_000)

  test('a message sent mid-turn is queued and gets its own reply', async () => {
    const { m, workdir } = setup()
    const events: string[] = []
    const first = m.sendAndAwaitReply(workdir, 'SLOW 2500 one', { onTextChunk: t => events.push(`1:${t}`) })
    while (!m.isBusy(workdir)) await Bun.sleep(50)
    await Bun.sleep(1200)  // well inside the first turn
    const second = m.sendAndAwaitReply(workdir, 'two', {
      onQueued: () => events.push('queued'),
      onTurnStarted: () => events.push('started'),
      onTextChunk: t => events.push(`2:${t}`),
    })
    expect(await first).toBe('ECHO: one')
    expect(await second).toBe('ECHO: two')
    expect(events).toEqual(['queued', '1:ECHO: one', 'started', '2:ECHO: two'])
  }, 30_000)

  test('a message sent while the head is still spawning never overtakes it', async () => {
    const { m, workdir } = setup()
    const first = m.sendAndAwaitReply(workdir, 'one')
    const second = m.sendAndAwaitReply(workdir, 'two')  // same tick: the head hasn't even been pasted yet
    expect(await first).toBe('ECHO: one')
    expect(await second).toBe('ECHO: two')
  }, 30_000)

  test('without the hook plugin, the wait ends once agy sits idle instead of hanging', async () => {
    const { m, workdir } = setup([process.execPath, FAKE, '--brain', brainDir, '--no-hooks'])
    const errors: string[] = []
    const started = Date.now()
    const reply = await m.sendAndAwaitReply(workdir, 'hello', { onStopError: e => errors.push(e) })
    expect(reply).toBe('')  // no transcript is discoverable without hooks
    expect(errors[0]).toContain('agy plugin install')
    expect(Date.now() - started).toBeLessThan(40_000)
  }, 45_000)

  test('keeps collecting after a stop that left background work running', async () => {
    const { m, workdir } = setup()
    expect(await m.sendAndAwaitReply(workdir, 'BG job')).toBe('ECHO: job\n\nBG DONE')
  }, 20_000)

  test('a permission menu is offered to onDialog and answered with the bare digit', async () => {
    const { m, workdir } = setup()
    const seen: Dialog[] = []
    const reply = await m.sendAndAwaitReply(workdir, 'ASK', { onDialog: async d => { seen.push(d); return 2 } })
    expect(reply).toBe('CHOSE 2')
    expect(seen[0].kind).toBe('numbered')
    expect(seen[0].options.map(o => o.label)).toEqual(['Yes, run command', 'No, cancel'])
  }, 20_000)

  test('an idle-killed session resumes the same conversation on the next message', async () => {
    const { m, workdir, store } = setup()
    await m.sendAndAwaitReply(workdir, 'first')
    const id = store.get(workdir)
    await m.killIdleSessions(0)
    expect(store.get(workdir)).toBe(id)  // kept for --conversation
    expect(await m.sendAndAwaitReply(workdir, 'again')).toBe('ECHO: again')
    expect(store.get(workdir)).toBe(id)
  }, 30_000)

  test('a fresh restart forgets the conversation', async () => {
    const { m, workdir, store } = setup()
    await m.sendAndAwaitReply(workdir, 'first')
    const id = store.get(workdir)
    await m.restartSession(workdir, {}, true)
    await m.sendAndAwaitReply(workdir, 'second')
    expect(store.get(workdir)).not.toBe(id)
  }, 30_000)

  test('a slash command that never starts a turn (/model + Esc) ends once agy is idle again', async () => {
    const { m, workdir } = setup()
    await m.ensureSession(workdir)
    const seen: string[] = []
    const started = Date.now()
    const reply = await m.sendAndAwaitReply(workdir, '/model', { onDialog: async d => { seen.push(d.kind); return 0 /* Esc */ } })
    expect(reply).toBe('')
    expect(seen).toEqual(['cursor'])
    expect(Date.now() - started).toBeLessThan(15_000)
    // The session is still usable afterwards.
    expect(await m.sendAndAwaitReply(workdir, 'after')).toBe('ECHO: after')
  }, 30_000)

  test('a CLI that dies during startup rejects before delivery (safe to fall back)', async () => {
    const { m, workdir } = setup('/nonexistent/agy-binary')
    await expect(m.sendAndAwaitReply(workdir, 'hello')).rejects.toThrow()
  }, 20_000)
})
