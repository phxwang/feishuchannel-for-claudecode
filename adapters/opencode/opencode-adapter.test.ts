/**
 * Contract test against a local mock `opencode serve` (Bun.serve), NOT a
 * real OpenCode instance — see the caveat at the top of opencode-adapter.ts.
 * This validates OpenCodeAdapter's own HTTP/SSE handling (requests, timeouts,
 * SSE parsing, session-id filtering, error mapping), by construction against
 * a server that implements exactly the paths this client expects.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { OpenCodeAdapter, OpenCodeError } from './opencode-adapter'

let server: ReturnType<typeof Bun.serve>
let baseUrl: string
let events: string[] = []
let lastSentBody: any = null
let sendStatus = 200

function encoder() { return new TextEncoder() }

function startMockServer() {
  events = []
  lastSentBody = null
  sendStatus = 200
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname === '/doc') return new Response('ok')
      if (req.method === 'POST' && url.pathname === '/session') return Response.json({ id: 'sess-1' })
      if (req.method === 'GET' && url.pathname === '/session/sess-1') return Response.json({ id: 'sess-1' })
      if (req.method === 'GET' && url.pathname === '/session/missing') return new Response('not found', { status: 404 })
      if (req.method === 'POST' && url.pathname === '/session/sess-1/message') {
        lastSentBody = await req.json()
        return new Response(null, { status: sendStatus })
      }
      if (req.method === 'POST' && url.pathname === '/session/sess-1/abort') return new Response(null, { status: 200 })
      if (req.method === 'POST' && url.pathname.startsWith('/session/sess-1/permissions/')) {
        lastSentBody = await req.json()
        return new Response(null, { status: 200 })
      }
      if (req.method === 'GET' && url.pathname === '/event') {
        const stream = new ReadableStream({
          start(controller) {
            for (const e of events) controller.enqueue(encoder().encode(`data: ${e}\n\n`))
            controller.close()
          },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response('not found', { status: 404 })
    },
  })
  baseUrl = `http://localhost:${server.port}`
}

beforeEach(startMockServer)
afterEach(() => server.stop(true))

function adapter(overrides: Partial<{ requestTimeoutSeconds: number; taskTimeoutSeconds: number }> = {}) {
  return new OpenCodeAdapter({ baseUrl, requestTimeoutSeconds: 5, taskTimeoutSeconds: 5, ...overrides })
}

describe('health', () => {
  test('healthy on 200', async () => {
    expect((await adapter().health({ workdir: '/x' })).healthy).toBe(true)
  })
})

describe('createSession / resumeSession', () => {
  test('creates and parses id', async () => {
    const s = await adapter().createSession({ conversationKey: 'k', projectId: 'p', workdir: '/x' })
    expect(s).toEqual({ sessionId: 'sess-1', agent: 'opencode' })
  })

  test('resume succeeds for an existing session', async () => {
    expect(await adapter().resumeSession('sess-1')).toEqual({ sessionId: 'sess-1', agent: 'opencode' })
  })

  test('resume throws for a missing session', async () => {
    await expect(adapter().resumeSession('missing')).rejects.toThrow(OpenCodeError)
  })
})

describe('send', () => {
  test('delivers the prompt and streams normalized events through to session.idle', async () => {
    events.push(
      JSON.stringify({ type: 'message.part.updated', properties: { sessionID: 'sess-1', part: { type: 'text', text: 'hi there' } } }),
      JSON.stringify({ type: 'session.idle', properties: { sessionID: 'sess-1' } }),
    )
    const out: string[] = []
    for await (const e of adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)) {
      out.push(e.type)
    }
    expect(out).toEqual(['task.started', 'text.delta', 'session.idle'])
    expect(lastSentBody).toEqual({ parts: [{ type: 'text', text: 'hello' }] })
  })

  test('filters out events for other sessions', async () => {
    events.push(
      JSON.stringify({ type: 'message.part.updated', properties: { sessionID: 'other-session', part: { type: 'text', text: 'nope' } } }),
      JSON.stringify({ type: 'session.idle', properties: { sessionID: 'sess-1' } }),
    )
    const out: string[] = []
    for await (const e of adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)) out.push(e.type)
    expect(out).toEqual(['task.started', 'session.idle'])
  })

  test('maps HTTP 429 on send to rate_limited task.failed', async () => {
    sendStatus = 429
    const out: any[] = []
    for await (const e of adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)) out.push(e)
    expect(out).toEqual([{ type: 'task.started' }, { type: 'task.failed', reason: 'rate_limited' }].map((e, i) => ({ ...e, taskId: 't1' })))
  })

  test('maps HTTP 503 on send to capacity_exhausted task.failed', async () => {
    sendStatus = 503
    const out: any[] = []
    for await (const e of adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)) out.push(e)
    expect(out.at(-1)).toEqual({ type: 'task.failed', taskId: 't1', reason: 'capacity_exhausted' })
  })
})

describe('abort', () => {
  test('posts to the abort endpoint without throwing', async () => {
    await expect(adapter().abort('sess-1', 't1')).resolves.toBeUndefined()
  })
})

describe('respondPermission', () => {
  test('throws without a sessionId (interface gap, documented)', async () => {
    await expect(adapter().respondPermission('perm-1', { requestId: 'perm-1', behavior: 'allow' })).rejects.toThrow(OpenCodeError)
  })

  test('posts the decision when given a sessionId directly', async () => {
    await adapter().respondPermission('perm-1', { requestId: 'perm-1', behavior: 'deny' }, 'sess-1')
    expect(lastSentBody).toEqual({ response: 'deny' })
  })
})

describe('getDiff', () => {
  test('fails closed rather than pretending "no changes"', async () => {
    await expect(adapter().getDiff('sess-1')).rejects.toThrow(OpenCodeError)
  })
})
