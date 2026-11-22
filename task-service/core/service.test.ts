import { afterEach, describe, expect, test } from 'bun:test'
import { authorization, ended, eventTypes, makeHarness, prepareArgs, startTask, waitFor, waitPhase, type Harness } from '../test-helpers'

let h: Harness
afterEach(() => { h?.service.stop() })

describe('prepare', () => {
  test('creates PREPARED with no backend effects', async () => {
    h = makeHarness()
    const d = await h.data('router_task_prepare', prepareArgs(h))
    expect(d.task.phase).toBe('PREPARED')
    expect(d.task.controlVersion).toBe(0)
    expect(d.resources.snapshotUri).toBe(`router://tasks/${d.task.taskId}/snapshot`)
    expect(h.fake.log.submits).toHaveLength(0)
    expect(eventTypes(h, d.task.taskId)).toEqual(['task.prepared'])
  })

  test('idempotent replay, conflicts and scope exclusion', async () => {
    h = makeHarness()
    const args = prepareArgs(h)
    const first = await h.call('router_task_prepare', args)
    const replay = await h.call('router_task_prepare', { ...args, requestId: crypto.randomUUID() })
    expect(replay.replayed).toBe(true)
    expect((replay.data as any).task.taskId).toBe((first.data as any).task.taskId)

    const changed = await h.call('router_task_prepare', { ...args, scopeKey: 'other' })
    expect(changed.error?.code).toBe('IDEMPOTENCY_CONFLICT')

    const sameContentNewKey = await h.call('router_task_prepare', { ...args, idempotencyKey: 'prep-2' })
    expect((sameContentNewKey.data as any).task.taskId).toBe((first.data as any).task.taskId)

    const conflict = await h.call('router_task_prepare', { ...args, idempotencyKey: 'prep-3', assignment: { ...args.assignment, prompt: 'different' } })
    expect(conflict.error?.code).toBe('CLIENT_TASK_CONFLICT')

    const busy = await h.call('router_task_prepare', prepareArgs(h, { idempotencyKey: 'prep-4', clientTaskId: 'job-2' }))
    expect(busy.error?.code).toBe('SCOPE_BUSY')
  })

  test('rejects unknown fields and bad bounds as INVALID_REQUEST', async () => {
    h = makeHarness()
    const bad = await h.call('router_task_prepare', { ...prepareArgs(h), extra: 1 })
    expect(bad.ok).toBe(false)
    expect(bad.error?.code).toBe('INVALID_REQUEST')
    const args = prepareArgs(h)
    const bounds = await h.call('router_task_prepare', { ...args, policy: { ...args.policy, runTimeoutSeconds: 1 } })
    expect(bounds.error?.code).toBe('INVALID_REQUEST')
  })

  test('a /goal command sent as plain text is refused (its completion is "goal achieved", which text tasks cannot observe)', async () => {
    h = makeHarness()
    for (const [i, prompt] of ['/goal ship it', '  /goal\tship it', '/goal'].entries()) {
      const r = await h.call('router_task_prepare', prepareArgs(h, { prompt, idempotencyKey: `goal-${i}`, clientTaskId: `goal-${i}`, scopeKey: `goal-${i}` }))
      expect(r.error?.code).toBe('INVALID_REQUEST')
      expect(r.error?.message).toContain('native_goal')
    }
    // Mentioning /goal mid-prompt is ordinary text.
    expect((await h.call('router_task_prepare', prepareArgs(h, { prompt: 'Explain what /goal does.', idempotencyKey: 'goal-text' }))).ok).toBe(true)
  })

  test('rejects models outside the allowlist and unsupported permission mode', async () => {
    h = makeHarness()
    const r = await h.call('router_task_prepare', prepareArgs(h, { candidates: ['nope'] }))
    expect(r.error?.code).toBe('INVALID_REQUEST')
  })
})

describe('start and observe', () => {
  test('happy path to QUIESCENT, result, text and close', async () => {
    h = makeHarness()
    h.fake.script('fake-a', { events: [{ type: 'delivery', status: 'accepted' }, { type: 'text', streamId: 'p1', text: 'hel', mode: 'snapshot' }, { type: 'text', streamId: 'p1', text: 'hello', mode: 'snapshot' }, ended('hello')] })
    const { task } = await startTask(h)
    const q = await waitPhase(h, task.taskId, 'QUIESCENT')
    expect(h.fake.log.submits).toHaveLength(1)
    const types = eventTypes(h, task.taskId)
    expect(types).toContain('owner.established')
    expect(types).toContain('turn.accepted')
    expect(types.filter(t => t === 'text.delta')).toHaveLength(2)
    const deltas = h.store.readEvents(task.taskId, 0, 100, 1 << 20).filter(e => e.type === 'text.delta').map(e => e.data.text)
    expect(deltas.join('')).toBe('hello')

    const result = await h.data('router_task_result', { taskId: task.taskId })
    expect(result.final).toBe(false)
    expect(result.businessAcceptance).toBe('not_evaluated')
    expect(result.turns[0].finalText).toBe('hello')
    expect(result.turns[0].process.exitCode).toBeNull()

    const text = await h.data('router_turn_text_read', { taskId: task.taskId, turnId: result.turns[0].turnId, offsetBytes: 0 })
    expect(text.text).toBe('hello')
    expect(text.eof).toBe(true)

    const closed = await h.data('router_task_close', {
      taskId: task.taskId, idempotencyKey: 'close-1', expectedControlVersion: q.controlVersion,
      expectedOwner: { executionId: q.owner.executionId, generation: q.owner.generation }, reason: 'done',
    })
    expect(closed.accepted).toBe(true)
    const c = await waitPhase(h, task.taskId, 'CLOSED')
    expect(c.executionOutcome).toBe('completed')
    expect(c.cleanup.ownerReleased).toBe(true)
    expect(h.fake.log.submits).toHaveLength(1)
  })

  test('expired or mismatched start authorization cannot run', async () => {
    h = makeHarness()
    const args = prepareArgs(h)
    const { task } = await h.data('router_task_prepare', args)
    const expired = await h.call('router_task_start', { taskId: task.taskId, idempotencyKey: 's1', expectedControlVersion: task.controlVersion, authorization: { ...authorization(args), expiresAt: '2020-01-01T00:00:00+08:00' } })
    expect(expired.error?.code).toBe('AUTHORIZATION_EXPIRED')
    const mismatch = await h.call('router_task_start', { taskId: task.taskId, idempotencyKey: 's2', expectedControlVersion: task.controlVersion, authorization: { ...authorization(args), promptSha256: 'b'.repeat(64) } })
    expect(mismatch.error?.code).toBe('ASSIGNMENT_MISMATCH')
    const far = await h.call('router_task_start', { taskId: task.taskId, idempotencyKey: 's3', expectedControlVersion: task.controlVersion, authorization: authorization(args, undefined, 120_000) })
    expect(far.error?.code).toBe('INVALID_REQUEST')
    expect(h.fake.log.submits).toHaveLength(0)
  })

  test('version conflict and replay after state advanced', async () => {
    h = makeHarness()
    h.fake.script('fake-a', {})
    const args = prepareArgs(h)
    const { task } = await h.data('router_task_prepare', args)
    const startArgs = { taskId: task.taskId, idempotencyKey: 's1', expectedControlVersion: task.controlVersion, authorization: authorization(args) }
    const first = await h.call('router_task_start', startArgs)
    expect(first.ok).toBe(true)
    await waitPhase(h, task.taskId, 'QUIESCENT')
    const again = await h.call('router_task_start', startArgs)
    expect(again.ok).toBe(true)
    expect(again.replayed).toBe(true)
    const stale = await h.call('router_task_start', { ...startArgs, idempotencyKey: 's2' })
    expect(stale.error?.code).toBe('VERSION_CONFLICT')
    expect(h.fake.log.submits).toHaveLength(1)
  })

  test('ambiguous delivery becomes UNKNOWN and is never resent', async () => {
    h = makeHarness()
    h.fake.script('fake-a', { submit: 'unknown', events: [{ type: 'lost', detail: 'ack lost' }], locate: 'unreachable' })
    const { task } = await startTask(h)
    await waitPhase(h, task.taskId, 'UNKNOWN')
    await new Promise(r => setTimeout(r, 300))
    expect(h.fake.log.submits).toHaveLength(1)
    expect(h.store.getTask(task.taskId)!.needsAttention).toBe(true)
  })

  test('long poll returns an empty page after waiting and pages are ordered', async () => {
    h = makeHarness()
    const { task } = await h.data('router_task_prepare', prepareArgs(h))
    const t0 = Date.now()
    const page = await h.data('router_events_read', { taskId: task.taskId, afterSeq: 1, waitSeconds: 1 })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
    expect(page.events).toHaveLength(0)
    expect(page.nextAfterSeq).toBe(1)
    const bad = await h.call('router_events_read', { taskId: task.taskId, afterSeq: 99 })
    expect(bad.error?.code).toBe('INVALID_CURSOR')
  })
})

describe('permissions', () => {
  test('broker permission round-trip scoped to the exact owner', async () => {
    h = makeHarness()
    h.fake.script('fake-a', { events: [
      { type: 'delivery', status: 'accepted' },
      { type: 'permission.requested', backendRequestId: 'req-1', toolCallId: 'tc1', toolName: 'bash', description: 'run ls' },
      { delayMs: 300 },
      ended('ok'),
    ] })
    const { task } = await startTask(h)
    const w = await waitPhase(h, task.taskId, 'WAITING_PERMISSION')
    const perm = w.permissions[0]
    const base = { taskId: task.taskId, turnId: perm.turnId, permissionRequestId: perm.permissionRequestId, authorizationRevision: 'r1', expectedControlVersion: w.controlVersion }
    const wrongOwner = await h.call('router_permission_reply', { ...base, idempotencyKey: 'p0', optionId: 'allow_once', expectedOwner: { executionId: 'exec_x', generation: 0 } })
    expect(wrongOwner.error?.code).toBe('OWNER_MISMATCH')
    const owner = { executionId: w.owner.executionId, generation: w.owner.generation }
    const badOption = await h.call('router_permission_reply', { ...base, idempotencyKey: 'p1', optionId: 'allow_always', expectedOwner: owner })
    expect(badOption.error?.code).toBe('INVALID_OPTION')
    const ok = await h.call('router_permission_reply', { ...base, idempotencyKey: 'p2', optionId: 'allow_once', expectedOwner: owner })
    expect(ok.ok).toBe(true)
    await waitFor(() => eventTypes(h, task.taskId).includes('permission.resolved'))
    expect(h.fake.log.permissionReplies).toEqual([{ backendRequestId: 'req-1', decision: 'allow_once' }])
    const again = await h.call('router_permission_reply', { ...base, idempotencyKey: 'p3', optionId: 'allow_once', expectedOwner: owner })
    expect(['PERMISSION_STALE', 'VERSION_CONFLICT']).toContain(again.error?.code ?? '')
    await waitPhase(h, task.taskId, 'QUIESCENT')
    expect(h.fake.log.permissionReplies).toHaveLength(1)
  })
})

describe('cancel and seal', () => {
  test('cancel interrupts the exact owner and closes as cancelled', async () => {
    h = makeHarness()
    h.fake.script('fake-a', { events: [{ type: 'delivery', status: 'accepted' }], hang: true })
    const { task } = await startTask(h)
    const a = await waitPhase(h, task.taskId, 'ACTIVE')
    const r = await h.data('router_task_cancel', {
      taskId: task.taskId, idempotencyKey: 'c1', expectedControlVersion: a.controlVersion,
      expectedOwner: { executionId: a.owner.executionId, generation: a.owner.generation }, reason: 'stop', graceSeconds: 1,
    })
    expect(r.accepted).toBe(true)
    const c = await waitPhase(h, task.taskId, 'CLOSED')
    expect(c.executionOutcome).toBe('cancelled')
    expect(c.sealed).toBe(true)
    expect(h.fake.log.releases.length).toBeGreaterThan(0)
  })

  test('cancel in PREPARED closes as not_started; seal blocks start', async () => {
    h = makeHarness()
    const args = prepareArgs(h)
    const { task } = await h.data('router_task_prepare', args)
    const sealed = await h.data('router_task_seal', { taskId: task.taskId, idempotencyKey: 'seal', expectedControlVersion: task.controlVersion, expectedOwner: null, reason: 'hold' })
    expect(sealed.task.sealed).toBe(true)
    const start = await h.call('router_task_start', { taskId: task.taskId, idempotencyKey: 's', expectedControlVersion: sealed.task.controlVersion, authorization: authorization(args) })
    expect(start.error?.code).toBe('TASK_SEALED')
    await h.data('router_task_cancel', { taskId: task.taskId, idempotencyKey: 'c', expectedControlVersion: sealed.task.controlVersion, expectedOwner: null, reason: 'x', graceSeconds: 1 })
    const c = await waitPhase(h, task.taskId, 'CLOSED')
    expect(c.executionOutcome).toBe('not_started')
  })

  test('close outside QUIESCENT is rejected; add_turn is unsupported', async () => {
    h = makeHarness()
    const { task } = await h.data('router_task_prepare', prepareArgs(h))
    const close = await h.call('router_task_close', { taskId: task.taskId, idempotencyKey: 'x', expectedControlVersion: task.controlVersion, expectedOwner: null, reason: 'r' })
    expect(close.error?.code).toBe('TASK_NOT_QUIESCENT')
    const add = await h.call('router_task_add_turn', { taskId: task.taskId, idempotencyKey: 'y', expectedControlVersion: task.controlVersion, expectedOwner: null, clientTurnId: 't2', prompt: 'more', authorization: { revision: 'r', expiresAt: '2026-11-22T12:00:00+08:00', promptSha256: 'a'.repeat(64), contractSha256: 'a'.repeat(64), fallbackPlanSha256: 'a'.repeat(64) } })
    expect(add.error?.code).toBe('UNSUPPORTED_CAPABILITY')
  })
})

describe('review regressions', () => {
  test('a sealed ACTIVE task whose turn fails reaches a terminal path instead of re-observing', async () => {
    h = makeHarness()
    h.fake.script('fake-a', { events: [{ type: 'delivery', status: 'accepted' }, { delayMs: 200 }, ended('boom', 'failed')] })
    const { task } = await startTask(h)
    const a = await waitPhase(h, task.taskId, 'ACTIVE')
    await h.data('router_task_seal', { taskId: task.taskId, idempotencyKey: 'seal', expectedControlVersion: a.controlVersion, expectedOwner: { executionId: a.owner.executionId, generation: a.owner.generation }, reason: 'hold' })
    await waitPhase(h, task.taskId, 'QUIESCENT')
    await new Promise(r => setTimeout(r, 300))
    expect(eventTypes(h, task.taskId).filter(t => t === 'turn.ended')).toHaveLength(1)
  })

  test('a state-dependent rejection is not replayed after the task moves on', async () => {
    h = makeHarness()
    h.fake.script('fake-a', { events: [{ type: 'delivery', status: 'accepted' }, { delayMs: 200 }, ended('ok')] })
    const { task } = await startTask(h)
    const a = await waitPhase(h, task.taskId, 'ACTIVE')
    const owner = { executionId: a.owner.executionId, generation: a.owner.generation }
    const early = await h.call('router_task_close', { taskId: task.taskId, idempotencyKey: 'close', expectedControlVersion: a.controlVersion, expectedOwner: owner, reason: 'r' })
    expect(early.error?.code).toBe('TASK_NOT_QUIESCENT')
    const q = await waitPhase(h, task.taskId, 'QUIESCENT')
    const later = await h.call('router_task_close', { taskId: task.taskId, idempotencyKey: 'close', expectedControlVersion: q.controlVersion, expectedOwner: owner, reason: 'r' })
    // The rejected attempt did not consume the key, so the same key now succeeds.
    expect(later.ok).toBe(true)
    await waitPhase(h, task.taskId, 'CLOSED')
  })
})
