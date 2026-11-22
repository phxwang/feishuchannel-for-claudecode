/**
 * AgyTmuxBackend against real tmux and the fake agy CLI
 * (tmux/test-fixtures/fake-agy-task.ts). No real model turns.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { TmuxCliManager } from '../../tmux/manager'
import { createAgyProfile, agyTranscriptPath } from '../../tmux/profiles/agy'
import { runTmux } from '../../tmux/tmux-exec'
import type { PermissionMode } from '../schema/policy'
import type { AttemptContext, BackendEvent, BackendHandle } from './backend'
import { AgyTmuxBackend, taskSessionName, type AgyTmuxBackendOptions } from './agy'

const FIXTURES = join(import.meta.dir, '..', '..', 'tmux', 'test-fixtures')
const FAKE_TASK = join(FIXTURES, 'fake-agy-task.ts')
const FAKE_CHAT = join(FIXTURES, 'fake-agy.ts')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-task-')))
const brainDir = join(root, 'brain')
const sessions = new Set<string>()

afterAll(async () => {
  for (const s of sessions) await runTmux(['kill-session', '-t', s])
})

function backend(extra: Partial<AgyTmuxBackendOptions> = {}): AgyTmuxBackend {
  return new AgyTmuxBackend({
    bin: [process.execPath, FAKE_TASK, '--brain', brainDir], brainDir, pluginInstalled: () => true, startupTimeoutMs: 8_000,
    timing: { pollMs: 100, postStopQuietMs: 200, dialogCheckMs: 300, deliveryProofTimeoutMs: 10_000 }, ...extra,
  })
}

function newWorkdir(): string {
  return realpathSync(mkdtempSync(join(root, 'w-')))
}

function ctxFor(workdir: string, permissionMode: PermissionMode = 'broker'): AttemptContext {
  const id = `xatt_${randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase()}`
  const runDir = join(root, 'runs', id)
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  sessions.add(taskSessionName(id))
  return {
    taskId: 'task_T', executionAttemptId: id, executionId: 'exec_E', turnId: 'turn_U',
    candidate: { kind: 'agy', mode: 'tmux', model: 'fake-model', variant: null },
    workdir: { canonicalPath: workdir, dev: 0, ino: 0 }, permissionMode, runDir,
  }
}

/** argv the fake agy was spawned with (written next to its transcript). */
const spawnArgv = (conv: string) => JSON.parse(readFileSync(join(agyTranscriptPath(conv, brainDir), '..', 'argv.json'), 'utf8')) as string[]
const hasSession = async (name: string) => (await runTmux(['has-session', '-t', name])).ok

async function openAndSubmit(b: AgyTmuxBackend, ctx: AttemptContext, prompt: string): Promise<BackendHandle> {
  const opened = await b.open(ctx, new AbortController().signal)
  if (opened.kind !== 'opened') throw new Error(`open failed: ${opened.detail}`)
  const sub = await b.submit(ctx, opened.handle, { inputKind: 'text', prompt }, new AbortController().signal)
  expect(sub.kind).toBe('pending')
  return sub.kind === 'pending' && sub.handle ? sub.handle : opened.handle
}

type OnEvent = (ev: BackendEvent, handle: BackendHandle) => Promise<void>

/** Observe like the engine does: persist `handle` events, stop at turn.ended / lost. */
async function observeAll(b: AgyTmuxBackend, ctx: AttemptContext, handle: BackendHandle, onEvent?: OnEvent) {
  const events: BackendEvent[] = []
  let current = handle
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 25_000)
  for await (const ev of b.observe(ctx, current, abort.signal)) {
    events.push(ev)
    if (ev.type === 'handle') current = ev.handle
    await onEvent?.(ev, current)
    if (ev.type === 'turn.ended' || ev.type === 'lost') break
  }
  clearTimeout(timer)
  const ended = events.find(e => e.type === 'turn.ended') as Extract<BackendEvent, { type: 'turn.ended' }> | undefined
  return { events, handle: current, ended }
}

describe('AgyTmuxBackend capabilities and preflight', () => {
  test('advertises tmux/agy with broker + backend_policy and before_delivery triggers', async () => {
    const caps = await backend().capabilities()
    expect(caps).toMatchObject({ kind: 'agy', mode: 'tmux', available: true, permissionModes: ['broker', 'backend_policy'] })
    expect(caps.features).toMatchObject({ permissionReply: true, recoverAcceptedTurn: true, samePrimaryTurns: false, eventReplay: false })
    expect(caps.fallback.supportedFallbackTriggers).toEqual([
      { code: 'backend_unavailable', stage: 'before_delivery' }, { code: 'startup_failed', stage: 'before_delivery' },
    ])
  })

  test('missing binary or missing hooks plugin → not_sent backend_unavailable', async () => {
    const ctx = ctxFor(newWorkdir())
    const noBin = await backend({ bin: '/nonexistent/agy' }).preflight()
    expect(noBin).toMatchObject({ kind: 'not_sent', code: 'backend_unavailable', ownerSettled: true })
    const noPlugin = backend({ pluginInstalled: () => false })
    expect(await noPlugin.preflight()).toMatchObject({ kind: 'not_sent', code: 'backend_unavailable' })
    expect((await noPlugin.capabilities()).available).toBe(false)
    expect(await backend().preflight()).toEqual({ kind: 'ok' })
    expect(ctx.executionAttemptId).toMatch(/^xatt_/)
  })

  test('a CLI that never becomes ready → startup_failed, session verified killed', async () => {
    const b = backend({ bin: [process.execPath, FAKE_TASK, '--brain', brainDir, '--no-ready'], startupTimeoutMs: 1_500 })
    const ctx = ctxFor(newWorkdir())
    const r = await b.open(ctx, new AbortController().signal)
    expect(r).toMatchObject({ kind: 'not_sent', code: 'startup_failed', ownerSettled: true })
    expect(await hasSession(taskSessionName(ctx.executionAttemptId))).toBe(false)
  }, 15_000)
})

describe('AgyTmuxBackend turns (fake agy in real tmux)', () => {
  test('rtask-* session: delivery, handle, text snapshot, completed turn', async () => {
    const b = backend({ effort: 'high', permissionMode: 'plan' })
    const ctx = ctxFor(newWorkdir())
    const handle = await openAndSubmit(b, ctx, 'hello task')
    expect(handle.backendSessionId).toBe(`rtask-${ctx.executionAttemptId}`)
    expect(handle.extra.signalDir).toBe(join(ctx.runDir, 'agy-signal'))
    expect(await hasSession(handle.backendSessionId!)).toBe(true)

    const { events, handle: last, ended } = await observeAll(b, ctx, handle)
    const conv = String(last.extra.conversationId)
    expect(conv).toMatch(/^[0-9a-f-]{36}$/)
    expect(last.backendTurnId).toBe(`${conv}:0`)
    expect(last.extra.backendTurnId).toBe(`${conv}:0`)
    const types = events.map(e => e.type)
    expect(types.indexOf('delivery')).toBeLessThan(types.indexOf('text'))
    expect(events).toContainEqual({ type: 'delivery', status: 'accepted' })
    expect(events).toContainEqual({ type: 'text', streamId: 'reply', text: 'ECHO: hello task', mode: 'snapshot' })
    expect(ended).toMatchObject({ outcome: 'completed', finalText: 'ECHO: hello task', effects: 'none', process: { exitCode: null } })

    // Spawn flags: model from the candidate, effort from options, no --mode in broker mode, no --conversation.
    const argv = spawnArgv(conv)
    expect(argv).toContain('fake-model')
    expect(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2)).toEqual(['--effort', 'high'])
    expect(argv).not.toContain('--mode')
    expect(argv).not.toContain('--conversation')
    await b.release(ctx, last, 1_000)
  }, 30_000)

  test('tool calls become tool events; background wait is honoured', async () => {
    const b = backend()
    const ctx = ctxFor(newWorkdir())
    const tool = await observeAll(b, ctx, await openAndSubmit(b, ctx, 'TOOL x'))
    expect(tool.events.filter(e => e.type === 'tool').map(e => (e as { status: string }).status)).toEqual(['started', 'completed'])
    expect(tool.ended).toMatchObject({ outcome: 'completed', finalText: 'ECHO: x', effects: 'unknown' })
    await b.release(ctx, tool.handle, 500)

    const ctx2 = ctxFor(newWorkdir())
    const bg = await observeAll(b, ctx2, await openAndSubmit(b, ctx2, 'BG job'))
    expect(bg.ended?.finalText).toBe('ECHO: job\n\nBG DONE')
    expect(bg.events).toContainEqual({ type: 'activity', label: 'background work running' })
    await b.release(ctx2, bg.handle, 500)
  }, 40_000)

  test('a Stop with an error ends the turn failed, classified as a diagnostic', async () => {
    const b = backend()
    const ctx = ctxFor(newWorkdir())
    const r = await observeAll(b, ctx, await openAndSubmit(b, ctx, 'ERR RESOURCE_EXHAUSTED: quota exceeded'))
    expect(r.ended).toMatchObject({ outcome: 'failed', failureCode: 'execution_failed', finalText: 'partial', protocol: { stopReason: 'RESOURCE_EXHAUSTED: quota exceeded' } })
    expect(r.events.some(e => e.type === 'diagnostic' && e.detail.includes('quota_or_rate_limit'))).toBe(true)
    await b.release(ctx, r.handle, 500)
  }, 30_000)

  test('broker: permission dialog round-trip with allow_once', async () => {
    const b = backend()
    const ctx = ctxFor(newWorkdir())
    const replies: string[] = []
    const r = await observeAll(b, ctx, await openAndSubmit(b, ctx, 'ASK'), async (ev, h) => {
      if (ev.type !== 'permission.requested') return
      expect(ev.backendRequestId).toMatch(/^dlg:[0-9a-f]{32}$/)
      expect(ev.description).toContain('Yes, run command')
      replies.push(await b.replyPermission(ctx, h, ev.backendRequestId, 'allow_once'))
    })
    expect(replies).toEqual(['confirmed'])
    expect(r.ended).toMatchObject({ outcome: 'completed', finalText: 'CHOSE 1', effects: 'unknown' })
    expect(await b.replyPermission(ctx, r.handle, 'dlg:stale', 'deny_once')).toBe('unknown')
    await b.release(ctx, r.handle, 500)
  }, 30_000)

  test('broker: a menu without an allow/deny pair → interaction.required', async () => {
    const b = backend()
    const ctx = ctxFor(newWorkdir())
    const handle = await openAndSubmit(b, ctx, 'MENU')
    const abort = new AbortController()
    let seen: BackendEvent | null = null
    for await (const ev of b.observe(ctx, handle, abort.signal)) {
      if (ev.type === 'interaction.required' || ev.type === 'permission.requested') { seen = ev; break }
    }
    expect(seen).toMatchObject({ type: 'interaction.required' })
    expect(await b.release(ctx, handle, 500)).toMatchObject({ released: true })
  }, 30_000)

  test('backend_policy: a dialog is answered with its deny option and reported as a failed tool', async () => {
    const b = backend({ permissionMode: 'plan' })
    const ctx = ctxFor(newWorkdir(), 'backend_policy')
    const r = await observeAll(b, ctx, await openAndSubmit(b, ctx, 'ASK'))
    expect(r.events.some(e => e.type === 'permission.requested')).toBe(false)
    expect(r.events.some(e => e.type === 'tool' && e.status === 'failed' && (e.detail ?? '').includes('denied by backend_policy'))).toBe(true)
    expect(r.ended?.finalText).toBe('CHOSE 2')
    const argv = spawnArgv(String(r.handle.extra.conversationId))
    expect(argv.slice(argv.indexOf('--mode'), argv.indexOf('--mode') + 2)).toEqual(['--mode', 'plan'])
    await b.release(ctx, r.handle, 500)
  }, 30_000)

  test('interrupt sends Escape to the exact session and ends the turn cancelled', async () => {
    const b = backend()
    const ctx = ctxFor(newWorkdir())
    const r = await observeAll(b, ctx, await openAndSubmit(b, ctx, 'HANG'), async ev => {
      if (ev.type === 'delivery' && ev.status === 'accepted') await b.interrupt(ctx)
    })
    expect(r.ended).toMatchObject({ outcome: 'cancelled', process: { controlledShutdown: true } })
    await b.release(ctx, r.handle, 500)
  }, 30_000)
})

describe('AgyTmuxBackend isolation, release and recovery', () => {
  test('task sessions never collide with the chat session of the same workdir; release kills only its own', async () => {
    const workdir = newWorkdir()
    const chat = new TmuxCliManager(createAgyProfile({ bin: [process.execPath, FAKE_CHAT, '--brain', brainDir], brainDir, signalRoot: join(root, 'chat-signals') }), {
      postStopQuietMs: 200, startupTimeoutMs: 8_000, replyTimeoutMs: 30_000,
    })
    const chatName = await chat.ensureSession(workdir)
    sessions.add(chatName)
    expect(chatName).toMatch(/^feishu-agy-/)

    const b = backend()
    const a1 = ctxFor(workdir)
    const a2 = ctxFor(workdir)
    const h1 = await openAndSubmit(b, a1, 'one')
    const h2 = await openAndSubmit(b, a2, 'two')
    expect(new Set([chatName, h1.backendSessionId, h2.backendSessionId]).size).toBe(3)

    const rel = await b.release(a1, h1, 1_000)
    expect(rel).toMatchObject({ released: true, backgroundWorkSettled: true })
    expect(await hasSession(h1.backendSessionId!)).toBe(false)
    expect(await hasSession(h2.backendSessionId!)).toBe(true)
    expect(await hasSession(chatName)).toBe(true)
    // The chat session still works normally.
    expect(await chat.sendAndAwaitReply(workdir, 'chat still here')).toBe('ECHO: chat still here')

    const r2 = await observeAll(b, a2, h2)
    expect(r2.ended?.finalText).toBe('ECHO: two')
    await b.release(a2, r2.handle, 500)
    await chat.killSession(workdir)
  }, 45_000)

  test('a new backend instance re-attaches with the persisted handle (simulated router restart)', async () => {
    const workdir = newWorkdir()
    const first = backend()
    const ctx = ctxFor(workdir)
    const handle = await openAndSubmit(first, ctx, 'SLOW 1500 survived')

    const second = backend()
    expect(await second.locate(ctx, handle)).toBe('running')
    const r = await observeAll(second, ctx, handle)
    expect(r.ended).toMatchObject({ outcome: 'completed', finalText: 'ECHO: survived' })
    expect(await second.locate(ctx, r.handle)).toBe('ended')

    // Session gone but the transcript + Stop signal prove a complete turn.
    await runTmux(['kill-session', '-t', handle.backendSessionId!])
    const third = backend()
    expect(await third.locate(ctx, r.handle)).toBe('ended')
    const again = await observeAll(third, ctx, r.handle)
    expect(again.ended?.finalText).toBe('ECHO: survived')

    // Never opened → absent.
    expect(await third.locate(ctxFor(workdir), { ...handle, extra: {} })).toBe('absent')
  }, 40_000)

  test('an accepted turn whose session vanished without a Stop is reported lost / absent', async () => {
    const b = backend()
    const ctx = ctxFor(newWorkdir())
    const handle = await openAndSubmit(b, ctx, 'HANG')
    const r = await observeAll(b, ctx, handle, async ev => {
      if (ev.type === 'delivery' && ev.status === 'accepted') await runTmux(['kill-session', '-t', handle.backendSessionId!])
    })
    expect(r.events.at(-1)?.type).toBe('lost')
    expect(await b.locate(ctx, r.handle)).toBe('absent')
  }, 30_000)
})
