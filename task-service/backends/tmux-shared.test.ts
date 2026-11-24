import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'fs'
import { join } from 'path'
import { TmuxCliManager, type SendAndAwaitReplyOptions, type WaitEndReason } from '../../tmux/manager'
import type { GoalState } from '../../tmux/goal'
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
function stubManager(script: (opts: SendAndAwaitReplyOptions) => Promise<string>, busy: boolean | (() => boolean) = false, goals = false) {
  const escapes: string[] = []
  const lines: string[] = []
  const m = {
    profile: { sessionName: (w: string) => `claude-${w.replace(/\W/g, '')}`, ...(goals ? { parseGoalSignal: () => null } : {}) },
    isBusy: () => (typeof busy === 'function' ? busy() : busy),
    sendEscape: async (w: string) => { escapes.push(w) },
    sendLine: async (_w: string, text: string) => { lines.push(text); return true },
    sendAndAwaitReply: (_w: string, _t: string, opts: SendAndAwaitReplyOptions) => script(opts),
  }
  return { manager: m as unknown as TmuxCliManager, escapes, lines }
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

  test('giving up on unconfirmed background subtasks (background_idle) is not a completion', async () => {
    const { manager } = stubManager(async opts => { opts.onTextChunk?.('main reply'); opts.onWaitEnded?.('background_idle'); return 'main reply' })
    const b = new SharedTmuxBackend({ kind: 'claude', manager, spawnFor: () => ({}), available: ok })
    const c = ctx({ executionAttemptId: 'xatt_bgidle' })
    await b.submit(c, (await b.open(c) as any).handle, { inputKind: 'text', prompt: 'hi' })
    const end = (await collect(b, c)).find(e => e.type === 'turn.ended') as any
    expect(end.outcome).toBe('failed')
    expect(end.protocol.backendFinished).toBe(false)
    expect(end.protocol.stopReason).toContain('background_idle')
  })

  describe('native /goal', () => {
    const goalRun = async (end: { reason: WaitEndReason; goal: GoalState }, goals = true) => {
      const { manager } = stubManager(async opts => { opts.onTextChunk?.('Goal set: x'); opts.onWaitEnded?.(end.reason, { goal: end.goal }); return 'Goal set: x' }, false, goals)
      const b = new SharedTmuxBackend({ kind: 'claude', manager, spawnFor: () => ({}), available: ok })
      const c = ctx({ executionAttemptId: `xatt_goal_${end.reason}_${end.goal}` })
      const sub = await b.submit(c, (await b.open(c) as any).handle, { inputKind: 'native_goal', prompt: '/goal x' })
      return { b, sub, end: sub.kind === 'pending' ? (await collect(b, c)).find(e => e.type === 'turn.ended') as any : null }
    }

    test('advertised only by profiles that can track goals', async () => {
      const withGoals = new SharedTmuxBackend({ kind: 'claude', manager: stubManager(async () => '', false, true).manager, spawnFor: () => ({}), available: ok })
      const without = new SharedTmuxBackend({ kind: 'agy', manager: stubManager(async () => '').manager, spawnFor: () => ({}), available: ok })
      expect((await withGoals.capabilities()).fallback.nativeGoal).toBe(true)
      expect((await without.capabilities()).fallback.nativeGoal).toBe(false)
      expect((await goalRun({ reason: 'stop', goal: 'achieved' }, false)).sub).toMatchObject({ kind: 'not_sent', code: 'capability_unavailable' })
    })

    test('completed only when the goal was achieved', async () => {
      const r = await goalRun({ reason: 'stop', goal: 'achieved' })
      expect(r.end.outcome).toBe('completed')
      expect(r.end.protocol.backendFinished).toBe(true)
    })

    test('a turn that ended without the goal achieved (cleared, interrupted, never set) is a failure', async () => {
      for (const goal of ['cleared', 'interrupted', 'none'] as const) {
        const r = await goalRun({ reason: 'stop', goal })
        expect(r.end.outcome).toBe('failed')
        expect(r.end.protocol.backendFinished).toBe(false)
        expect(r.end.protocol.stopReason).toContain(`goal ${goal}`)
      }
    })

    test('releasing a goal run that ended unachieved (e.g. reply timeout) disarms the goal: Escape, then /goal clear', async () => {
      const { manager, escapes, lines } = stubManager(async opts => { opts.onWaitEnded?.('timeout', { goal: 'active' }); return '' }, false, true)
      const b = new SharedTmuxBackend({ kind: 'claude', manager, spawnFor: () => ({}), available: ok })
      const c = ctx({ executionAttemptId: 'xatt_goal_timeout' })
      const h = (await b.open(c) as any).handle
      await b.submit(c, h, { inputKind: 'native_goal', prompt: '/goal x' })
      expect(((await collect(b, c)).find(e => e.type === 'turn.ended') as any).outcome).toBe('failed')
      const rel = await b.release(c, h, 100)
      expect(rel.released).toBe(true)
      expect(escapes).toEqual(['/w'])
      expect(lines).toEqual(['/goal clear'])
      expect(rel.detail).toContain('goal cleared')
    })

    test('an interrupted goal run is disarmed on release without a second Escape', async () => {
      let finish!: () => void
      const { manager, escapes, lines } = stubManager(opts => new Promise(r => { finish = () => { opts.onWaitEnded?.('interrupted', { goal: 'active' }); r('') } }), false, true)
      // The interrupt record ends the wait right after the Escape, before interrupt() would type /goal clear.
      const sendEscape = manager.sendEscape.bind(manager)
      ;(manager as any).sendEscape = async (w: string) => { await sendEscape(w); finish() }
      const b = new SharedTmuxBackend({ kind: 'claude', manager, spawnFor: () => ({}), available: ok })
      const c = ctx({ executionAttemptId: 'xatt_goal_interrupt_release' })
      const h = (await b.open(c) as any).handle
      await b.submit(c, h, { inputKind: 'native_goal', prompt: '/goal x' })
      await b.interrupt(c, h)
      const rel = await b.release(c, h, 1_000)
      expect(rel.released).toBe(true)
      expect(escapes).toEqual(['/w'])
      expect(lines).toEqual(['/goal clear'])
    })

    test('an achieved or already-cleared goal is not touched on release', async () => {
      for (const goal of ['achieved', 'cleared'] as const) {
        const { manager, escapes, lines } = stubManager(async opts => { opts.onWaitEnded?.('stop', { goal }); return '' }, false, true)
        const b = new SharedTmuxBackend({ kind: 'claude', manager, spawnFor: () => ({}), available: ok })
        const c = ctx({ executionAttemptId: `xatt_goal_rel_${goal}` })
        const h = (await b.open(c) as any).handle
        await b.submit(c, h, { inputKind: 'native_goal', prompt: '/goal x' })
        await collect(b, c)
        await b.release(c, h, 100)
        expect(escapes).toEqual([])
        expect(lines).toEqual([])
      }
    })

    test('a session another caller is already using is not typed into on release', async () => {
      let busy = false
      const { manager, escapes, lines } = stubManager(async opts => { opts.onWaitEnded?.('stop', { goal: 'interrupted' }); return '' }, () => busy, true)
      const b = new SharedTmuxBackend({ kind: 'claude', manager, spawnFor: () => ({}), available: ok })
      const c = ctx({ executionAttemptId: 'xatt_goal_busy' })
      const h = (await b.open(c) as any).handle
      await b.submit(c, h, { inputKind: 'native_goal', prompt: '/goal x' })
      await collect(b, c)
      busy = true
      const rel = await b.release(c, h, 100)
      expect(rel.released).toBe(true)
      expect(escapes).toEqual([])
      expect(lines).toEqual([])
      expect(rel.detail).toContain('busy')
    })

    test('interrupting a goal run presses Escape and clears the goal so the shared session is not left armed', async () => {
      let finish!: () => void
      const { manager, escapes, lines } = stubManager(opts => new Promise(r => { finish = () => { opts.onWaitEnded?.('stop', { goal: 'cleared' }); r('') } }), false, true)
      const b = new SharedTmuxBackend({ kind: 'claude', manager, spawnFor: () => ({}), available: ok })
      const c = ctx({ executionAttemptId: 'xatt_goal_cancel' })
      await b.submit(c, (await b.open(c) as any).handle, { inputKind: 'native_goal', prompt: '/goal x' })
      await b.interrupt(c)
      expect(escapes).toEqual(['/w'])
      expect(lines).toEqual(['/goal clear'])
      finish()
      expect(((await collect(b, c)).find(e => e.type === 'turn.ended') as any).outcome).toBe('cancelled')
    })
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

  test('repeated interrupts press Escape once: a second Esc would open the CLI\'s Rewind menu', async () => {
    let finish!: () => void
    const { manager, escapes } = stubManager(opts => new Promise(r => { finish = () => { opts.onWaitEnded?.('interrupted'); r('') } }))
    const b = new SharedTmuxBackend({ kind: 'claude', manager, spawnFor: () => ({}), available: ok })
    const c = ctx({ executionAttemptId: 'xatt_double_esc' })
    const h = (await b.open(c) as any).handle
    await b.submit(c, h, { inputKind: 'text', prompt: 'hi' })
    await b.interrupt(c, h)
    await b.interrupt(c, h)
    expect((await b.release(c, h, 20)).released).toBe(false)
    expect(escapes).toEqual(['/w'])
    finish()
    expect((await b.release(c, h, 1_000)).released).toBe(true)
    expect(escapes).toEqual(['/w'])
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

  test('cancelling a turn that is still running closes the task (an interrupt fires no Stop hook)', async () => {
    const { m } = fakeClaudeManager()
    const h = makeHarness({
      dir: tempRoot('rtask-cancel-'),
      backends: [new SharedTmuxBackend({ kind: 'claude', manager: m, spawnFor: c => ({ model: c.model }), available: ok })],
      config: { backends: { fake: { enabled: false, models: ['x'] }, claude: { models: ['opus'] } } },
      releaseGraceMs: 5_000,
    })
    realManagers.push({ m, workdir: h.workdir })
    const claude = { kind: 'claude', mode: 'tmux', model: 'opus', variant: null }
    const fb = { enabled: false, candidates: [claude], triggerOn: [], maxSwitches: 0, startupRetriesPerCandidate: 0, retryDelaySeconds: 0, maxRecoverySeconds: 60, onExhausted: 'fail', sameOwnerReset: { enabled: false, maxWaitSeconds: 0, maxResumeActions: 0 } }
    const args = prepareArgs(h, { prompt: 'hang forever', fallback: fb })
    const { task } = await h.data('router_task_prepare', args)
    await h.data('router_task_start', { taskId: task.taskId, idempotencyKey: 'st', expectedControlVersion: task.controlVersion, authorization: authorization(args) })
    const a = await waitPhase(h, task.taskId, 'ACTIVE', 20_000)
    await new Promise(r => setTimeout(r, 1_500))
    await h.data('router_task_cancel', {
      taskId: task.taskId, idempotencyKey: 'c', expectedControlVersion: a.controlVersion,
      expectedOwner: { executionId: a.owner.executionId, generation: a.owner.generation }, reason: 'stop', graceSeconds: 5,
    })
    const c = await waitPhase(h, task.taskId, 'CLOSED', 20_000)
    expect(c.executionOutcome).toBe('cancelled')
    expect(m.isBusy(h.workdir)).toBe(false)
    h.service.stop()
  }, 60_000)

  test('a native_goal task completes only after the goal is achieved across self-continued turns', async () => {
    const { m } = fakeClaudeManager()
    const h = makeHarness({
      dir: tempRoot('rtask-goal-'),
      backends: [new SharedTmuxBackend({ kind: 'claude', manager: m, spawnFor: c => ({ model: c.model }), available: ok })],
      config: { backends: { fake: { enabled: false, models: ['x'] }, claude: { models: ['opus'] } } },
    })
    realManagers.push({ m, workdir: h.workdir })
    const claude = { kind: 'claude', mode: 'tmux', model: 'opus', variant: null }
    const fb = { enabled: false, candidates: [claude], triggerOn: [], maxSwitches: 0, startupRetriesPerCandidate: 0, retryDelaySeconds: 0, maxRecoverySeconds: 60, onExhausted: 'fail', sameOwnerReset: { enabled: false, maxWaitSeconds: 0, maxResumeActions: 0 } }
    const args = prepareArgs(h, { prompt: '/goal turns=2 finish', fallback: fb })
    const { task } = await h.data('router_task_prepare', { ...args, assignment: { ...args.assignment, inputKind: 'native_goal' } })
    await h.data('router_task_start', { taskId: task.taskId, idempotencyKey: 'st', expectedControlVersion: task.controlVersion, authorization: authorization(args) })
    await waitPhase(h, task.taskId, 'QUIESCENT', 30_000)
    const result = await h.data('router_task_result', { taskId: task.taskId })
    expect(result.turns[0].outcome).toBe('completed')
    expect(result.turns[0].finalText).toBe('Goal set: turns=2 finish\n\nWORK 1\n\nWORK 2')
    h.service.stop()
  }, 60_000)
})
