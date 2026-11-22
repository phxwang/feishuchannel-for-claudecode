import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'fs'
import { join } from 'path'
import { TmuxCliManager, type SendAndAwaitReplyOptions } from '../../tmux/manager'
import { claudeProfile } from '../../tmux/profiles/claude'
import type { TmuxCliProfile } from '../../tmux/profile'
import type { Dialog } from '../../tmux/dialog'
import type { AttemptContext, BackendEvent } from './backend'
import { SharedTmuxBackend } from './tmux-shared'
import { authorization, makeHarness, prepareArgs, tempRoot, waitPhase } from '../test-helpers'

setDefaultTimeout(30_000)

const ok = async () => ({ ok: true })

function ctx(over: Partial<AttemptContext> = {}): AttemptContext {
  return {
    taskId: 'task_1', executionAttemptId: over.executionAttemptId ?? 'xatt_1', executionId: 'exec_1', turnId: 'turn_1',
    candidate: { kind: 'claude', mode: 'tmux', model: 'opus', variant: null },
    workdir: { canonicalPath: '/w', dev: 1, ino: 1 }, permissionMode: 'broker', runDir: '/tmp', ...over,
  }
}

/** Minimal stand-in for the router's manager: sendAndAwaitReply is scripted per test. */
function stubManager(script: (opts: SendAndAwaitReplyOptions) => Promise<string>, busy = false) {
  const escapes: string[] = []
  const m = {
    profile: { sessionName: (w: string) => `claude-${w.replace(/\W/g, '')}` },
    isBusy: () => busy,
    sendEscape: async (w: string) => { escapes.push(w) },
    sendAndAwaitReply: (_w: string, _t: string, opts: SendAndAwaitReplyOptions) => script(opts),
  }
  return { manager: m as unknown as TmuxCliManager, escapes }
}

async function collect(b: SharedTmuxBackend, c: AttemptContext, stopAfter = 50): Promise<BackendEvent[]> {
  const out: BackendEvent[] = []
  const handle = (await b.open(c) as any).handle
  for await (const e of b.observe(c, handle, new AbortController().signal)) { out.push(e); if (out.length >= stopAfter) break }
  return out
}

const menu: Dialog = { kind: 'numbered', question: 'Allow Bash(ls)?', options: [{ number: '1', label: 'Yes' }, { number: '2', label: 'Yes, and always allow' }, { number: '3', label: 'No' }] } as Dialog

describe('SharedTmuxBackend (stub manager)', () => {
  test('a reply wait that ended without a real stop (e.g. chat /restart) is not a completion', async () => {
    const { manager } = stubManager(async opts => { opts.onTextChunk?.('partial'); opts.onWaitEnded?.('session_killed'); return 'partial' })
    const b = new SharedTmuxBackend({ kind: 'claude', manager, spawnFor: () => ({}), available: ok })
    const c = ctx({ executionAttemptId: 'xatt_killed' })
    await b.submit(c, (await b.open(c) as any).handle, { inputKind: 'text', prompt: 'hi' })
    const end = (await collect(b, c)).find(e => e.type === 'turn.ended') as any
    expect(end.outcome).toBe('failed')
    expect(end.protocol.backendFinished).toBe(false)
    expect(end.protocol.stopReason).toContain('session_killed')
  })

  test('maps streamed text, progress and the reply to ledger events', async () => {
    const { manager } = stubManager(async opts => {
      opts.onProgress?.([{ tool: 'Bash', summary: 'ls' }])
      opts.onTextChunk?.('hello ')
      opts.onTextChunk?.('world')
      opts.onWaitEnded?.('stop')
      return 'hello world'
    })
    const b = new SharedTmuxBackend({ kind: 'claude', manager, spawnFor: c => ({ model: c.model }), available: ok })
    const c = ctx()
    const h = (await b.open(c) as any).handle
    expect(h.backendSessionId).toContain('claude-')
    expect((await b.submit(c, h, { inputKind: 'text', prompt: 'hi' })).kind).toBe('pending')
    const ev = await collect(b, c)
    expect(ev[0]).toEqual({ type: 'delivery', status: 'accepted' })
    expect(ev.filter(e => e.type === 'text').map(e => (e as any).text).join('')).toBe('hello world')
    const end = ev.find(e => e.type === 'turn.ended') as any
    expect(end.outcome).toBe('completed')
    expect(end.finalText).toBe('hello world')
    expect((await b.release(c, h, 100)).released).toBe(true)
  })

  test('a throw from sendAndAwaitReply is a proven not-sent failure', async () => {
    const { manager } = stubManager(async () => { throw new Error('session failed to start') })
    const b = new SharedTmuxBackend({ kind: 'agy', manager, spawnFor: () => ({}), available: ok })
    const c = ctx()
    await b.submit(c, (await b.open(c) as any).handle, { inputKind: 'text', prompt: 'hi' })
    const ev = await collect(b, c)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ type: 'delivery', status: 'not_sent', failure: { code: 'startup_failed', ownerSettled: true } })
  })

  test('busy shared session and router cooldown are refused before delivery', async () => {
    const busy = new SharedTmuxBackend({ kind: 'claude', manager: stubManager(async () => '', true).manager, spawnFor: () => ({}), available: ok })
    expect(await busy.preflight(ctx())).toMatchObject({ kind: 'not_sent', code: 'backend_unavailable' })
    const cooling = new SharedTmuxBackend({ kind: 'agy', manager: stubManager(async () => '').manager, spawnFor: () => ({}), available: ok, unavailableReason: () => 'quota cooldown' })
    expect(await cooling.preflight(ctx())).toMatchObject({ kind: 'not_sent', detail: 'quota cooldown' })
    const missing = new SharedTmuxBackend({ kind: 'codex', manager: stubManager(async () => '').manager, spawnFor: () => ({}), available: async () => ({ ok: false, reason: 'codex not found' }) })
    expect(await missing.preflight(ctx())).toMatchObject({ kind: 'not_sent', code: 'backend_unavailable' })
  })

  test('broker: a permission menu waits for the client and answers with the one-shot option', async () => {
    let chosen: number | undefined
    const { manager } = stubManager(async opts => { chosen = await opts.onDialog!(menu); return 'done' })
    const b = new SharedTmuxBackend({ kind: 'claude', manager, spawnFor: () => ({}), available: ok })
    const c = ctx()
    const h = (await b.open(c) as any).handle
    await b.submit(c, h, { inputKind: 'text', prompt: 'hi' })
    const events: BackendEvent[] = []
    for await (const e of b.observe(c, h, new AbortController().signal)) {
      events.push(e)
      if (e.type === 'permission.requested') expect(await b.replyPermission(c, h, e.backendRequestId, 'allow_once')).toBe('confirmed')
    }
    expect(chosen).toBe(1)
    expect(events.map(e => e.type)).toContain('permission.cleared')
  })

  test('backend_policy: menus are denied without asking anyone', async () => {
    let chosen: number | undefined
    const { manager } = stubManager(async opts => { chosen = await opts.onDialog!(menu); return 'done' })
    const b = new SharedTmuxBackend({ kind: 'claude', manager, spawnFor: () => ({}), available: ok })
    const c = ctx({ permissionMode: 'backend_policy' })
    await b.submit(c, (await b.open(c) as any).handle, { inputKind: 'text', prompt: 'hi' })
    const ev = await collect(b, c)
    expect(chosen).toBe(3)
    expect(ev.some(e => e.type === 'permission.requested')).toBe(false)
  })

  test('interrupt presses Escape on the workdir session and ends the turn as cancelled', async () => {
    let release!: () => void
    const { manager, escapes } = stubManager(opts => new Promise(r => { release = () => r(''); opts.onTextChunk?.('partial') }))
    const b = new SharedTmuxBackend({ kind: 'claude', manager, spawnFor: () => ({}), available: ok })
    const c = ctx()
    const h = (await b.open(c) as any).handle
    await b.submit(c, h, { inputKind: 'text', prompt: 'hi' })
    await b.interrupt(c, h)
    expect(escapes).toEqual(['/w'])
    release()
    const end = (await collect(b, c)).find(e => e.type === 'turn.ended') as any
    expect(end.outcome).toBe('cancelled')
  })

  test('after a router restart the turn is not recoverable: observe reports lost, locate unreachable', async () => {
    const b = new SharedTmuxBackend({ kind: 'claude', manager: stubManager(async () => '').manager, spawnFor: () => ({}), available: ok })
    const c = ctx({ executionAttemptId: 'xatt_unknown' })
    expect(await b.locate(c)).toBe('unreachable')
    expect((await collect(b, c))[0]).toMatchObject({ type: 'lost' })
    // The exact session name is checked: this one does not exist, so nothing is left running.
    expect((await b.release(c, (await b.open(c) as any).handle, 10)).released).toBe(true)
  })
})

// ── Real tmux + the router's Claude profile driving the fake claude CLI ──────
const FAKE = join(import.meta.dir, '..', '..', 'tmux', 'test-fixtures', 'fake-claude.ts')
const root = realpathSync(mkdtempSync('/tmp/rtask-tmux-'))
const realManagers: { m: TmuxCliManager; workdir: string }[] = []
afterAll(async () => { for (const { m, workdir } of realManagers) await m.killSession(workdir) })

function fakeClaudeManager() {
  let spawns = 0
  const profile: TmuxCliProfile = {
    ...claudeProfile,
    sessionName: (w: string) => `${claudeProfile.sessionName(w)}-rtask-test`,
    prepareSpawn: () => {},
    planSpawn: (w: string) => { spawns++; const t = join(root, `${w.split('/').pop()}.jsonl`); return { argv: [process.execPath, FAKE, t, `${t}.stop`], env: {}, sessionId: 's' } },
    transcriptPath: (w: string) => join(root, `${w.split('/').pop()}.jsonl`),
    findLatestTranscript: (w: string) => join(root, `${w.split('/').pop()}.jsonl`),
    stopSignalPath: (w: string) => `${join(root, `${w.split('/').pop()}.jsonl`)}.stop`,
    afterStop: () => ({ wait: 'done' }),
  }
  const m = new TmuxCliManager(profile, { postStopQuietMs: 200, dialogCheckMs: 300, startupTimeoutMs: 8_000, replyTimeoutMs: 60_000 })
  return { m, spawnCount: () => spawns }
}

describe('SharedTmuxBackend through the task service (real tmux, fake claude)', () => {
  test('two tasks on the same workdir reuse the router session; the session survives close', async () => {
    const { m, spawnCount } = fakeClaudeManager()
    const h = makeHarness({
      dir: tempRoot('rtask-tm-'),
      backends: [new SharedTmuxBackend({ kind: 'claude', manager: m, spawnFor: c => ({ model: c.model }), available: ok })],
      config: { backends: { fake: { enabled: false, models: ['x'] }, claude: { models: ['opus'] } } },
    })
    realManagers.push({ m, workdir: h.workdir })
    const claude = { kind: 'claude', mode: 'tmux', model: 'opus', variant: null }
    const fb = { enabled: false, candidates: [claude], triggerOn: [], maxSwitches: 0, startupRetriesPerCandidate: 0, retryDelaySeconds: 0, maxRecoverySeconds: 60, onExhausted: 'fail', sameOwnerReset: { enabled: false, maxWaitSeconds: 0, maxResumeActions: 0 } }

    for (const n of [1, 2]) {
      const args = prepareArgs(h, { clientTaskId: `j${n}`, scopeKey: `s${n}`, idempotencyKey: `p${n}`, prompt: `ping ${n}`, fallback: fb })
      const { task } = await h.data('router_task_prepare', args)
      await h.data('router_task_start', { taskId: task.taskId, idempotencyKey: `st${n}`, expectedControlVersion: task.controlVersion, authorization: authorization(args) })
      const q = await waitPhase(h, task.taskId, 'QUIESCENT', 20_000)
      const result = await h.data('router_task_result', { taskId: task.taskId })
      expect(result.turns[0].finalText).toBe(`ECHO: ping ${n}`)
      await h.data('router_task_close', { taskId: task.taskId, idempotencyKey: `c${n}`, expectedControlVersion: q.controlVersion, expectedOwner: { executionId: q.owner.executionId, generation: q.owner.generation }, reason: 'done' })
      const c = await waitPhase(h, task.taskId, 'CLOSED')
      expect(c.executionOutcome).toBe('completed')
    }
    expect(spawnCount()).toBe(1)
    expect(await m.sendAndAwaitReply(h.workdir, 'chat still works')).toBe('ECHO: chat still works')
    h.service.stop()
  })
})
