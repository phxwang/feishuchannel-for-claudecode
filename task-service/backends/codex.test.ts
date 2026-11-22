import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import type { AttemptContext, BackendEvent, BackendHandle } from './backend'
import { CodexExecBackend, insideGitRepo, reduceAll } from './codex'
import { groupAlive, readExit } from './process-runner'

const FIXTURE = resolve(import.meta.dir, '../../tmux/test-fixtures/fake-codex.ts')
let root: string
let wrapper: string
let attemptSeq = 0

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-backend-')))
  wrapper = join(root, 'codex')
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`)
  chmodSync(wrapper, 0o755)
})

afterAll(() => { rmSync(root, { recursive: true, force: true }) })

function makeWorkdir(git: boolean): string {
  const dir = mkdtempSync(join(root, 'wd-'))
  if (git) mkdirSync(join(dir, '.git'))
  return dir
}

function makeCtx(workdir: string, overrides: Partial<AttemptContext> = {}): AttemptContext {
  const id = `att-${++attemptSeq}`
  const runDir = join(root, 'runs', id)
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const st = statSync(workdir)
  return {
    taskId: `task-${attemptSeq}`, executionAttemptId: id, executionId: `exec-${attemptSeq}`, turnId: `turn-${attemptSeq}`,
    candidate: { kind: 'codex', mode: 'exec', model: 'gpt-test', variant: null },
    workdir: { canonicalPath: workdir, dev: st.dev, ino: st.ino },
    permissionMode: 'backend_policy', runDir, ...overrides,
  }
}

function backend(): CodexExecBackend {
  return new CodexExecBackend({ bin: wrapper, sandbox: 'workspace-write' })
}

async function start(b: CodexExecBackend, ctx: AttemptContext, prompt: string): Promise<BackendHandle> {
  const opened = await b.open(ctx, new AbortController().signal)
  if (opened.kind !== 'opened') throw new Error('open failed')
  const sub = await b.submit(ctx, opened.handle, { inputKind: 'text', prompt }, new AbortController().signal)
  if (sub.kind !== 'pending' || !sub.handle) throw new Error(`submit: ${JSON.stringify(sub)}`)
  return sub.handle
}

async function collect(it: AsyncIterable<BackendEvent>, until?: (e: BackendEvent) => boolean): Promise<BackendEvent[]> {
  const out: BackendEvent[] = []
  for await (const e of it) {
    out.push(e)
    if (until?.(e)) break
  }
  return out
}

function ended(events: BackendEvent[]) {
  const e = events.find(x => x.type === 'turn.ended')
  if (!e || e.type !== 'turn.ended') throw new Error(`no turn.ended in ${JSON.stringify(events)}`)
  return e
}

function spawns(ctx: AttemptContext): { argv: string[]; cwd: string }[] {
  return readFileSync(join(ctx.runDir, 'spawns.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
}

describe('CodexExecBackend construction and capabilities', () => {
  test('refuses danger-full-access and unknown (bypass) options', () => {
    expect(() => new CodexExecBackend({ bin: wrapper, sandbox: 'danger-full-access' as any })).toThrow(/sandbox/)
    expect(() => new CodexExecBackend({ bin: wrapper, sandbox: 'read-only', dangerouslyBypassApprovalsAndSandbox: true } as any)).toThrow(/unsupported option/)
  })

  test('advertises backend_policy only and the before_delivery triggers', async () => {
    const caps = await backend().capabilities()
    expect(caps.available).toBe(true)
    expect(caps.permissionModes).toEqual(['backend_policy'])
    expect(caps.features.permissionReply).toBe(false)
    expect(caps.features.recoverAcceptedTurn).toBe(true)
    expect(caps.fallback.supportedFallbackTriggers).toEqual([
      { code: 'backend_unavailable', stage: 'before_delivery' }, { code: 'startup_failed', stage: 'before_delivery' },
    ])
  })

  test('missing binary → unavailable and preflight not_sent backend_unavailable', async () => {
    const b = new CodexExecBackend({ bin: join(root, 'nope'), sandbox: 'read-only' })
    expect((await b.capabilities()).available).toBe(false)
    const pre = await b.preflight(makeCtx(makeWorkdir(false)), new AbortController().signal)
    expect(pre).toMatchObject({ kind: 'not_sent', code: 'backend_unavailable' })
  })

  test('preflight and submit reject broker permission mode', async () => {
    const b = backend()
    const ctx = makeCtx(makeWorkdir(false), { permissionMode: 'broker' })
    expect(await b.preflight(ctx, new AbortController().signal)).toMatchObject({ kind: 'not_sent', code: 'capability_unavailable' })
    const opened = await b.open(ctx, new AbortController().signal)
    if (opened.kind !== 'opened') throw new Error('open failed')
    expect(await b.submit(ctx, opened.handle, { inputKind: 'text', prompt: 'x' }, new AbortController().signal))
      .toMatchObject({ kind: 'not_sent', code: 'capability_unavailable' })
  })

  test('submit with a non-executable binary → not_sent startup_failed', async () => {
    const bin = join(root, 'not-exec')
    writeFileSync(bin, '#!/bin/sh\n')
    const b = new CodexExecBackend({ bin, sandbox: 'read-only' })
    const ctx = makeCtx(makeWorkdir(false))
    const opened = await b.open(ctx, new AbortController().signal)
    if (opened.kind !== 'opened') throw new Error('open failed')
    expect(opened.handle.backendTurnId).toBe(`pending:${ctx.executionAttemptId}`)
    expect(await b.submit(ctx, opened.handle, { inputKind: 'text', prompt: 'x' }, new AbortController().signal))
      .toMatchObject({ kind: 'not_sent', code: 'startup_failed' })
  })
})

describe('CodexExecBackend turns', () => {
  test('completed turn: handle with thread id, delivery, tools, text, final text, exit code', async () => {
    const b = backend()
    const ctx = makeCtx(makeWorkdir(true))
    const handle = await start(b, ctx, 'SECRET_PROMPT_TEXT hello')
    expect(handle.pid).toBeGreaterThan(0)
    expect(handle.extra.stdoutPath).toBe(join(ctx.runDir, 'stdout.jsonl'))
    expect(statSync(join(ctx.runDir, 'prompt.txt')).mode & 0o777).toBe(0o600)

    const events = await collect(b.observe(ctx, handle, new AbortController().signal))
    const h = events.find(e => e.type === 'handle')
    expect(h && h.type === 'handle' && h.handle.backendSessionId).toBe(`thread-${handle.pid}`)
    expect(h && h.type === 'handle' && h.handle.backendTurnId).toBe(`thread-${handle.pid}:1`)
    expect(h && h.type === 'handle' && h.handle.extra.stdoutPath).toBe(handle.extra.stdoutPath)
    const types = events.map(e => e.type)
    expect(types.indexOf('handle')).toBeLessThan(types.indexOf('delivery'))
    expect(events.find(e => e.type === 'delivery')).toEqual({ type: 'delivery', status: 'accepted' })
    expect(events.filter(e => e.type === 'tool')).toEqual([
      { type: 'tool', toolCallId: 'item_0', name: 'command_execution', status: 'started', detail: 'bash -lc ls' },
      { type: 'tool', toolCallId: 'item_0', name: 'command_execution', status: 'completed', detail: 'bash -lc ls' },
    ])
    expect(events.filter(e => e.type === 'text')).toEqual([{ type: 'text', streamId: 'item_2', text: 'DONE: SECRET_PROMPT_TEXT hello', mode: 'snapshot' }])
    const end = ended(events)
    expect(end.outcome).toBe('completed')
    expect(end.finalText).toBe('DONE: SECRET_PROMPT_TEXT hello')
    expect(end.protocol).toEqual({ backendFinished: true, activeToolCount: 0, stopReason: 'turn.completed' })
    expect(end.process.exitCode).toBe(0)
    expect(events.some(e => e.type === 'diagnostic')).toBe(false)

    const [spawn] = spawns(ctx)
    expect(spawn.argv.join(' ')).not.toContain('SECRET_PROMPT_TEXT')
    expect(spawn.argv).toEqual(['exec', '--json', '-m', 'gpt-test', '-C', ctx.workdir.canonicalPath, '-s', 'workspace-write',
      '-c', 'approval_policy="never"', '-o', join(ctx.runDir, 'last-message.txt'), '-'])
    expect(spawn.cwd).toBe(ctx.workdir.canonicalPath)
    expect(await b.locate(ctx, handle)).toBe('ended')
  })

  test('--skip-git-repo-check only for non-git workdirs', () => {
    const b = backend()
    const git = makeWorkdir(true)
    const nested = join(git, 'sub')
    mkdirSync(nested)
    expect(b.buildArgv(makeCtx(git), '/x')).not.toContain('--skip-git-repo-check')
    expect(b.buildArgv(makeCtx(nested), '/x')).not.toContain('--skip-git-repo-check')
    const plain = b.buildArgv(makeCtx(makeWorkdir(false)), '/x')
    expect(plain.slice(-2)).toEqual(['--skip-git-repo-check', '-'])
    expect(insideGitRepo(makeWorkdir(false))).toBe(false)
  })

  test('turn.failed → failed with stop reason and exit code 1', async () => {
    const b = backend()
    const ctx = makeCtx(makeWorkdir(false))
    const events = await collect(b.observe(ctx, await start(b, ctx, 'FAIL please'), new AbortController().signal))
    const end = ended(events)
    expect(end).toMatchObject({ outcome: 'failed', failureCode: 'execution_failed', effects: 'none' })
    expect(end.protocol).toEqual({ backendFinished: true, activeToolCount: 0, stopReason: 'model refused' })
    expect(end.process.exitCode).toBe(1)
  })

  test('top-level error → failed', async () => {
    const b = backend()
    const ctx = makeCtx(makeWorkdir(false))
    const end = ended(await collect(b.observe(ctx, await start(b, ctx, 'ERROR'), new AbortController().signal)))
    expect(end.outcome).toBe('failed')
    expect(end.protocol.stopReason).toBe('stream disconnected')
  })

  test('exit before thread.started → delivery not_sent startup_failed', async () => {
    const b = backend()
    const ctx = makeCtx(makeWorkdir(false))
    const handle = await start(b, ctx, 'FAIL_STARTUP')
    const events = await collect(b.observe(ctx, handle, new AbortController().signal))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'delivery', status: 'not_sent', failure: { code: 'startup_failed', ownerSettled: true } })
    const ev = events[0]
    expect(ev.type === 'delivery' && ev.status === 'not_sent' && ev.failure.detail).toContain('fake startup failure')
    expect(await b.locate(ctx, handle)).toBe('absent')
  })

  test('HANG: running, interrupt ends it without a terminal event → failed, backendFinished false', async () => {
    const b = backend()
    const ctx = makeCtx(makeWorkdir(false))
    const handle = await start(b, ctx, 'HANG')
    const it = b.observe(ctx, handle, new AbortController().signal)
    const events: BackendEvent[] = []
    const done = (async () => { for await (const e of it) events.push(e) })()
    while (!events.some(e => e.type === 'delivery')) await Bun.sleep(20)
    expect(await b.locate(ctx, handle)).toBe('running')
    await b.interrupt(ctx, handle)
    await done
    const end = ended(events)
    expect(end.outcome).toBe('failed')
    expect(end.protocol.backendFinished).toBe(false)
    expect(end.process.exitCode).toBe(130)
    expect(groupAlive(handle.pgid)).toBe(false)
    expect(await b.locate(ctx, handle)).toBe('ended')
  })

  test('release kills a process that ignores SIGINT and verifies the group is gone', async () => {
    const b = backend()
    const ctx = makeCtx(makeWorkdir(false))
    const handle = await start(b, ctx, 'HANG_HARD')
    await collect(b.observe(ctx, handle, new AbortController().signal), e => e.type === 'delivery')
    const rel = await b.release(ctx, handle, 300)
    expect(rel).toEqual({ released: true, backgroundWorkSettled: true, detail: 'killed after grace period' })
    expect(groupAlive(handle.pgid)).toBe(false)
    // Releasing again is a verified no-op.
    expect((await b.release(ctx, handle, 300)).released).toBe(true)
  })

  test('re-attach with a new backend instance and the same handle, without re-spawning', async () => {
    const first = backend()
    const ctx = makeCtx(makeWorkdir(false))
    const handle = await start(first, ctx, 'SLOW')
    const abort = new AbortController()
    const early = await collect(first.observe(ctx, handle, abort.signal), e => e.type === 'delivery')
    abort.abort()
    const h = early.find(e => e.type === 'handle')
    if (!h || h.type !== 'handle') throw new Error('no handle event')

    const second = backend()
    expect(await second.locate(ctx, h.handle)).toBe('running')
    const events = await collect(second.observe(ctx, h.handle, new AbortController().signal))
    expect(events.some(e => e.type === 'handle')).toBe(false) // thread id already persisted
    const end = ended(events)
    expect(end.outcome).toBe('completed')
    expect(end.finalText).toBe('DONE: SLOW')
    expect(spawns(ctx)).toHaveLength(1)

    // Re-attaching once more after the end replays the same final facts.
    const again = ended(await collect(backend().observe(ctx, h.handle, new AbortController().signal)))
    expect(again.finalText).toBe('DONE: SLOW')
    expect(again.process.exitCode).toBe(readExit(join(ctx.runDir, 'exit.json'))!.code)
  })

  test('exit code is null (not 0) when exit.json is missing', async () => {
    const b = backend()
    const ctx = makeCtx(makeWorkdir(false))
    const handle = await start(b, ctx, 'plain')
    await collect(b.observe(ctx, handle, new AbortController().signal))
    rmSync(join(ctx.runDir, 'exit.json'))
    expect(ended(await collect(b.observe(ctx, handle, new AbortController().signal))).process.exitCode).toBeNull()
  })

  test('locate: absent when nothing was spawned; observe reports lost', async () => {
    const b = backend()
    const ctx = makeCtx(makeWorkdir(false))
    const opened = await b.open(ctx, new AbortController().signal)
    if (opened.kind !== 'opened') throw new Error('open failed')
    expect(await b.locate(ctx, opened.handle)).toBe('absent')
    expect(await collect(b.observe(ctx, opened.handle, new AbortController().signal))).toEqual([{ type: 'lost', detail: 'codex process was never recorded for this attempt' }])
    expect(await b.replyPermission()).toBe('unknown')
  })
})

describe('reduceAll', () => {
  test('tracks open items, failed tools and ignores events after the terminal one', () => {
    const lines = [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'a', type: 'mcp_tool_call', server: 's', tool: 't', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'b', type: 'file_change', changes: [{ path: 'x', kind: 'add' }], status: 'completed' } },
      { type: 'turn.completed', usage: {} },
      { type: 'turn.failed', error: { message: 'late' } },
    ].map(l => JSON.stringify(l)).join('\n')
    const s = reduceAll(lines)
    expect(s.threadId).toBe('t1')
    expect([...s.openItems]).toEqual(['a'])
    expect(s.toolItemsSeen).toBe(2)
    expect(s.terminal).toEqual({ outcome: 'completed', stopReason: 'turn.completed' })
  })
})
