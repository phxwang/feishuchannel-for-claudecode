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
/** When true, /event never closes and never sends anything after the initial `events` — matches the real OpenCode global stream, which stays open indefinitely and can go quiet for a while. */
let eventStreamNeverCloses = false
/** Overrides GET /session/sess-1/message's response — null uses the fixed default (used by getFinalMessage's test). */
let messageListBody: any[] | null = null
let messageListStatus = 200

function encoder() { return new TextEncoder() }

function startMockServer() {
  events = []
  lastSentBody = null
  lastSentUrl = null
  sendStatus = 200
  sendBody = { info: {}, parts: [{ type: 'text', text: 'hi there' }] }
  sendGate = null
  eventStreamNeverCloses = false
  messageListBody = null
  messageListStatus = 200
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
        if (sendGate) {
          // Race against the client's own abort so a never-resolving sendGate
          // (simulating an unanswered permission) doesn't leak a hung handler
          // past the client's timeout — matches how a real server would also
          // stop caring once the client disconnects.
          await Promise.race([
            sendGate,
            new Promise<void>((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('client aborted')))),
          ]).catch(() => {})
        }
        if (req.signal.aborted) return new Response(null, { status: 499 })
        return sendStatus === 200 ? Response.json(sendBody) : new Response(null, { status: sendStatus })
      }
      if (req.method === 'POST' && url.pathname === '/session/sess-1/abort') return new Response(null, { status: 200 })
      if (req.method === 'POST' && url.pathname.startsWith('/permission/') && url.pathname.endsWith('/reply')) {
        lastSentBody = await req.json()
        return new Response(null, { status: 200 })
      }
      if (req.method === 'GET' && url.pathname === '/session/sess-1/message') {
        if (messageListStatus !== 200) return new Response(null, { status: messageListStatus })
        return Response.json(messageListBody ?? [
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
            if (!eventStreamNeverCloses) controller.close()
            // else: leave it open with nothing further enqueued, like the real
            // global /event stream during a quiet period.
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

  test('emits attachment.completed for a data: URI file attached to a tool state (e.g. a screenshot tool)', async () => {
    sendBody = {
      info: {},
      parts: [
        {
          type: 'tool', tool: 'playwright_browser_take_screenshot',
          state: {
            status: 'completed',
            attachments: [{ id: 'prt_1', type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA' }],
          },
        },
      ],
    }
    const out: any[] = []
    for await (const e of adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)) out.push(e)
    expect(out).toEqual([
      { type: 'task.started', taskId: 't1' },
      { type: 'tool.completed', taskId: 't1', toolName: 'playwright_browser_take_screenshot' },
      { type: 'attachment.completed', taskId: 't1', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA', filename: undefined },
      { type: 'session.idle', taskId: 't1' },
    ])
  })

  test('ignores a tool attachment whose url is not a data: URI (unsupported for now)', async () => {
    sendBody = {
      info: {},
      parts: [
        {
          type: 'tool', tool: 'bash',
          state: { status: 'completed', attachments: [{ id: 'prt_1', type: 'file', mime: 'image/png', url: 'https://example.com/x.png' }] },
        },
      ],
    }
    const out: any[] = []
    for await (const e of adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)) out.push(e.type)
    expect(out).toEqual(['task.started', 'tool.completed', 'session.idle'])
  })

  test('does not forward an attachment from a tool that errored (may be partial/garbage)', async () => {
    sendBody = {
      info: {},
      parts: [
        {
          type: 'tool', tool: 'playwright_browser_take_screenshot',
          state: {
            status: 'error', error: 'crashed mid-capture',
            attachments: [{ id: 'prt_1', type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA' }],
          },
        },
      ],
    }
    const out: any[] = []
    for await (const e of adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)) out.push(e.type)
    expect(out).toEqual(['task.started', 'tool.failed', 'session.idle'])
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

  describe('multi-step turns — the POST response is only the LAST of several assistant messages', () => {
    // Confirmed against a real opencode turn: navigate + screenshot + final text
    // summary land as three separate assistant messages sharing one parentID
    // (the user message), and POST /message only returns the last one.
    test('merges tool calls (and their attachments) from earlier sibling messages the POST response never included', async () => {
      sendBody = { info: { id: 'msg_3', parentID: 'msg_user' }, parts: [{ type: 'text', text: 'done' }] }
      messageListBody = [
        { info: { id: 'msg_user', role: 'user' }, parts: [{ type: 'text', text: 'go' }] },
        { info: { id: 'msg_1', parentID: 'msg_user', role: 'assistant' }, parts: [{ type: 'tool', tool: 'navigate', state: { status: 'completed' } }] },
        {
          info: { id: 'msg_2', parentID: 'msg_user', role: 'assistant' },
          parts: [{
            type: 'tool', tool: 'screenshot',
            state: { status: 'completed', attachments: [{ id: 'prt_1', type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA' }] },
          }],
        },
        { info: { id: 'msg_3', parentID: 'msg_user', role: 'assistant' }, parts: [{ type: 'text', text: 'done' }] },
      ]
      const out: any[] = []
      for await (const e of adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'go' }, new AbortController().signal)) out.push(e)
      expect(out).toEqual([
        { type: 'task.started', taskId: 't1' },
        { type: 'tool.completed', taskId: 't1', toolName: 'navigate' },
        { type: 'tool.completed', taskId: 't1', toolName: 'screenshot' },
        { type: 'attachment.completed', taskId: 't1', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA', filename: undefined },
        { type: 'text.completed', taskId: 't1', text: 'done' },
        { type: 'session.idle', taskId: 't1' },
      ])
    })

    test('does not fetch the message list for a single-step turn (no siblings to merge)', async () => {
      sendBody = { info: { id: 'msg_1', parentID: 'msg_user' }, parts: [{ type: 'text', text: 'hi' }] }
      messageListBody = [] // if this were fetched and used, the response would have no text — proves it wasn't needed
      const out: any[] = []
      for await (const e of adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hi' }, new AbortController().signal)) out.push(e)
      expect(out).toEqual([
        { type: 'task.started', taskId: 't1' },
        { type: 'text.completed', taskId: 't1', text: 'hi' },
        { type: 'session.idle', taskId: 't1' },
      ])
    })

    test('falls back to the POST response alone if the supplementary message-list fetch fails', async () => {
      sendBody = { info: { id: 'msg_3', parentID: 'msg_user' }, parts: [{ type: 'text', text: 'done anyway' }] }
      messageListStatus = 500
      const out: any[] = []
      for await (const e of adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'go' }, new AbortController().signal)) out.push(e)
      expect(out).toEqual([
        { type: 'task.started', taskId: 't1' },
        { type: 'text.completed', taskId: 't1', text: 'done anyway' },
        { type: 'session.idle', taskId: 't1' },
      ])
    })
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

  test('regression: completes even when the SSE stream stays open indefinitely with no further events (real OpenCode /event never closes)', async () => {
    eventStreamNeverCloses = true
    let releaseSend: () => void = () => {}
    sendGate = new Promise<void>((resolve) => { releaseSend = resolve })
    sendBody = { info: {}, parts: [{ type: 'text', text: 'hi there' }] }

    const out: any[] = []
    const donePromise = (async () => {
      for await (const e of adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)) out.push(e)
    })()

    // Give the SSE connection time to actually establish and start its pending
    // read before the POST resolves, so this reproduces the real ordering.
    await new Promise(r => setTimeout(r, 20))
    releaseSend()

    // Bounded wait: before the fix, this hung forever because events.return()
    // doesn't interrupt a pending reader.read() on a stream with no more data.
    const timedOut = Symbol('timeout')
    const result = await Promise.race([donePromise.then(() => 'done'), new Promise(r => setTimeout(() => r(timedOut), 2000))])
    expect(result).toBe('done')
    expect(out.map(e => e.type)).toEqual(['task.started', 'text.completed', 'session.idle'])
  })

  test('filters out events for other sessions', async () => {
    events.push(JSON.stringify({ type: 'message.part.updated', properties: { sessionID: 'other-session', part: { type: 'text', text: 'nope' } } }))
    const out: string[] = []
    for await (const e of adapter().send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)) out.push(e.type)
    expect(out).toEqual(['task.started', 'text.completed', 'session.idle'])
  })
})

describe('send — failure reason distinguishes why the task never came back', () => {
  test('a stuck POST that never resolves (e.g. an unanswered mid-task permission) times out as task_timeout, having watched the whole time', async () => {
    sendGate = new Promise<void>(() => {}) // never resolves — server hangs, matches an unanswered permission.asked
    const out: any[] = []
    for await (const e of adapter({ taskTimeoutSeconds: 0.15 }).send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)) out.push(e)
    expect(out.at(-1)).toEqual({ type: 'task.failed', taskId: 't1', reason: 'task_timeout' })
  })

  test('the same stuck POST, but the /event stream itself never connected — a mid-task permission would have been unobservable', async () => {
    const noEventFetch: typeof fetch = ((url: any, init: any) => {
      const u = new URL(String(url))
      if (u.pathname === '/event') return Promise.resolve(new Response('nope', { status: 500 }))
      return fetch(url, init)
    }) as typeof fetch
    const a = new OpenCodeAdapter({ baseUrl, requestTimeoutSeconds: 5, taskTimeoutSeconds: 0.15 }, noEventFetch)
    sendGate = new Promise<void>(() => {})
    const out: any[] = []
    for await (const e of a.send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)) out.push(e)
    expect(out.at(-1)).toEqual({ type: 'task.failed', taskId: 't1', reason: 'task_timeout_no_event_stream' })
  })

  test('the POST itself fails outright (network error, not a timeout) reports connection_failed with the underlying message', async () => {
    const brokenFetch: typeof fetch = ((url: any, init: any) => {
      const u = new URL(String(url))
      if (u.pathname === '/session/sess-1/message') return Promise.reject(new Error('socket hang up'))
      return fetch(url, init)
    }) as typeof fetch
    const a = new OpenCodeAdapter({ baseUrl, requestTimeoutSeconds: 5, taskTimeoutSeconds: 5 }, brokenFetch)
    const out: any[] = []
    for await (const e of a.send({ taskId: 't1', sessionId: 'sess-1', prompt: 'hello' }, new AbortController().signal)) out.push(e)
    expect(out.at(-1)).toEqual({ type: 'task.failed', taskId: 't1', reason: 'connection_failed: socket hang up' })
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
