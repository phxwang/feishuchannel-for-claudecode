/**
 * Integration tests: the real TmuxCliManager + Codex profile driving a fake
 * Codex TUI (tmux/test-fixtures/fake-codex-tui.ts) inside real tmux sessions,
 * with the real notify bridge (codex-plugin/notify.sh).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TmuxCliManager } from './manager'
import { runTmux } from './tmux-exec'
import { createCodexProfile, codexSignalDirFor } from './profiles/codex'
import { findRollout } from './profiles/codex-rollout'
import type { Dialog } from './dialog'
import type { ProgressEvent } from './profile'

const FAKE = join(import.meta.dir, 'test-fixtures', 'fake-codex-tui.ts')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-mgr-')))
const home = join(root, 'codex-home')
const signalRoot = join(root, 'signals')
const managers: { m: TmuxCliManager; workdir: string }[] = []

function setup(extraBin: string[] = []) {
  const store = new Map<string, string>()
  const persistence = { get: (w: string) => store.get(w), set: (w: string, id: string) => { store.set(w, id) }, delete: (w: string) => { store.delete(w) } }
  const profile = createCodexProfile({ bin: [process.execPath, FAKE, '--home', home, ...extraBin], codexHome: home, signalRoot })
  const m = new TmuxCliManager(profile, { persistence, postStopQuietMs: 200, dialogCheckMs: 300, startupTimeoutMs: 8_000, replyTimeoutMs: 60_000 })
  const workdir = realpathSync(mkdtempSync(join(root, 'w-')))
  managers.push({ m, workdir })
  return { m, workdir, store }
}

const argvOf = (id: string): string[] => JSON.parse(readFileSync(join(home, `argv-${id}.json`), 'utf8'))

afterAll(async () => {
  for (const { m, workdir } of managers) await m.killSession(workdir)
})

describe('TmuxCliManager + Codex profile (fake Codex TUI in real tmux)', () => {
  test('delivers a message, streams its reply, and learns the exact session id (title thread ignored)', async () => {
    const { m, workdir, store } = setup()
    const chunks: string[] = []
    expect(await m.sendAndAwaitReply(workdir, 'hello', { onTextChunk: t => chunks.push(t) })).toBe('ECHO: hello')
    expect(chunks).toEqual(['ECHO: hello'])
    const id = store.get(workdir)!
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(findRollout(join(home, 'sessions'), id)).not.toBeNull()
    // Both the title thread and the session thread notified; only one has a rollout.
    expect(readdirSync(codexSignalDirFor(workdir, signalRoot)).filter(n => n.startsWith('notify-')).length).toBe(2)
    // Spawned sandboxed, asking for approval, with the notify bridge and session-only trust.
    const argv = argvOf(id)
    expect(argv.slice(argv.indexOf('-s'), argv.indexOf('-s') + 4)).toEqual(['-s', 'workspace-write', '-a', 'on-request'])
    expect(argv.join(' ')).toContain('codex-plugin/notify.sh')
    expect(argv.join(' ')).not.toContain('dangerously')
    // The next turn reads only its own lines.
    expect(await m.sendAndAwaitReply(workdir, 'again')).toBe('ECHO: again')
  }, 30_000)

  test('reports tool calls as progress', async () => {
    const { m, workdir } = setup()
    const events: ProgressEvent[] = []
    expect(await m.sendAndAwaitReply(workdir, 'TOOL job', { onProgress: e => events.push(...e) })).toBe('ECHO: job')
    expect(events).toEqual([{ tool: 'exec_command', summary: 'ls -la' }])
  }, 20_000)

  test('an approval menu is offered to onDialog and answered with the bare digit', async () => {
    const { m, workdir } = setup()
    const seen: Dialog[] = []
    expect(await m.sendAndAwaitReply(workdir, 'MENU', { onDialog: async d => { seen.push(d); return 2 } })).toBe('CHOSE 2')
    expect(seen).toHaveLength(1)
    expect(seen[0].kind).toBe('numbered')
    expect(seen[0].question).toBe('Would you like to run the following command?\n$ touch x')
    expect(seen[0].options.map(o => o.number)).toEqual(['1', '2', '3'])
  }, 20_000)

  test('a failed turn (no notify at all) ends the wait and reports the error', async () => {
    const { m, workdir } = setup()
    const errors: string[] = []
    const started = Date.now()
    expect(await m.sendAndAwaitReply(workdir, 'ERR quota exhausted', { onStopError: e => errors.push(e) })).toBe('')
    expect(errors).toEqual(['quota exhausted'])
    expect(Date.now() - started).toBeLessThan(10_000)
    // The session id was still found (from the rollout, since nothing notified).
    expect(await m.sendAndAwaitReply(workdir, 'after')).toBe('ECHO: after')
  }, 30_000)

  test('Escape interrupts a hanging turn and ends the wait without an error', async () => {
    const { m, workdir } = setup()
    const errors: string[] = []
    const reply = m.sendAndAwaitReply(workdir, 'HANG', { onStopError: e => errors.push(e) })
    while (!m.isBusy(workdir)) await Bun.sleep(50)
    await Bun.sleep(1500)
    await m.sendEscape(workdir)
    expect(await reply).toBe('')
    expect(errors).toEqual([])
  }, 20_000)

  test('a message sent mid-turn is absorbed into the running turn', async () => {
    const { m, workdir } = setup()
    const first = m.sendAndAwaitReply(workdir, 'SLOW 2500 one')
    while (!m.isBusy(workdir)) await Bun.sleep(50)
    await Bun.sleep(1200)
    let absorbed = false
    const second = m.sendAndAwaitReply(workdir, 'two', { onAbsorbed: () => { absorbed = true } })
    expect(await first).toBe('commentary for two\n\nECHO: two')
    expect(await second).toBe('commentary for two\n\nECHO: two')
    expect(absorbed).toBe(true)
  }, 30_000)

  test('a local slash command (/model + Esc) ends once Codex is idle again', async () => {
    const { m, workdir } = setup()
    await m.ensureSession(workdir)
    const seen: string[] = []
    const started = Date.now()
    expect(await m.sendAndAwaitReply(workdir, '/model', { onDialog: async d => { seen.push(d.kind); return 0 /* Esc */ } })).toBe('')
    expect(seen).toEqual(['numbered'])
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(await m.sendAndAwaitReply(workdir, 'after')).toBe('ECHO: after')
  }, 30_000)

  test('an idle-killed session resumes the same thread (codex resume <id>) on the next message', async () => {
    const { m, workdir, store } = setup()
    await m.sendAndAwaitReply(workdir, 'first')
    const id = store.get(workdir)!
    const rollout = findRollout(join(home, 'sessions'), id)!
    await m.killIdleSessions(0)
    expect(store.get(workdir)).toBe(id)
    expect(await m.sendAndAwaitReply(workdir, 'again')).toBe('ECHO: again')
    expect(store.get(workdir)).toBe(id)
    expect(argvOf(id)).toContain('resume')
    expect(readFileSync(rollout, 'utf8')).toContain('ECHO: again')  // appended to the same file
  }, 30_000)

  test('without notify, the session id still comes from the one new rollout in the workdir', async () => {
    const { m, workdir, store } = setup(['--no-notify'])
    expect(await m.sendAndAwaitReply(workdir, 'hello')).toBe('ECHO: hello')
    expect(store.get(workdir)).toMatch(/^[0-9a-f-]{36}$/)
  }, 20_000)

  test('a fresh restart forgets the thread and kill removes the tmux session', async () => {
    const { m, workdir, store } = setup()
    await m.sendAndAwaitReply(workdir, 'first')
    const id = store.get(workdir)
    await m.restartSession(workdir, {}, true)
    await m.sendAndAwaitReply(workdir, 'second')
    expect(store.get(workdir)).not.toBe(id)
    await m.killSession(workdir)
    expect((await runTmux(['has-session', '-t', m.profile.sessionName(workdir)])).ok).toBe(false)
    expect(store.get(workdir)).toBeUndefined()
  }, 30_000)

  test('a disallowed sandbox is refused before anything is spawned or pasted', async () => {
    const { m, workdir } = setup()
    await expect(m.sendAndAwaitReply(workdir, 'hello', { sandbox: 'danger-full-access' })).rejects.toThrow(/not allowed/)
    expect(existsSync(codexSignalDirFor(workdir, signalRoot))).toBe(true)  // prepared, but nothing ran
  }, 20_000)
})
