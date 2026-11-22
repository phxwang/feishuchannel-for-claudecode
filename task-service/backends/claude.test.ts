/**
 * ClaudePrintBackend against tmux/test-fixtures/fake-claude-print.ts (a
 * stand-in for `claude -p --output-format stream-json`). No real model runs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { TextStreams } from '../core/text'
import type { TaskService } from '../core/service'
import { IpcServer } from '../ipc/server'
import { tempRoot } from '../test-helpers'
import type { AttemptContext, BackendEvent, BackendHandle } from './backend'
import { buildArgv, ClaudePrintBackend, RELAY_TOOL } from './claude'
import { toAskParams, toClaudeDecision } from './claude-permission-mcp'
import { groupAlive } from './process-runner'

const FIXTURE = join(import.meta.dir, '../../tmux/test-fixtures/fake-claude-print.ts')
const ROOT = tempRoot('rtc-')
const BIN = join(ROOT, 'claude')
const SOCK = join(ROOT, 't.sock')
let seq = 0

beforeAll(() => {
  writeFileSync(BIN, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`)
  chmodSync(BIN, 0o755)
  mkdirSync(join(ROOT, 'work'), { recursive: true })
  process.env.FEISHU_TEST_SECRET = 'must-not-leak'
})
afterAll(() => { delete process.env.FEISHU_TEST_SECRET })

function backend(over: Partial<ConstructorParameters<typeof ClaudePrintBackend>[0]> = {}): ClaudePrintBackend {
  return new ClaudePrintBackend({ bin: BIN, permissionPromptTool: true, strictMcpConfig: true, socketPath: SOCK, ...over })
}

function ctx(permissionMode: 'broker' | 'backend_policy' = 'backend_policy'): AttemptContext {
  const id = `att_${process.pid}_${++seq}`
  const runDir = join(ROOT, 'runs', id)
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  return {
    taskId: `task_${seq}`, executionAttemptId: id, executionId: `exec_${seq}`, turnId: `turn_${seq}`,
    candidate: { kind: 'claude', mode: 'print', model: 'sonnet', variant: null },
    workdir: { canonicalPath: join(ROOT, 'work'), dev: 0, ino: 0 }, permissionMode, runDir,
  }
}

async function start(b: ClaudePrintBackend, c: AttemptContext, prompt: string): Promise<BackendHandle> {
  const opened = await b.open(c, new AbortController().signal)
  if (opened.kind !== 'opened') throw new Error('open failed')
  const sub = await b.submit(c, opened.handle, { inputKind: 'text', prompt }, new AbortController().signal)
  if (sub.kind !== 'pending' || !sub.handle) throw new Error(`submit: ${JSON.stringify(sub)}`)
  return sub.handle
}

/** Observe until the iterator ends, `stop` matches, or the timeout aborts it. */
async function collect(b: ClaudePrintBackend, c: AttemptContext, h: BackendHandle, stop?: (e: BackendEvent) => boolean, timeoutMs = 10_000): Promise<BackendEvent[]> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  const events: BackendEvent[] = []
  try {
    for await (const e of b.observe(c, h, abort.signal)) {
      events.push(e)
      if (stop?.(e)) break
    }
  } finally { clearTimeout(timer); abort.abort() }
  return events
}

const ended = (es: BackendEvent[]) => es.find(e => e.type === 'turn.ended') as Extract<BackendEvent, { type: 'turn.ended' }> | undefined
const ofType = <T extends BackendEvent['type']>(es: BackendEvent[], t: T) => es.filter(e => e.type === t) as Extract<BackendEvent, { type: T }>[]

function joinedText(...batches: BackendEvent[][]): string {
  const s = new TextStreams()
  for (const e of batches.flat()) if (e.type === 'text') s.apply(e.streamId, e.text, e.mode)
  return s.joined()
}

function lastHandle(es: BackendEvent[], fallback: BackendHandle): BackendHandle {
  const hs = ofType(es, 'handle')
  return hs.length ? hs[hs.length - 1].handle : fallback
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe('capabilities and preflight', () => {
  test('available when the binary answers --version; broker only with the prompt tool', async () => {
    const caps = await backend().capabilities()
    expect(caps).toMatchObject({ kind: 'claude', mode: 'print', available: true, permissionModes: ['broker', 'backend_policy'] })
    expect(caps.fallback.supportedFallbackTriggers).toEqual([
      { code: 'backend_unavailable', stage: 'before_delivery' }, { code: 'startup_failed', stage: 'before_delivery' },
    ])
    expect(caps.features).toMatchObject({ recoverAcceptedTurn: true, samePrimaryTurns: false })
    expect((await backend({ permissionPromptTool: false }).capabilities()).permissionModes).toEqual(['backend_policy'])
  })

  test('missing binary → unavailable and preflight not_sent backend_unavailable', async () => {
    const b = backend({ bin: join(ROOT, 'nope') })
    expect((await b.capabilities()).available).toBe(false)
    expect(await b.preflight(ctx(), new AbortController().signal)).toMatchObject({ kind: 'not_sent', code: 'backend_unavailable', ownerSettled: true })
  })

  test('broker without the prompt tool is capability_unavailable', async () => {
    expect(await backend({ permissionPromptTool: false }).preflight(ctx('broker'), new AbortController().signal))
      .toMatchObject({ kind: 'not_sent', code: 'capability_unavailable' })
  })
})

describe('argv', () => {
  test('broker vs backend_policy', () => {
    const common = ['claude', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--session-id', 'S', '--model', 'opus', '--permission-mode', 'default']
    expect(buildArgv('claude', 'S', 'opus', '/r/mcp.json', true)).toEqual([...common, '--permission-prompts', 'host', '--permission-prompt-tool', RELAY_TOOL, '--mcp-config', '/r/mcp.json', '--strict-mcp-config'])
    expect(buildArgv('claude', 'S', 'opus', null, false)).toEqual([...common, '--permission-prompts', 'none'])
    expect(RELAY_TOOL).toBe('mcp__router_task__permission')
  })
})

describe('turn lifecycle', () => {
  test('success: delivery accepted, text, result, real exit code, clean env', async () => {
    const b = backend()
    const c = ctx()
    const h = await start(b, c, 'hello')
    expect(h.backendSessionId).toBe(h.backendTurnId)
    expect(h.pid).toBeGreaterThan(0)
    const es = await collect(b, c, h)
    expect(es.findIndex(e => e.type === 'delivery' && e.status === 'accepted')).toBeGreaterThanOrEqual(0)
    expect(joinedText(es)).toBe('ECHO: hello')
    expect(ended(es)).toMatchObject({ outcome: 'completed', finalText: 'ECHO: hello', effects: 'none', protocol: { backendFinished: true, activeToolCount: 0, stopReason: 'end_turn' }, process: { exitCode: 0 } })
    const log = JSON.parse(readFileSync(join(c.runDir, 'stderr.log'), 'utf8').split('\n')[0])
    expect(log.feishuEnv).toEqual([])
    expect(log.marker).toBe(c.executionAttemptId)
    expect(log.argv).toContain('--permission-prompts')
    expect(log.argv[log.argv.indexOf('--session-id') + 1]).toBe(h.backendSessionId)
    expect(statSync(join(c.runDir, 'prompt.txt')).mode & 0o777).toBe(0o600)
    // A second submit must never hand the input off again.
    expect((await b.submit(c, h, { inputKind: 'text', prompt: 'again' }, new AbortController().signal)).kind).toBe('unknown')
  })

  test('tool_use / tool_result map to tool events keyed by tool_use_id', async () => {
    const b = backend()
    const c = ctx()
    const es = await collect(b, c, await start(b, c, 'TOOL'))
    expect(ofType(es, 'tool').map(t => [t.toolCallId, t.status])).toEqual([['toolu_1', 'started'], ['toolu_1', 'completed']])
    expect(ended(es)).toMatchObject({ outcome: 'completed', finalText: 'tool done', effects: 'unknown' })
    const c2 = ctx()
    const failed = await collect(b, c2, await start(b, c2, 'TOOL_FAIL'))
    expect(ofType(failed, 'tool').map(t => t.status)).toEqual(['started', 'failed'])
  })

  test('error result → failed with exit code', async () => {
    const b = backend()
    const c = ctx()
    const e = ended(await collect(b, c, await start(b, c, 'ERROR')))
    expect(e).toMatchObject({ outcome: 'failed', failureCode: 'execution_failed', finalText: null, protocol: { backendFinished: true, stopReason: 'error_during_execution' }, process: { exitCode: 1 } })
  })

  test('exit before init → delivery not_sent startup_failed', async () => {
    const b = backend()
    const c = ctx()
    const h = await start(b, c, 'FAIL_STARTUP')
    const es = (await collect(b, c, h)).filter(e => e.type !== 'handle')
    expect(es).toHaveLength(1)
    expect(es[0]).toMatchObject({ type: 'delivery', status: 'not_sent', failure: { code: 'startup_failed', ownerSettled: true } })
    expect((es[0] as any).failure.detail).toContain('simulated startup failure')
    expect(await b.locate(c, h)).toBe('absent')
  })

  test('exit after init without result → failed, backendFinished false', async () => {
    const b = backend()
    const c = ctx()
    const h = await start(b, c, 'EXIT_NO_RESULT')
    expect(ended(await collect(b, c, h))).toMatchObject({ outcome: 'failed', protocol: { backendFinished: false }, process: { exitCode: 3 } })
    expect(await b.locate(c, h)).toBe('ended')
  })
})

describe('interrupt, release, locate', () => {
  test('interrupt stops the whole process group and observe ends the turn', async () => {
    const b = backend()
    const c = ctx()
    const h = await start(b, c, 'HANG')
    const first = await collect(b, c, h, e => e.type === 'text')
    expect(first.some(e => e.type === 'delivery' && e.status === 'accepted')).toBe(true)
    expect(await b.locate(c, h)).toBe('running')
    const child = await waitFor(() => childPid(c))
    await b.interrupt(c, h)
    const rest = await collect(b, c, h)
    expect(ended(rest)).toMatchObject({ outcome: 'failed', protocol: { backendFinished: false }, process: { exitCode: 130 } })
    expect(pidAlive(child)).toBe(false)
    expect(groupAlive(h.pgid)).toBe(false)
    expect(await b.locate(c, h)).toBe('ended')
    expect(await b.release(c, h, 100)).toMatchObject({ released: true, backgroundWorkSettled: true })
  })

  test('release escalates to SIGKILL when SIGINT is ignored', async () => {
    const b = backend()
    const c = ctx()
    const h = await start(b, c, 'HANG_STUBBORN')
    await collect(b, c, h, e => e.type === 'text')
    const child = await waitFor(() => childPid(c))
    const r = await b.release(c, h, 300)
    expect(r).toEqual({ released: true, backgroundWorkSettled: true, detail: 'killed after grace period' })
    expect(pidAlive(child)).toBe(false)
    expect(groupAlive(h.pgid)).toBe(false)
  })

  test('locate without a recorded process is absent', async () => {
    const b = backend()
    const c = ctx()
    const opened = await b.open(c, new AbortController().signal)
    if (opened.kind !== 'opened') throw new Error('open failed')
    expect(await b.locate(c, opened.handle)).toBe('absent')
    expect(await collect(b, c, opened.handle)).toEqual([{ type: 'lost', detail: 'no claude process was recorded for this attempt' }])
  })
})

describe('re-attach after a router restart', () => {
  test('a new backend instance resumes from the persisted offset without re-spawning or duplicating text', async () => {
    const a = backend()
    const c = ctx()
    const h = await start(a, c, 'SLOW')
    const before = await collect(a, c, h, e => e.type === 'text' && e.text.startsWith('p3'))
    const persisted = lastHandle(before, h)
    expect(Number(persisted.extra.observedOffset)).toBeGreaterThan(0)
    const b = backend() // simulated restart: fresh instance, same persisted handle
    const after = await collect(b, c, persisted)
    expect(joinedText(before, after)).toBe(Array.from({ length: 10 }, (_, i) => `p${i} `).join(''))
    expect(ended(after)?.outcome).toBe('completed')
    const inits = readFileSync(join(c.runDir, 'stdout.jsonl'), 'utf8').split('\n').filter(l => l.includes('"subtype":"init"'))
    expect(inits).toHaveLength(1)
  })

  test('re-observing a finished turn replays no tool events but still ends the turn', async () => {
    const a = backend()
    const c = ctx()
    const h = await start(a, c, 'TOOL')
    const first = await collect(a, c, h)
    const again = await collect(backend(), c, lastHandle(first, h))
    expect(ofType(again, 'tool')).toEqual([])
    expect(joinedText(first, again)).toBe(joinedText(first))
    expect(ended(again)).toMatchObject({ outcome: 'completed', finalText: 'tool done' })
  })
})

describe('permission relay', () => {
  test('handlePermissionAsk validates the token and resolves on reply', async () => {
    const b = backend()
    const c = ctx('broker')
    const opened = await b.open(c, new AbortController().signal)
    if (opened.kind !== 'opened') throw new Error('open failed')
    const token = String(opened.handle.extra.relayToken)
    const base = { executionAttemptId: c.executionAttemptId, toolUseId: 'toolu_x', toolName: 'Bash', input: { command: 'ls' } }
    expect(await b.handlePermissionAsk({ ...base, relayToken: 'wrong' }, new AbortController().signal)).toMatchObject({ behavior: 'deny' })
    const seen: BackendEvent[] = []
    const unsub = b.relay.subscribe(c.executionAttemptId, e => seen.push(e))
    const pending = b.handlePermissionAsk({ ...base, relayToken: token }, new AbortController().signal)
    await waitFor(() => (seen.length ? true : null))
    expect(seen).toEqual([{ type: 'permission.requested', backendRequestId: 'toolu_x', toolCallId: 'toolu_x', toolName: 'Bash', description: 'Bash: ls' }])
    expect(await b.replyPermission(c, opened.handle, 'toolu_x', 'allow_once')).toBe('confirmed')
    expect(await pending).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    expect(await b.replyPermission(c, opened.handle, 'toolu_x', 'allow_once')).toBe('unknown')
    // Caller gone → deny and cleared.
    const abort = new AbortController()
    const gone = b.handlePermissionAsk({ ...base, toolUseId: 'toolu_y', relayToken: token }, abort.signal)
    await waitFor(() => (seen.length === 2 ? true : null))
    abort.abort()
    expect(await gone).toMatchObject({ behavior: 'deny' })
    expect(seen.at(-1)).toEqual({ type: 'permission.cleared', backendRequestId: 'toolu_y' })
    unsub()
  })

  test('relay helpers map to Claude’s permission-prompt-tool contract', () => {
    const env = { socketPath: '/s', attemptId: 'a', relayToken: 't' }
    expect(toAskParams(env, { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'u1' }))
      .toEqual({ executionAttemptId: 'a', relayToken: 't', toolUseId: 'u1', toolName: 'Bash', input: { command: 'ls' } })
    expect(toAskParams(env, { tool_name: 'Bash' })).toBeNull()
    expect(toClaudeDecision({ behavior: 'allow' }, { a: 1 })).toEqual({ behavior: 'allow', updatedInput: { a: 1 } })
    expect(toClaudeDecision({ behavior: 'deny', message: 'no' }, {})).toEqual({ behavior: 'deny', message: 'no' })
    expect(toClaudeDecision(null, {}).behavior).toBe('deny')
  })

  for (const decision of ['allow_once', 'deny_once'] as const) {
    test(`end to end over task.sock and the stdio relay: ${decision}`, async () => {
      const b = backend()
      const server = new IpcServer({ socketPath: SOCK, service: {} as unknown as TaskService, log: () => undefined, permissionAsk: b.handlePermissionAsk })
      await server.listen()
      try {
        const c = ctx('broker')
        const h = await start(b, c, 'PERMISSION')
        const mcp = JSON.parse(readFileSync(join(c.runDir, 'mcp.json'), 'utf8')).mcpServers.router_task
        expect(mcp.env).toEqual({ ROUTER_TASK_SOCKET: SOCK, ROUTER_TASK_ATTEMPT_ID: c.executionAttemptId, ROUTER_TASK_RELAY_TOKEN: h.extra.relayToken })
        const upTo = await collect(b, c, h, e => e.type === 'permission.requested', 20_000)
        expect(upTo.at(-1)).toMatchObject({ type: 'permission.requested', backendRequestId: 'toolu_perm1', toolName: 'Bash', description: 'Bash: rm -rf build' })
        expect(await b.replyPermission(c, h, 'toolu_perm1', decision)).toBe('confirmed')
        const rest = await collect(b, c, lastHandle(upTo, h), undefined, 20_000)
        const final = ended(rest)
        expect(final?.outcome).toBe('completed')
        const answer = JSON.parse(String(final?.finalText).replace(/^DECISION /, ''))
        expect(answer).toEqual(decision === 'allow_once'
          ? { behavior: 'allow', updatedInput: { command: 'rm -rf build' } }
          : { behavior: 'deny', message: 'Denied by the task owner.' })
        expect(ofType(rest, 'tool').at(-1)).toMatchObject({ toolCallId: 'toolu_perm1', status: decision === 'allow_once' ? 'completed' : 'failed' })
      } finally { server.close() }
    }, 30_000)
  }

  test('losing task.sock while a request is pending is a deny', async () => {
    const b = backend()
    const server = new IpcServer({ socketPath: SOCK, service: {} as unknown as TaskService, log: () => undefined, permissionAsk: b.handlePermissionAsk })
    await server.listen()
    const c = ctx('broker')
    const h = await start(b, c, 'PERMISSION')
    const upTo = await collect(b, c, h, e => e.type === 'permission.requested', 20_000)
    server.close()
    const rest = await collect(b, c, lastHandle(upTo, h), undefined, 20_000)
    expect(JSON.parse(String(ended(rest)?.finalText).replace(/^DECISION /, '')).behavior).toBe('deny')
    expect(await b.replyPermission(c, h, 'toolu_perm1', 'allow_once')).toBe('unknown')
  }, 30_000)
})

function childPid(c: AttemptContext): number | null {
  const line = readFileSync(join(c.runDir, 'stdout.jsonl'), 'utf8').split('\n').find(l => l.includes('"fake_child"'))
  return line ? Number(JSON.parse(line).pid) : null
}

async function waitFor<T>(fn: () => T | null, timeoutMs = 5000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v !== null && v !== undefined) return v
    if (Date.now() > end) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 20))
  }
}
