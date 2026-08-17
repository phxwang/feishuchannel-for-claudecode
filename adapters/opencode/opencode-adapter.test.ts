/**
 * Contract test against a local mock `opencode serve` (Bun.serve), built to
 * match shapes verified against a real `opencode serve` v1.18.15 instance
 * (see comment block at the top of opencode-adapter.ts). This validates
 * OpenCodeAdapter's own HTTP/SSE handling — requests, timeouts, SSE
 * parsing, session-id filtering, error mapping, and the concurrent
 * POST-vs-SSE race for mid-task permission requests.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { OpenCodeAdapter, OpenCodeError } from './opencode-adapter'

let server: ReturnType<typeof Bun.serve>
let baseUrl: string
let events: string[] = []
let lastSentBody: any = null
let lastSentUrl: URL | null = null
let sendStatus = 200
let sendBody: any = { info: {}, parts: [{ type: 'text', text: 'hi there' }] }
/** When set, /session/{id}/message doesn't resolve until this promise does — lets tests simulate a mid-task permission block. */
let sendGate: Promise<void> | null = null

function encoder() { return new TextEncoder() }

function startMockServer() {
  events = []
  lastSentBody = null
  lastSentUrl = null
  sendStatus = 200
  sendBody = { info: {}, parts: [{ type: 'text', text: 'hi there' }] }
  sendGate = null
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname === '/session/status') return Response.json({})
      if (req.method === 'POST' && url.pathname === '/session') { lastSentUrl = url; return Response.json({ id: 'sess-1' }) }
      if (req.method === 'GET' && url.pathname === '/session/sess-1') return Response.json({ id: 'sess-1' })
      if (req.method === 'GET' && url.pathname === '/session/missing') return new Response('not found', { status: 404 })
      if (req.method === 'POST' && url.pathname === '/session/sess-1/message') {
        lastSentBody = await req.json()
        if (sendGate) await sendGate
        return sendStatus === 200 ? Response.json(sendBody) : new Response(null, { status: sendStatus })
      }
      if (req.method === 'POST' && url.pathname === '/session/sess-1/abort') return new Response(null, { status: 200 })
      if (req.method === 'POST' && url.pathname.startsWith('/permission/') && url.pathname.endsWith('/reply')) {
        lastSentBody = await req.json()
        return new Response(null, { status: 200 })
      }
      if (req.method === 'GET' && url.pathname === '/session/sess-1/message') {
        return Response.json([
          { info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
          { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'part1' }, { type: 'text', text: 'part2' }] },
        ])
      }
      if (req.method === 'GET' && url.pathname === '/session/sess-1/diff') {
        lastSentUrl = url
        return Response.json([{ file: 'a.ts', patch: '+added', additions: 1, deletions: 0, status: 'modified' }])
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
  test('healthy on 200 from /session/status', async () => {
    expect((await adapter().health({ workdir: '/x' })).healthy).toBe(true)
  })
})

describe('createSession / resumeSession', () => {
  test('creates, parses id, and scopes to the workdir via ?directory=', async () => {
    const s = await adapter().createSession({ conversationKey: 'k', projectId: 'p', workdir: '/my/proj' })
    expect(s).toEqual({ sessionId: 'sess-1', agent: 'opencode' })
    expect(lastSentUrl?.searchParams.get('directory')).toBe('/my/proj')
  })

  test('resume succeeds for an existing session', async () => {
    expect(await adapter().resumeSession('sess-1')).toEqual({ sessionId: 'sess-1', agent: 'opencode' })
  })

  test('resume throws for a missing session', async () => {
    await expect(adapter().resumeSession('missing')).rejects.toThrow(OpenCodeError)
  })
})

describe('send — synchronous POST response is authoritative', () => {
  test('delivers the prompt and finalizes from the response body', async () => {
    sendBody = { info: {}, parts: [{ type: 'text', text: 'hi there' }] }
    const out: string[] = []
    for await (const e of adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)) out.push(e.type)
    expect(out).toEqual(['task.started', 'text.completed', 'session.idle'])
    expect(lastSentBody).toEqual({ parts: [{ type: 'text', text: 'hello' }] })
  })

  test('emits tool.completed/tool.failed for tool parts in the response', async () => {
    sendBody = {
      info: {},
      parts: [
        { type: 'tool', tool: 'bash', state: { status: 'completed' } },
        { type: 'tool', tool: 'edit', state: { status: 'error', error: 'denied' } },
      ],
    }
    const out: any[] = []
    for await (const e of adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)) out.push(e)
    expect(out).toEqual([
      { type: 'task.started', taskId: 't1' },
      { type: 'tool.completed', taskId: 't1', toolName: 'bash' },
      { type: 'tool.failed', taskId: 't1', toolName: 'edit', error: 'denied' },
      { type: 'session.idle', taskId: 't1' },
    ])
  })

  test('info.error in the response maps to task.failed with the structured message', async () => {
    sendBody = { info: { error: { name: 'APIError', data: { message: 'quota exceeded', isRetryable: true } } }, parts: [] }
    const out: any[] = []
    for await (const e of adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)) out.push(e)
    expect(out.at(-1)).toEqual({ type: 'task.failed', taskId: 't1', reason: 'quota exceeded' })
  })

  test('maps HTTP 429 on send to rate_limited task.failed', async () => {
    sendStatus = 429
    const out: any[] = []
    for await (const e of adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)) out.push(e)
    expect(out.at(-1)).toEqual({ type: 'task.failed', taskId: 't1', reason: 'rate_limited' })
  })

  test('maps HTTP 503 on send to capacity_exhausted task.failed', async () => {
    sendStatus = 503
    const out: any[] = []
    for await (const e of adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)) out.push(e)
    expect(out.at(-1)).toEqual({ type: 'task.failed', taskId: 't1', reason: 'capacity_exhausted' })
  })
})

describe('send — SSE watched concurrently for mid-task events', () => {
  test('surfaces a permission.requested event while the POST is still blocked', async () => {
    let releaseSend: () => void = () => {}
    sendGate = new Promise<void>((resolve) => { releaseSend = resolve })
    events.push(JSON.stringify({
      type: 'permission.asked',
      properties: { id: 'per_1', sessionID: 'sess-1', permission: 'bash', patterns: [], metadata: {}, always: [] },
    }))

    const iter = adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)[Symbol.asyncIterator]()
    const first = await iter.next()
    expect(first.value).toEqual({ type: 'task.started', taskId: 't1' })
    const second = await iter.next()
    expect(second.value).toEqual({ type: 'permission.requested', taskId: 't1', requestId: 'per_1', toolName: 'bash', description: 'bash' })

    releaseSend()
    const third = await iter.next()
    expect(third.value).toEqual({ type: 'text.completed', taskId: 't1', text: 'hi there' })
    const fourth = await iter.next()
    expect(fourth.value).toEqual({ type: 'session.idle', taskId: 't1' })
  })

  test('filters out events for other sessions', async () => {
    events.push(JSON.stringify({ type: 'message.part.updated', properties: { sessionID: 'other-session', part: { type: 'text', text: 'nope' } } }))
    const out: string[] = []
    for await (const e of adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)) out.push(e.type)
    expect(out).toEqual(['task.started', 'text.completed', 'session.idle'])
  })
})

describe('abort', () => {
  test('posts to the abort endpoint without throwing', async () => {
    await expect(adapter().abort('sess-1', 't1')).resolves.toBeUndefined()
  })
})

describe('respondPermission', () => {
  test('posts to the global /permission/{id}/reply endpoint, no sessionId needed', async () => {
    await adapter().respondPermission('per-1', { requestId: 'per-1', behavior: 'allow' })
    expect(lastSentBody).toEqual({ reply: 'once' })
  })

  test('maps deny to reject', async () => {
    await adapter().respondPermission('per-1', { requestId: 'per-1', behavior: 'deny' })
    expect(lastSentBody).toEqual({ reply: 'reject' })
  })
})

describe('getFinalMessage', () => {
  test('concatenates text parts from the last assistant message', async () => {
    const msg = await adapter().getFinalMessage('sess-1', 't1')
    expect(msg).toEqual({ taskId: 't1', text: 'part1part2' })
  })
})

describe('getDiff', () => {
  test('maps file/patch to path/diff', async () => {
    const diff = await adapter().getDiff('sess-1', 't1')
    expect(diff).toEqual([{ path: 'a.ts', diff: '+added' }])
    expect(lastSentUrl?.searchParams.get('messageID')).toBe('t1')
  })
})
