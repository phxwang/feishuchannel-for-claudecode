import { afterEach, describe, expect, test } from 'bun:test'
import { FakeBackend } from '../backends/fake'
import { fire } from './timers'
import { ManualClock } from '../time'
import { ended, eventTypes, makeHarness, prepareArgs, startTask, waitPhase, type Harness } from '../test-helpers'

const harnesses: Harness[] = []
const track = (h: Harness) => { harnesses.push(h); return h }
afterEach(() => { for (const h of harnesses.splice(0)) h.service.stop() })

describe('restart recovery', () => {
  test('reattaches the exact owner, bumps generation, never resends input', async () => {
    const h1 = track(makeHarness())
    h1.fake.script('fake-a', { events: [{ type: 'delivery', status: 'accepted' }], hang: true })
    const { task } = await startTask(h1)
    const active = await waitPhase(h1, task.taskId, 'ACTIVE')
    h1.service.stop()

    const fake2 = new FakeBackend().script('fake-a', { locate: 'running', events: [ended('after restart')] })
    const h2 = track(makeHarness({ dir: h1.dir, fake: fake2 }))
    await h2.ready
    const q = await waitPhase(h2, task.taskId, 'QUIESCENT')
    expect(q.owner.generation).toBe(active.owner.generation + 1)
    expect(q.controlVersion).toBeGreaterThan(active.controlVersion)
    expect(fake2.log.submits).toHaveLength(0)
    const types = eventTypes(h2, task.taskId)
    expect(types).toContain('task.unknown')
    expect(types).toContain('owner.reconciled')
    const result = await h2.data('router_task_result', { taskId: task.taskId })
    expect(result.turns[0].finalText).toBe('after restart')
  })

  test('an unreachable owner stays UNKNOWN, keeps its scope, and a verified cancel closes it', async () => {
    const h1 = track(makeHarness())
    h1.fake.script('fake-a', { events: [{ type: 'delivery', status: 'accepted' }], hang: true })
    const { task } = await startTask(h1)
    await waitPhase(h1, task.taskId, 'ACTIVE')
    h1.service.stop()

    const fake2 = new FakeBackend().script('fake-a', { locate: 'unreachable' })
    const h2 = track(makeHarness({ dir: h1.dir, fake: fake2 }))
    await h2.ready
    const u = await waitPhase(h2, task.taskId, 'UNKNOWN')
    const busy = await h2.call('router_task_prepare', prepareArgs(h2, { idempotencyKey: 'other', clientTaskId: 'job-2' }))
    expect(busy.error?.code).toBe('SCOPE_BUSY')
    await h2.data('router_task_cancel', {
      taskId: task.taskId, idempotencyKey: 'c', expectedControlVersion: u.controlVersion,
      expectedOwner: { executionId: u.owner.executionId, generation: u.owner.generation }, reason: 'operator', graceSeconds: 1,
    })
    const c = await waitPhase(h2, task.taskId, 'CLOSED')
    expect(c.executionOutcome).toBe('cancelled')
    expect(fake2.log.releases.length).toBeGreaterThan(0)
  })

  test('operator release finalizes a stuck UNKNOWN task with an audit event', async () => {
    const h1 = track(makeHarness())
    h1.fake.script('fake-a', { events: [{ type: 'delivery', status: 'accepted' }], hang: true })
    const { task } = await startTask(h1)
    await waitPhase(h1, task.taskId, 'ACTIVE')
    h1.service.stop()
    const h2 = track(makeHarness({ dir: h1.dir, fake: new FakeBackend().script('fake-a', { locate: 'unreachable' }) }))
    await h2.ready
    await waitPhase(h2, task.taskId, 'UNKNOWN')
    h2.service.adminRelease(task.taskId, 'checked by hand')
    await waitPhase(h2, task.taskId, 'CLOSED')
    const ev = h2.store.readEvents(task.taskId, 0, 1000, 1 << 24).find(e => e.type === 'owner.reconciled')
    expect(ev?.data.source).toBe('operator')
  })
})

describe('deadlines', () => {
  test('PREPARED expires as not_started after the TTL, measured on the persisted deadline', async () => {
    const clock = new ManualClock()
    const h = track(makeHarness({ clock }))
    const { task } = await h.data('router_task_prepare', prepareArgs(h))
    clock.advance(11 * 60 * 1000)
    fire(h.service.engine, task.taskId)
    const c = await waitPhase(h, task.taskId, 'CLOSED')
    expect(c.executionOutcome).toBe('not_started')
    expect(c.terminalReason).toBe('PREPARED_EXPIRED')
  })

  test('the aggregate run deadline terminates an active task as timed_out', async () => {
    const clock = new ManualClock()
    const h = track(makeHarness({ clock }))
    h.fake.script('fake-a', { events: [{ type: 'delivery', status: 'accepted' }], hang: true })
    const { task } = await startTask(h, { runTimeoutSeconds: 10 })
    await waitPhase(h, task.taskId, 'ACTIVE')
    clock.advance(11_000)
    fire(h.service.engine, task.taskId)
    const c = await waitPhase(h, task.taskId, 'CLOSED')
    expect(c.terminalReason).toBe('RUN_TIMEOUT')
    expect(c.executionOutcome).toBe('timed_out')
  })
})
