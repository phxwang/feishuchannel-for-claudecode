import { afterEach, describe, expect, test } from 'bun:test'
import { DomainError } from '../errors'
import { authorization, ended, eventTypes, fallbackPolicy, makeHarness, startTask, waitFor, waitPhase, type Harness } from '../test-helpers'
import { decide } from './decide'
import { validateTaskPolicy } from './policy'
import { FakeBackend } from '../backends/fake'

let h: Harness
afterEach(() => { h?.service.stop() })

const before = (code: string) => ({ code, stage: 'before_delivery' })

describe('policy validation', () => {
  const fake = new FakeBackend()
  const caps = async () => [await fake.capabilities(), await fake.capabilities(), await fake.capabilities()]
  const policy = (fb: Record<string, unknown>) => ({
    inputMode: 'single_turn', permissionMode: 'broker', runTimeoutSeconds: 600, idleTimeoutSeconds: 600,
    permissionTimeoutSeconds: 600, quiescentTimeoutSeconds: 600, fallback: fb,
  }) as any

  test('disabled policy must be primary-only with zero limits', async () => {
    const c = await caps()
    const fb = fallbackPolicy(['fake-a'])
    expect(() => validateTaskPolicy(policy(fb), fb.candidates[0], 'text', c)).not.toThrow()
    const bad = { ...fb, maxSwitches: 1 }
    expect(() => validateTaskPolicy(policy(bad), fb.candidates[0], 'text', c)).toThrow(DomainError)
  })

  test('rejects duplicates, run_timeout, bad stage, wrong primary, out-of-range edges', async () => {
    const c = await caps()
    const fb = fallbackPolicy(['fake-a', 'fake-b'], { maxSwitches: 1, triggerOn: [before('backend_unavailable')] })
    expect(() => validateTaskPolicy(policy(fb), fb.candidates[0], 'text', c)).not.toThrow()
    const dup = { ...fb, candidates: [fb.candidates[0], fb.candidates[0]] }
    expect(() => validateTaskPolicy(policy(dup), fb.candidates[0], 'text', c)).toThrow(/repeat/)
    expect(() => validateTaskPolicy(policy({ ...fb, triggerOn: [before('run_timeout')] }), fb.candidates[0], 'text', c)).toThrow(/not allowed/)
    expect(() => validateTaskPolicy(policy({ ...fb, triggerOn: [{ code: 'execution_failed', stage: 'before_delivery' }] }), fb.candidates[0], 'text', c)).toThrow(/not allowed/)
    expect(() => validateTaskPolicy(policy(fb), fb.candidates[1], 'text', c)).toThrow(/candidates\[0\]/)
    expect(() => validateTaskPolicy(policy({ ...fb, maxSwitches: 2 }), fb.candidates[0], 'text', c)).toThrow(/maxSwitches/)
    expect(() => validateTaskPolicy(policy({ ...fb, triggerOn: [{ ...before('backend_unavailable'), toCandidateIndexes: [5] }] }), fb.candidates[0], 'text', c)).toThrow(/range/)
  })

  test('native_goal and same-owner reset need capabilities nobody has', async () => {
    const c = await caps()
    const fb = fallbackPolicy(['fake-a'])
    expect(() => validateTaskPolicy(policy(fb), fb.candidates[0], 'native_goal', c)).toThrow(/native_goal/)
    const reset = { ...fallbackPolicy(['fake-a', 'fake-b'], { maxSwitches: 1 }), sameOwnerReset: { enabled: true, maxWaitSeconds: 10, maxResumeActions: 1 } }
    expect(() => validateTaskPolicy(policy(reset), reset.candidates[0], 'text', c)).toThrow(/reset/)
  })
})

describe('decide()', () => {
  const fb = fallbackPolicy(['a', 'b', 'c'], { maxSwitches: 2, triggerOn: [before('backend_unavailable'), before('startup_failed')], startupRetriesPerCandidate: 1 }) as any
  const base = { fallback: fb, currentIndex: 0, currentIsStartupRetry: false, switchesUsed: 0, sealed: false, recoveryRemainingMs: 60_000, runRemainingMs: 60_000 }
  const fail = (code: string, extra: Record<string, unknown> = {}) => ({ code, stage: 'before_delivery', uncertain: false, ownerSettled: true, effectStatus: 'none', detail: '', ...extra }) as any

  test('ordered switch, exhausted at maxSwitches, uncertain never switches', () => {
    expect(decide({ ...base, failure: fail('backend_unavailable') })).toMatchObject({ kind: 'switch', toIndex: 1 })
    expect(decide({ ...base, currentIndex: 1, switchesUsed: 2, failure: fail('backend_unavailable') })).toMatchObject({ kind: 'exhausted' })
    expect(decide({ ...base, failure: fail('backend_unavailable', { uncertain: true }) })).toMatchObject({ kind: 'unknown' })
    expect(decide({ ...base, sealed: true, failure: fail('backend_unavailable') })).toMatchObject({ kind: 'terminate', reason: 'sealed' })
    expect(decide({ ...base, failure: fail('rate_limited') })).toMatchObject({ kind: 'terminate', reason: 'not_eligible' })
  })

  test('exactly one startup retry per candidate', () => {
    expect(decide({ ...base, failure: fail('startup_failed') })).toMatchObject({ kind: 'retry_same' })
    expect(decide({ ...base, currentIsStartupRetry: true, failure: fail('startup_failed') })).toMatchObject({ kind: 'switch', toIndex: 1 })
  })

  test('edge filters restrict targets; clean failure with effects is blocked', () => {
    const filtered = { ...fb, triggerOn: [{ ...before('backend_unavailable'), toCandidateIndexes: [2] }] }
    expect(decide({ ...base, fallback: filtered, failure: fail('backend_unavailable') })).toMatchObject({ kind: 'switch', toIndex: 2 })
    const clean = { ...fb, triggerOn: [{ code: 'execution_failed', stage: 'clean_failure' }] }
    expect(decide({ ...base, fallback: clean, failure: { ...fail('execution_failed'), stage: 'clean_failure', effectStatus: 'unknown' } })).toMatchObject({ kind: 'blocked' })
    expect(decide({ ...base, fallback: clean, failure: { ...fail('execution_failed'), stage: 'clean_failure' } })).toMatchObject({ kind: 'switch', needsFreshGrant: true })
  })
})

describe('Router-owned fallback through the engine', () => {
  test('switches to the next candidate when the primary is unavailable, under the start grant', async () => {
    h = makeHarness()
    h.fake.script('fake-a', { preflight: 'backend_unavailable' })
    h.fake.script('fake-b', { events: [{ type: 'delivery', status: 'accepted' }, ended('from b')] })
    const { task } = await startTask(h, { candidates: ['fake-a', 'fake-b'], fallbackExtra: { maxSwitches: 1, triggerOn: [before('backend_unavailable')] } })
    const q = await waitPhase(h, task.taskId, 'QUIESCENT')
    expect(q.selectedCandidateIndex).toBe(1)
    expect(q.actualBackend?.model).toBe('fake-b')
    expect(q.executionAttemptCount).toBe(2)
    expect(h.fake.log.submits.map(s => s.attemptId)).toHaveLength(1)
    const types = eventTypes(h, task.taskId)
    expect(types).toContain('fallback.evaluated')
    expect(types).toContain('fallback.planned')
    const result = await h.data('router_task_result', { taskId: task.taskId })
    expect(result.executionAttempts).toHaveLength(2)
    expect(result.executionAttempts[0].outcome).toBe('not_started')
    expect(result.executionAttempts[1].outcome).toBe('completed')
    expect(q.taskId).toBe(task.taskId)
    expect(q.scopeKey).toBe(task.scopeKey)
  })

  test('disabled fallback never switches and finishes not_started', async () => {
    h = makeHarness()
    h.fake.script('fake-a', { preflight: 'backend_unavailable' })
    const { task } = await startTask(h)
    const c = await waitPhase(h, task.taskId, 'CLOSED')
    expect(c.executionOutcome).toBe('not_started')
    expect(c.executionAttemptCount).toBe(1)
  })

  test('one startup retry on the same candidate, then success', async () => {
    h = makeHarness()
    h.fake.script('fake-a', { open: 'startup_failed' }, { events: [ended('second try')] })
    const { task } = await startTask(h, { candidates: ['fake-a', 'fake-b'], fallbackExtra: { maxSwitches: 1, startupRetriesPerCandidate: 1, triggerOn: [before('startup_failed')] } })
    const q = await waitPhase(h, task.taskId, 'QUIESCENT')
    const attempts = h.store.listAttempts(task.taskId)
    expect(attempts).toHaveLength(2)
    expect(attempts[1].isStartupRetry).toBe(true)
    expect(attempts[1].candidateIndex).toBe(0)
    expect(q.switchesUsed).toBe(0)
  })

  test('a clean failure needs a fresh grant: authorization.required → authorize → dispatch', async () => {
    h = makeHarness()
    h.fake.script('fake-a', { events: [{ type: 'delivery', status: 'accepted' }, ended('boom', 'failed', { effects: 'none' })] })
    h.fake.script('fake-b', { events: [ended('recovered')] })
    const { args, task } = await startTask(h, { candidates: ['fake-a', 'fake-b'], fallbackExtra: { maxSwitches: 1, triggerOn: [{ code: 'execution_failed', stage: 'clean_failure' }] } })
    const w = await waitPhase(h, task.taskId, 'WAITING_AUTHORIZATION')
    expect(eventTypes(h, task.taskId)).toContain('authorization.required')
    const pending = w.pendingAuthorization!
    const auth = { ...authorization(args), transitionSha256: pending.transitionSha256 }
    const stale = await h.call('router_task_authorize', { taskId: task.taskId, idempotencyKey: 'az0', expectedControlVersion: w.controlVersion, expectedOwner: null, transitionRequestId: 'xreq_nope', decision: 'allow', authorization: auth })
    expect(stale.error?.code).toBe('AUTHORIZATION_STALE')
    const ok = await h.call('router_task_authorize', { taskId: task.taskId, idempotencyKey: 'az1', expectedControlVersion: w.controlVersion, expectedOwner: null, transitionRequestId: pending.transitionRequestId, decision: 'allow', authorization: auth })
    expect(ok.ok).toBe(true)
    const q = await waitPhase(h, task.taskId, 'QUIESCENT')
    expect(q.selectedCandidateIndex).toBe(1)
    expect(h.fake.log.submits).toHaveLength(2)
    const result = await h.data('router_task_result', { taskId: task.taskId })
    expect(result.executionAttempts.map((a: any) => a.outcome)).toEqual(['failed', 'completed'])
  })

  test('denying the transition seals and closes, preserving the real prior outcome', async () => {
    h = makeHarness()
    h.fake.script('fake-a', { events: [{ type: 'delivery', status: 'accepted' }, ended('boom', 'failed', { effects: 'none' })] })
    const { task } = await startTask(h, { candidates: ['fake-a', 'fake-b'], fallbackExtra: { maxSwitches: 1, triggerOn: [{ code: 'execution_failed', stage: 'clean_failure' }] } })
    const w = await waitPhase(h, task.taskId, 'WAITING_AUTHORIZATION')
    await h.data('router_task_authorize', { taskId: task.taskId, idempotencyKey: 'deny', expectedControlVersion: w.controlVersion, expectedOwner: null, transitionRequestId: w.pendingAuthorization!.transitionRequestId, decision: 'deny', authorization: null })
    const c = await waitPhase(h, task.taskId, 'CLOSED')
    expect(c.executionOutcome).toBe('failed')
    expect(c.sealed).toBe(true)
    expect(h.fake.log.submits).toHaveLength(1)
  })

  test('partial effects block clean-failure fallback', async () => {
    h = makeHarness()
    h.fake.script('fake-a', { events: [{ type: 'delivery', status: 'accepted' }, ended('boom', 'failed', { effects: 'partial' })] })
    const { task } = await startTask(h, { candidates: ['fake-a', 'fake-b'], fallbackExtra: { maxSwitches: 1, triggerOn: [{ code: 'execution_failed', stage: 'clean_failure' }] } })
    const c = await waitPhase(h, task.taskId, 'CLOSED')
    expect(eventTypes(h, task.taskId)).toContain('fallback.blocked')
    expect(c.executionOutcome).toBe('failed')
    expect(h.fake.log.submits).toHaveLength(1)
  })

  test('cancel during WAITING_AUTHORIZATION stops the chain; no candidate starts later', async () => {
    h = makeHarness()
    h.fake.script('fake-a', { events: [{ type: 'delivery', status: 'accepted' }, ended('boom', 'failed', { effects: 'none' })] })
    const { task } = await startTask(h, { candidates: ['fake-a', 'fake-b'], fallbackExtra: { maxSwitches: 1, triggerOn: [{ code: 'execution_failed', stage: 'clean_failure' }] } })
    const w = await waitPhase(h, task.taskId, 'WAITING_AUTHORIZATION')
    await h.data('router_task_cancel', { taskId: task.taskId, idempotencyKey: 'c', expectedControlVersion: w.controlVersion, expectedOwner: null, reason: 'stop', graceSeconds: 1 })
    await waitPhase(h, task.taskId, 'CLOSED')
    await new Promise(r => setTimeout(r, 100))
    expect(h.fake.log.submits).toHaveLength(1)
  })

  test('retry delay goes through WAITING_RETRY and resumes', async () => {
    h = makeHarness()
    h.fake.script('fake-a', { preflight: 'backend_unavailable' })
    h.fake.script('fake-b', { events: [ended('late')] })
    const { task } = await startTask(h, { candidates: ['fake-a', 'fake-b'], fallbackExtra: { maxSwitches: 1, retryDelaySeconds: 1, triggerOn: [before('backend_unavailable')] } })
    await waitPhase(h, task.taskId, 'WAITING_RETRY')
    await waitPhase(h, task.taskId, 'QUIESCENT', 4000)
    expect(eventTypes(h, task.taskId)).toContain('recovery.resumed')
  })

  test('chat-level fallback config has no influence: unrelated triggers never switch', async () => {
    h = makeHarness()
    h.fake.script('fake-a', { preflight: 'rate_limited' })
    const { task } = await startTask(h, { candidates: ['fake-a', 'fake-b'], fallbackExtra: { maxSwitches: 1, triggerOn: [before('backend_unavailable')] } })
    const c = await waitPhase(h, task.taskId, 'CLOSED')
    expect(c.executionAttemptCount).toBe(1)
    await waitFor(() => eventTypes(h, task.taskId).includes('task.closed'))
  })
})
