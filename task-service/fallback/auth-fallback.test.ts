import { afterEach, describe, expect, test } from 'bun:test'
import type { AttemptContext, BackendCapabilities, BackendEvent, TaskBackend } from '../backends/backend'
import { parseClaudeAuthStatus, type AuthStatus } from '../backends/claude-auth'
import { parseLastTurnApiError } from '../../tmux/profiles/claude-api-error'
import { SharedTmuxBackend } from '../backends/tmux-shared'
import type { SendAndAwaitReplyOptions, TmuxCliManager } from '../../tmux/manager'
import { prepareArgs as baseArgs, makeHarness, tempRoot, waitFor, waitPhase, type Harness } from '../test-helpers'
import { DEFAULT_MODEL, explicitModel } from '../schema/primitives'
import { formatTimestamp } from '../time'
import { decide } from './decide'

const claude = { kind: 'claude', mode: 'tmux', model: 'opus', variant: null } as const
const opencode = { kind: 'opencode', mode: 'http_sse', model: DEFAULT_MODEL, variant: null } as const
const codex = { kind: 'codex', mode: 'tmux', model: 'gpt-5', variant: null } as const

const AUTH_FAILED = { code: 'authentication_invalid', stage: 'before_delivery' } as const

/** A general fallback policy whose only trigger is the generic auth-failed condition. */
const authPolicy = (candidates: readonly any[], extra: Record<string, unknown> = {}) => ({
  enabled: true, candidates, triggerOn: [AUTH_FAILED], maxSwitches: candidates.length - 1,
  startupRetriesPerCandidate: 0, retryDelaySeconds: 0, maxRecoverySeconds: 60, onExhausted: 'fail',
  sameOwnerReset: { enabled: false, maxWaitSeconds: 0, maxResumeActions: 0 }, ...extra,
}) as any

describe('auth-failed trigger', () => {
  test('decide(): only a confirmed pre-delivery auth failure switches, in the general order', () => {
    const f = authPolicy([claude, codex, opencode])
    const base = { fallback: f, currentIndex: 0, currentIsStartupRetry: false, switchesUsed: 0, sealed: false, recoveryRemainingMs: 60_000, runRemainingMs: 60_000 }
    const fail = (code: string | null, stage: string | null, extra: Record<string, unknown> = {}) =>
      ({ code, stage, uncertain: false, ownerSettled: true, effectStatus: 'none', detail: '', ...extra }) as any
    expect(decide({ ...base, failure: fail('authentication_invalid', 'before_delivery') })).toMatchObject({ kind: 'switch', toIndex: 1 })
    for (const [code, stage] of [
      ['authentication_invalid', 'clean_failure'], ['rate_limited', 'before_delivery'], ['quota_exhausted', 'clean_failure'],
      ['provider_unavailable', 'before_delivery'], ['startup_failed', 'before_delivery'], ['backend_unavailable', 'before_delivery'],
      ['execution_failed', 'clean_failure'], ['idle_timeout', 'clean_failure'],
    ]) expect(decide({ ...base, failure: fail(code!, stage!) })).toMatchObject({ kind: 'terminate' })
    expect(decide({ ...base, failure: fail('authentication_invalid', 'before_delivery', { uncertain: true }) })).toMatchObject({ kind: 'unknown' })
  })
})

describe('claude auth status parsing', () => {
  test('only loggedIn=false is invalid', () => {
    expect(parseClaudeAuthStatus('{"loggedIn":false}').state).toBe('invalid')
    expect(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai"}').state).toBe('valid')
    expect(parseClaudeAuthStatus('Not logged in').state).toBe('unknown')
    expect(parseClaudeAuthStatus('{}').state).toBe('unknown')
    expect(parseClaudeAuthStatus('null').state).toBe('unknown')
  })

  test('explicitModel maps the default sentinel to undefined', () => {
    expect(explicitModel({ model: DEFAULT_MODEL })).toBeUndefined()
    expect(explicitModel({ model: 'opus' })).toBe('opus')
  })
})

// ---- end to end through the task service -------------------------------------------------

type Reply = (opts: SendAndAwaitReplyOptions) => Promise<string>
const scriptedManager = (onSend: () => void, reply: Reply = async () => 'never') => ({
  profile: { sessionName: (w: string) => `claude-${w.replace(/\W/g, '')}` },
  isBusy: () => false,
  sendEscape: async () => {}, sendLine: async () => true,
  sendAndAwaitReply: (_w: string, _t: string, opts: SendAndAwaitReplyOptions) => { onSend(); return reply(opts) },
}) as unknown as TmuxCliManager
const idleManager = (onSend: () => void) => scriptedManager(onSend)

const PORTAL = "API Error: Your account can't receive replies from Claude right now. You can find the next step in the Anthropic Verification Portal: https://portal.example/verify"
/** Claude's first request is refused with an API error category, as the profile reports it from the transcript. */
const apiErrorReply = (code: string): Reply => async opts => {
  opts.onTextChunk?.(PORTAL)
  opts.onStopError?.(PORTAL, code)
  opts.onWaitEnded?.('stop')
  return PORTAL
}

/** Minimal OpenCode stand-in: accepts and completes immediately, recording the model it was asked for. */
class StubOpenCode implements TaskBackend {
  readonly kind = 'opencode' as const
  readonly mode = 'http_sse' as const
  submits: string[] = []
  async capabilities(): Promise<BackendCapabilities> {
    return {
      kind: 'opencode', mode: 'http_sse', available: true, availabilityReason: null,
      features: { isolatedSession: true, samePrimaryTurns: false, recoverAcceptedTurn: true, permissionReply: true, cancel: true, eventReplay: true },
      permissionModes: ['broker', 'backend_policy'],
      fallback: { orderedFallback: true, supportedFallbackTriggers: [], cleanFailureFallback: false, checkpointHandoff: false, sameOwnerResetRecovery: false, nativeGoal: false },
    }
  }
  async preflight() { return { kind: 'ok' as const } }
  async open(ctx: AttemptContext) { return { kind: 'opened' as const, handle: { backendSessionId: 's1', backendTurnId: ctx.executionAttemptId, pid: null, pgid: null, processStartIdentity: null, extra: {} } } }
  async submit(ctx: AttemptContext) { this.submits.push(ctx.candidate.model); return { kind: 'accepted' as const } }
  async *observe(): AsyncIterable<BackendEvent> {
    yield { type: 'delivery', status: 'accepted' }
    yield {
      type: 'turn.ended', outcome: 'completed', finalText: 'done by opencode',
      protocol: { backendFinished: true, activeToolCount: 0, stopReason: null }, process: { exitCode: null, signal: null, controlledShutdown: null }, effects: 'none',
    }
  }
  async replyPermission() { return 'unknown' as const }
  async interrupt() {}
  async release() { return { released: true, backgroundWorkSettled: true, detail: 'ok' } }
  async locate() { return 'ended' as const }
}

describe('auth-failed fallback end to end (Claude → OpenCode)', () => {
  let h: Harness
  afterEach(() => { h?.service.stop() })

  async function run(auth: AuthStatus, reply?: Reply, triggerOn: readonly unknown[] = [AUTH_FAILED]) {
    let claudeSends = 0
    const oc = new StubOpenCode()
    h = makeHarness({
      dir: tempRoot('rtask-auth-'),
      backends: [
        new SharedTmuxBackend({ kind: 'claude', manager: scriptedManager(() => claudeSends++, reply), spawnFor: () => ({}), available: async () => ({ ok: true }), authCheck: async () => auth }),
        oc,
      ],
      config: { backends: { fake: { enabled: false, models: ['x'] }, claude: {}, opencode: {} } },
    })
    const args: any = baseArgs(h, { fallback: authPolicy([claude, opencode], { triggerOn }) })
    const prepared = await h.data('router_task_prepare', args)
    const t = prepared.task
    await h.data('router_task_start', {
      taskId: t.taskId, idempotencyKey: 'start-1', expectedControlVersion: t.controlVersion,
      authorization: {
        revision: 'rev-1', expiresAt: formatTimestamp(h.clock.now() + 30_000),
        promptSha256: t.assignment.promptSha256, contractSha256: t.assignment.contractSha256, fallbackPlanSha256: t.fallbackPlanSha256,
      },
    })
    return { taskId: t.taskId as string, args, oc, claudeSends: () => claudeSends }
  }

  const BOTH_STAGES = [AUTH_FAILED, { code: 'authentication_invalid', stage: 'clean_failure' }]

  test('account verification required (logged in, first request refused) falls back after a fresh grant', async () => {
    const r = await run({ state: 'valid', detail: 'loggedIn=true' }, apiErrorReply('verification_required'), BOTH_STAGES)
    const w = await waitPhase(h, r.taskId, 'WAITING_AUTHORIZATION', 5000)
    const pending = w.pendingAuthorization!
    await h.data('router_task_authorize', {
      taskId: r.taskId, idempotencyKey: 'az1', expectedControlVersion: w.controlVersion, expectedOwner: null,
      transitionRequestId: pending.transitionRequestId, decision: 'allow',
      authorization: {
        revision: 'rev-2', expiresAt: formatTimestamp(h.clock.now() + 30_000), promptSha256: w.assignment.promptSha256,
        contractSha256: w.assignment.contractSha256, fallbackPlanSha256: w.fallbackPlanSha256, transitionSha256: pending.transitionSha256,
      },
    })
    const done = await waitPhase(h, r.taskId, 'QUIESCENT', 5000)
    expect(done.selectedCandidateIndex).toBe(1)
    expect(r.claudeSends()).toBe(1)
    expect(r.oc.submits).toEqual([DEFAULT_MODEL])
    const result = await h.data('router_task_result', { taskId: r.taskId })
    expect(result.executionAttempts.map((a: any) => a.outcome)).toEqual(['failed', 'completed'])
  })

  test('verification required is not eligible unless clean_failure is listed', async () => {
    const r = await run({ state: 'valid', detail: 'loggedIn=true' }, apiErrorReply('verification_required'))
    const t = await waitFor(() => { const x = h.store.getTask(r.taskId); return x && ['QUIESCENT', 'FINALIZING', 'CLOSED'].includes(x.phase) ? x : undefined }, 5000)
    expect(t.selectedCandidateIndex).toBe(0)
    expect(r.oc.submits).toEqual([])
  })

  test('a rate-limit API error never falls back, even with both auth stages listed', async () => {
    const r = await run({ state: 'valid', detail: 'loggedIn=true' }, apiErrorReply('rate_limit'), BOTH_STAGES)
    const t = await waitFor(() => { const x = h.store.getTask(r.taskId); return x && ['QUIESCENT', 'FINALIZING', 'CLOSED'].includes(x.phase) ? x : undefined }, 5000)
    expect(t.selectedCandidateIndex).toBe(0)
    expect(t.phase).not.toBe('WAITING_AUTHORIZATION')
    expect(r.oc.submits).toEqual([])
  })

  test('a logged-out Claude falls back to OpenCode with its default model, never sending to Claude', async () => {
    const r = await run({ state: 'invalid', detail: 'loggedIn=false' })
    const done = await waitPhase(h, r.taskId, 'QUIESCENT', 5000)
    expect(done.selectedCandidateIndex).toBe(1)
    expect(done.actualBackend).toMatchObject({ kind: 'opencode' })
    const events = (await h.data('router_events_read', { taskId: r.taskId, afterSeq: 0 })).events.map((e: any) => e.type)
    expect(events).toContain('fallback.planned')
    const result = await h.data('router_task_result', { taskId: r.taskId })
    expect(result.turns.at(-1)).toMatchObject({ outcome: 'completed' })
    expect(r.oc.submits).toEqual([DEFAULT_MODEL])
    expect(r.claudeSends()).toBe(0)
  })

  test('an unreadable auth status runs Claude and never starts OpenCode', async () => {
    const r = await run({ state: 'unknown', detail: 'timeout' })
    await waitFor(() => r.claudeSends() > 0, 5000)
    expect(h.store.getTask(r.taskId)!.selectedCandidateIndex).toBe(0)
    expect(r.oc.submits).toEqual([])
  })
})

describe('Claude transcript API errors', () => {
  const j = (o: unknown) => JSON.stringify(o)
  const prompt = j({ type: 'user', message: { content: 'do it' } })
  const toolResult = j({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })
  const reply = j({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } })
  const portal = j({ type: 'assistant', isApiErrorMessage: true, error: 'verification_required', apiErrorStatus: 403, message: { content: [{ type: 'text', text: PORTAL }] } })

  test('the latest turn ending on an API error yields its category', () => {
    expect(parseLastTurnApiError(['{"cut', prompt, portal, ''].join('\n'))).toEqual({ code: 'verification_required', status: 403, text: PORTAL })
    expect(parseLastTurnApiError([prompt, reply, toolResult, portal, j({ type: 'system' })].join('\n'))?.code).toBe('verification_required')
  })

  test('a normal reply, or a newer prompt, is not an error', () => {
    expect(parseLastTurnApiError([prompt, reply].join('\n'))).toBeNull()
    expect(parseLastTurnApiError([prompt, portal, prompt].join('\n'))).toBeNull()
    expect(parseLastTurnApiError('')).toBeNull()
  })
})

describe('capabilities', () => {
  test('claude/tmux advertises authentication_invalid@before_delivery only when it has an auth probe', async () => {
    const mk = (authCheck?: () => Promise<AuthStatus>) => new SharedTmuxBackend({ kind: 'claude', manager: idleManager(() => {}), spawnFor: () => ({}), available: async () => ({ ok: true }), authCheck })
    const has = async (b: SharedTmuxBackend, stage: string) => (await b.capabilities()).fallback.supportedFallbackTriggers.some(t => t.code === 'authentication_invalid' && t.stage === stage)
    const withProbe = mk(async () => ({ state: 'valid', detail: '' }))
    expect(await has(withProbe, 'before_delivery')).toBe(true)
    expect(await has(withProbe, 'clean_failure')).toBe(true)
    expect((await withProbe.capabilities()).fallback.cleanFailureFallback).toBe(true)
    expect(await has(mk(), 'before_delivery')).toBe(false)
    expect((await mk().capabilities()).fallback.cleanFailureFallback).toBe(false)
  })
})
