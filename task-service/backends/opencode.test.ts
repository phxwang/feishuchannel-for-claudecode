/**
 * OpenCodeTaskBackend contract test against a local mock `opencode serve`
 * (Bun.serve) modelled on adapters/opencode/opencode-adapter.test.ts and the
 * shapes verified against a real opencode serve v1.18.15 (`/doc`): sessions
 * are created per attempt, every request is recorded so tests can assert
 * that a prompt is never posted twice and release touches only its session.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { OpenCodeAdapter } from '../../adapters/opencode/opencode-adapter'
import type { AttemptContext, BackendEvent, BackendHandle } from './backend'
import { OpenCodeTaskBackend } from './opencode'

interface Req { method: string; path: string; query: URLSearchParams; body: any }
interface MockSession { status: 'busy' | 'idle'; messages: any[] }

let server: ReturnType<typeof Bun.serve>
let baseUrl: string
let requests: Req[]
let sessions: Map<string, MockSession>
let sessionCounter: number
let createStatus: number
let promptStatus: number
let replyStatus: number
let abortSettles: boolean
let pendingPermissions: any[]
let sseEvents: any[]
let sseNeverCloses: boolean
let sseController: ReadableStreamDefaultController | undefined

const enc = new TextEncoder()

function startMock() {
  requests = []; sessions = new Map(); sessionCounter = 0
  createStatus = 200; promptStatus = 204; replyStatus = 200; abortSettles = true
  pendingPermissions = []; sseEvents = []; sseNeverCloses = false; sseController = undefined
  server = Bun.serve({ port: 0, fetch: handle })
  baseUrl = `http://localhost:${server.port}`
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const text = req.method === 'POST' ? await req.text() : ''
  requests.push({ method: req.method, path: url.pathname, query: url.searchParams, body: text ? JSON.parse(text) : null })
  const m = url.pathname.match(/^\/session\/([^/]+)(\/.*)?$/)
  if (req.method === 'GET' && url.pathname === '/session/status') {
    return Response.json(Object.fromEntries([...sessions].filter(([, s]) => s.status === 'busy').map(([id]) => [id, { type: 'busy' }])))
  }
  if (req.method === 'POST' && url.pathname === '/session') {
    if (createStatus !== 200) return new Response(null, { status: createStatus })
    const id = `ses_${++sessionCounter}`
    sessions.set(id, { status: 'idle', messages: [] })
    return Response.json({ id })
  }
  if (req.method === 'GET' && url.pathname === '/permission') return Response.json(pendingPermissions)
  if (req.method === 'POST' && /^\/permission\/[^/]+\/reply$/.test(url.pathname)) return new Response(null, { status: replyStatus })
  if (req.method === 'GET' && url.pathname === '/event') return sse()
  if (m) {
    const s = sessions.get(m[1])
    if (!s) return new Response('not found', { status: 404 })
    if (req.method === 'GET' && !m[2]) return Response.json({ id: m[1] })
    if (req.method === 'GET' && m[2] === '/message') return Response.json(s.messages)
    if (req.method === 'POST' && m[2] === '/prompt_async') {
      if (promptStatus !== 204) return new Response(null, { status: promptStatus })
      const body = JSON.parse(text)
      s.messages = [...s.messages, { info: { id: body.messageID, role: 'user' }, parts: [] }]
      s.status = 'busy'
      return new Response(null, { status: 204 })
    }
    if (req.method === 'POST' && m[2] === '/abort') { if (abortSettles) s.status = 'idle'; return Response.json(true) }
  }
  return new Response('not found', { status: 404 })
}

function sse(): Response {
  const stream = new ReadableStream({
    start(controller) {
      sseController = controller
      controller.enqueue(enc.encode(': ok\n\n'))
      for (const e of sseEvents) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
      if (!sseNeverCloses) controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

function push(e: any) { sseController?.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)) }

beforeEach(startMock)
afterEach(() => server.stop(true))

function adapter(fetchImpl: typeof fetch = fetch) {
  return new OpenCodeAdapter({ baseUrl, requestTimeoutSeconds: 2, taskTimeoutSeconds: 0.05, pollIntervalMs: 10 }, fetchImpl)
}
function backend(fetchImpl?: typeof fetch, opts = {}) {
  return new OpenCodeTaskBackend(adapter(fetchImpl), { releasePollMs: 5, ...opts })
}
function ctx(overrides: Partial<AttemptContext> = {}): AttemptContext {
  return {
    taskId: 'task_1', executionAttemptId: 'att_1', executionId: 'exe_1', turnId: 'turn_1',
    candidate: { kind: 'opencode', mode: 'http_sse', model: 'anthropic/claude-x', variant: null },
    workdir: { canonicalPath: '/my/proj', dev: 1, ino: 1 }, permissionMode: 'broker', runDir: '/tmp/unused', ...overrides,
  }
}
const signal = () => new AbortController().signal
const prompts = () => requests.filter(r => r.path.endsWith('/prompt_async'))
const mutations = () => requests.filter(r => r.method !== 'GET')

async function opened(b: OpenCodeTaskBackend): Promise<BackendHandle> {
  const r = await b.open(ctx(), signal())
  if (r.kind !== 'opened') throw new Error(`open failed: ${r.detail}`)
  return r.handle
}

function assistant(promptId: string, parts: any[], extra: Record<string, unknown> = {}) {
  return { info: { id: 'msg_reply', role: 'assistant', parentID: promptId, time: { created: 2, completed: 3 }, ...extra }, parts }
}

async function collect(it: AsyncIterable<BackendEvent>): Promise<BackendEvent[]> {
  const out: BackendEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

describe('capabilities / preflight', () => {
  test('advertises the design §9.2 profile and caches health', async () => {
    const b = backend()
    const caps = await b.capabilities()
    await b.capabilities()
    expect(caps).toMatchObject({ kind: 'opencode', mode: 'http_sse', available: true, permissionModes: ['broker', 'backend_policy'] })
    expect(caps.features.recoverAcceptedTurn).toBe(true)
    expect(caps.fallback.supportedFallbackTriggers.map(t => `${t.code}@${t.stage}`))
      .toEqual(['backend_unavailable@before_delivery', 'startup_failed@before_delivery', 'rate_limited@before_delivery', 'provider_unavailable@before_delivery'])
    expect(caps.fallback).toMatchObject({ cleanFailureFallback: false, checkpointHandoff: false, sameOwnerResetRecovery: false, nativeGoal: false })
    expect(requests.filter(r => r.path === '/session/status')).toHaveLength(1)
  })

  test('preflight maps an unreachable server to backend_unavailable', async () => {
    const down = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect(await backend(down).preflight(ctx(), signal())).toMatchObject({ kind: 'not_sent', code: 'backend_unavailable' })
    expect(await backend().preflight(ctx(), signal())).toEqual({ kind: 'ok' })
  })
})

describe('open', () => {
  test('creates a new session scoped to the workdir per attempt, with a fresh message id', async () => {
    const b = backend()
    const a = await opened(b)
    const c = await opened(b)
    expect(a.backendSessionId).toBe('ses_1')
    expect(c.backendSessionId).toBe('ses_2')
    expect(a.backendTurnId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(a.backendTurnId).not.toBe(c.backendTurnId)
    expect(a.extra).toEqual({ directory: '/my/proj' })
    const creates = requests.filter(r => r.method === 'POST' && r.path === '/session')
    expect(creates.map(r => r.query.get('directory'))).toEqual(['/my/proj', '/my/proj'])
    expect(prompts()).toHaveLength(0)
  })

  test('an HTTP error is startup_failed with nothing to release', async () => {
    createStatus = 500
    expect(await backend().open(ctx(), signal())).toMatchObject({ kind: 'not_sent', code: 'startup_failed', ownerSettled: true })
  })
})

describe('submit', () => {
  test('posts once with the persisted message id, the candidate model and the directory', async () => {
    const b = backend()
    const h = await opened(b)
    expect(await b.submit(ctx(), h, { inputKind: 'text', prompt: 'do it' }, signal())).toEqual({ kind: 'accepted' })
    expect(prompts()).toHaveLength(1)
    const [p] = prompts()
    expect(p.path).toBe('/session/ses_1/prompt_async')
    expect(p.query.get('directory')).toBe('/my/proj')
    expect(p.body).toEqual({ messageID: h.backendTurnId, model: { providerID: 'anthropic', modelID: 'claude-x' }, parts: [{ type: 'text', text: 'do it' }] })
  })

  test.each([
    [429, 'rate_limited'],
    [503, 'provider_unavailable'],
    [400, 'startup_failed'],
    [500, 'startup_failed'],
  ])('HTTP %d is not_sent %s and leaves the empty session to be released', async (status, code) => {
    const b = backend()
    const h = await opened(b)
    promptStatus = status
    expect(await b.submit(ctx(), h, { inputKind: 'text', prompt: 'x' }, signal())).toMatchObject({ kind: 'not_sent', code, ownerSettled: false })
    expect(prompts()).toHaveLength(1)
  })

  test('a network error after the request left is unknown and the POST is never repeated', async () => {
    const lossy = (async (input: any, init: any) => {
      const res = await fetch(input, init)
      if (new URL(String(input)).pathname.endsWith('/prompt_async')) throw new Error('socket hang up')
      return res
    }) as typeof fetch
    const b = backend(lossy)
    const h = await opened(b)
    expect(await b.submit(ctx(), h, { inputKind: 'text', prompt: 'x' }, signal())).toMatchObject({ kind: 'unknown' })
    expect(prompts()).toHaveLength(1)
  })

  test('native_goal input is rejected without any request', async () => {
    const b = backend()
    const h = await opened(b)
    expect(await b.submit(ctx(), h, { inputKind: 'native_goal', prompt: 'x' }, signal())).toMatchObject({ kind: 'not_sent', code: 'capability_unavailable' })
    expect(prompts()).toHaveLength(0)
  })
})

describe('observe', () => {
  test('maps SSE text snapshots, tool events, permissions and the completed turn', async () => {
    const b = backend()
    const h = await opened(b)
    await b.submit(ctx(), h, { inputKind: 'text', prompt: 'x' }, signal())
    const s = sessions.get('ses_1')!
    const id = h.backendTurnId
    sseNeverCloses = true
    const base = { sessionID: 'ses_1' }
    sseEvents = [
      { type: 'message.updated', properties: { ...base, info: { id, role: 'user', sessionID: 'ses_1' } } },
      // The prompt's own text part is input, never output.
      { type: 'message.part.updated', properties: { ...base, part: { id: 'prt_in', messageID: id, type: 'text', text: 'x' } } },
      { type: 'message.part.updated', properties: { ...base, part: { id: 'prt_a', messageID: 'msg_reply', type: 'text', text: 'Hel' } } },
      { type: 'message.part.updated', properties: { ...base, part: { id: 'prt_a', messageID: 'msg_reply', type: 'text', text: 'Hello' } } },
      { type: 'message.part.updated', properties: { ...base, part: { id: 'prt_t', messageID: 'msg_reply', type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'running' } } } },
      { type: 'message.part.updated', properties: { ...base, part: { id: 'prt_t', messageID: 'msg_reply', type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'running' } } } },
      { type: 'permission.asked', properties: { ...base, id: 'per_1', permission: 'bash', patterns: [], metadata: {}, always: [], tool: { messageID: 'msg_reply', callID: 'call_1' } } },
    ]
    const out: BackendEvent[] = []
    for await (const e of b.observe(ctx(), h, signal())) {
      out.push(e)
      if (e.type === 'permission.requested') {
        s.messages = [...s.messages, assistant(id, [
          { id: 'prt_t', messageID: 'msg_reply', type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'completed' } },
          { id: 'prt_a', messageID: 'msg_reply', type: 'text', text: 'Hello world' },
        ])]
        s.status = 'idle'
      }
    }
    expect(out).toEqual([
      { type: 'delivery', status: 'accepted' },
      { type: 'text', streamId: 'prt_a', text: 'Hel', mode: 'snapshot' },
      { type: 'text', streamId: 'prt_a', text: 'Hello', mode: 'snapshot' },
      { type: 'tool', toolCallId: 'call_1', name: 'bash', status: 'started' },
      { type: 'permission.requested', backendRequestId: 'per_1', toolCallId: 'call_1', toolName: 'bash', description: 'bash' },
      { type: 'tool', toolCallId: 'call_1', name: 'bash', status: 'completed' },
      { type: 'text', streamId: 'prt_a', text: 'Hello world', mode: 'snapshot' },
      {
        type: 'turn.ended', outcome: 'completed', finalText: 'Hello world',
        protocol: { backendFinished: true, activeToolCount: 0, stopReason: 'completed' },
        process: { exitCode: null, signal: null, controlledShutdown: null }, effects: 'unknown',
      },
    ])
    expect(prompts()).toHaveLength(1)
  })

  test('an assistant error ends the turn as failed with the error message', async () => {
    const b = backend()
    const h = await opened(b)
    await b.submit(ctx(), h, { inputKind: 'text', prompt: 'x' }, signal())
    const s = sessions.get('ses_1')!
    s.messages = [...s.messages, assistant(h.backendTurnId, [], { error: { name: 'APIError', data: { message: 'provider exploded' } } })]
    s.status = 'idle'
    const out = await collect(b.observe(ctx(), h, signal()))
    expect(out.at(-1)).toMatchObject({ type: 'turn.ended', outcome: 'failed', finalText: null, failureCode: 'execution_failed', protocol: { stopReason: 'provider exploded' } })
  })

  test('after an ambiguous ack, seeing our user message reports delivery accepted', async () => {
    const lossy = (async (input: any, init: any) => {
      const res = await fetch(input, init)
      if (new URL(String(input)).pathname.endsWith('/prompt_async')) throw new Error('socket hang up')
      return res
    }) as typeof fetch
    const b = backend(lossy)
    const h = await opened(b)
    expect((await b.submit(ctx(), h, { inputKind: 'text', prompt: 'x' }, signal())).kind).toBe('unknown')
    const s = sessions.get('ses_1')!
    expect(s.status).toBe('busy') // no SSE events: acceptance must come from the message list while busy
    const out: BackendEvent[] = []
    for await (const e of b.observe(ctx(), h, signal())) {
      out.push(e)
      if (e.type === 'delivery') { s.messages = [...s.messages, assistant(h.backendTurnId, [{ id: 'prt_a', type: 'text', text: 'ok' }])]; s.status = 'idle' }
    }
    expect(out[0]).toEqual({ type: 'delivery', status: 'accepted' })
    expect(out.at(-1)).toMatchObject({ type: 'turn.ended', outcome: 'completed', finalText: 'ok', effects: 'none' })
    expect(prompts()).toHaveLength(1)
  })

  test('a session that disappears is lost', async () => {
    const b = backend()
    const h = await opened(b)
    await b.submit(ctx(), h, { inputKind: 'text', prompt: 'x' }, signal())
    sessions.delete('ses_1')
    expect((await collect(b.observe(ctx(), h, signal()))).at(-1)).toMatchObject({ type: 'lost' })
  })

  test('persistent polling failure is lost; caller abort just stops without aborting the session', async () => {
    const b = backend()
    const h = await opened(b)
    await b.submit(ctx(), h, { inputKind: 'text', prompt: 'x' }, signal())
    const failing = (async (input: any, init: any) => new URL(String(input)).pathname === '/session/status'
      ? new Response(null, { status: 500 }) : fetch(input, init)) as typeof fetch
    const lost = await collect(new OpenCodeTaskBackend(adapter(failing), { maxConsecutivePollFailures: 3 }).observe(ctx(), h, signal()))
    expect(lost.at(-1)).toMatchObject({ type: 'lost' })

    const ac = new AbortController()
    setTimeout(() => ac.abort(), 40)
    const out = await collect(b.observe(ctx(), h, ac.signal))
    expect(out.filter(e => e.type === 'turn.ended' || e.type === 'lost')).toHaveLength(0)
    expect(requests.filter(r => r.path.endsWith('/abort'))).toHaveLength(0)
  })
})

describe('replyPermission / interrupt', () => {
  test('maps allow/deny to once/reject; non-2xx is unknown', async () => {
    const b = backend()
    const h = await opened(b)
    expect(await b.replyPermission(ctx(), h, 'per_1', 'allow_once')).toBe('confirmed')
    expect(await b.replyPermission(ctx(), h, 'per_2', 'deny_once')).toBe('confirmed')
    const replies = requests.filter(r => r.path.startsWith('/permission/'))
    expect(replies.map(r => [r.path, r.body.reply, r.query.get('directory')])).toEqual([
      ['/permission/per_1/reply', 'once', '/my/proj'], ['/permission/per_2/reply', 'reject', '/my/proj'],
    ])
    replyStatus = 500
    expect(await b.replyPermission(ctx(), h, 'per_3', 'allow_once')).toBe('unknown')
  })

  test('interrupt aborts exactly the attempt session', async () => {
    const b = backend()
    const h = await opened(b)
    await b.interrupt(ctx(), h)
    expect(mutations().map(r => `${r.method} ${r.path}`)).toEqual(['POST /session', 'POST /session/ses_1/abort'])
  })
})

describe('release', () => {
  test('aborts only the exact busy session, verifies it settled, keeps it, and never calls a server-level endpoint', async () => {
    const b = backend()
    const other = await opened(b)
    const h = await opened(b)
    await b.submit(ctx(), other, { inputKind: 'text', prompt: 'other' }, signal())
    await b.submit(ctx(), h, { inputKind: 'text', prompt: 'mine' }, signal())
    const before = mutations().length
    expect(await b.release(ctx(), h, 200)).toEqual({ released: true, backgroundWorkSettled: true, detail: expect.stringContaining('ses_2') })
    expect(mutations().slice(before).map(r => `${r.method} ${r.path}`)).toEqual(['POST /session/ses_2/abort'])
    expect(requests.every(r => r.method !== 'DELETE')).toBe(true)
    expect(sessions.get('ses_1')!.status).toBe('busy')
    expect(sessions.has('ses_2')).toBe(true)
  })

  test('an idle empty session releases without any abort', async () => {
    const b = backend()
    const h = await opened(b)
    expect((await b.release(ctx(), h, 50)).released).toBe(true)
    expect(requests.filter(r => r.path.endsWith('/abort'))).toHaveLength(0)
  })

  test('still busy after the grace period is not released', async () => {
    abortSettles = false
    const b = backend()
    const h = await opened(b)
    await b.submit(ctx(), h, { inputKind: 'text', prompt: 'x' }, signal())
    expect(await b.release(ctx(), h, 30)).toMatchObject({ released: false, backgroundWorkSettled: false })
  })

  test('a running tool part of this turn blocks release; an unreachable server is unverified', async () => {
    const b = backend()
    const h = await opened(b)
    sessions.get('ses_1')!.messages = [assistant(h.backendTurnId, [{ type: 'tool', tool: 'bash', state: { status: 'running' } }], { time: { created: 1 } })]
    expect((await b.release(ctx(), h, 30)).released).toBe(false)
    const down = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect(await backend(down).release(ctx(), h, 30)).toMatchObject({ released: null, backgroundWorkSettled: null })
  })
})

describe('locate', () => {
  test('absent / running / ended / missing / unreachable', async () => {
    const b = backend()
    const h = await opened(b)
    expect(await b.locate(ctx(), h)).toBe('absent')
    await b.submit(ctx(), h, { inputKind: 'text', prompt: 'x' }, signal())
    expect(await b.locate(ctx(), h)).toBe('running')
    const s = sessions.get('ses_1')!
    s.messages = [...s.messages, assistant(h.backendTurnId, [{ type: 'text', text: 'done' }])]
    s.status = 'idle'
    expect(await b.locate(ctx(), h)).toBe('ended')
    expect(await b.locate(ctx(), { ...h, backendSessionId: 'ses_gone' })).toBe('missing')
    const down = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect(await backend(down).locate(ctx(), h)).toBe('unreachable')
    expect(prompts()).toHaveLength(1)
  })
})
