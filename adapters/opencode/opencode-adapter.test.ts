/**
 * Contract test against a local mock `opencode serve` (Bun.serve), built to
 * match shapes verified against a real `opencode serve` v1.18.15 instance
 * (see comment block at the top of opencode-adapter.ts). This validates
 * OpenCodeAdapter's own HTTP/SSE handling — the async prompt_async flow,
 * status-poll completion, SSE events/permissions, session-id filtering,
 * error mapping, and timeouts.
 *
 * The adapter no longer uses the synchronous `POST /session/{id}/message`:
 * that request had to stay open for the whole turn and was killed by the
 * transport at ~4-5 minutes on long (75+ step) turns. It now starts the turn
 * with prompt_async and finalizes from the message list once idle.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { OpenCodeAdapter, OpenCodeError } from './opencode-adapter'

let server: ReturnType<typeof Bun.serve>
let baseUrl: string
let events: string[] = []
let promptBodies: any[] = []
let lastPromptUrl: URL | null = null
let lastEventUrl: URL | null = null
let promptStatus = 204
let sendGate: Promise<void> | null = null
/** When true, /event never closes and never sends anything after the initial `events` — matches the real OpenCode global stream, which stays open indefinitely. */
let eventStreamNeverCloses = false
/** Overrides GET /session/{id}/message's response — null builds a single-message turn from `turnParts`. */
let messageListBody: any[] | null = null
let messageListStatus = 200
/** Returned by GET /session/status. `{}` means idle. */
let statusBody: Record<string, { type?: string }> = {}
/** The final assistant message's parts for the auto-built turn. */
let turnParts: any[] = [{ type: 'text', text: 'hi there' }]
/** Earlier sibling assistant messages for a multi-step turn, given the user message id. */
let earlierSiblings: (promptId: string) => any[] = () => []
/** When set, the final assistant message carries this `info.error`. */
let assistantError: any = null
let sessionLookupStatus = 200
let lastPromptId: string | null = null
let eventController: ReadableStreamDefaultController | undefined

function encoder() { return new TextEncoder() }

function startMockServer() {
  events = []
  promptBodies = []
  lastPromptUrl = null
  lastEventUrl = null
  sessionLookupStatus = 200
  promptStatus = 204
  sendGate = null
  eventStreamNeverCloses = false
  messageListBody = null
  messageListStatus = 200
  statusBody = {}
  turnParts = [{ type: 'text', text: 'hi there' }]
  earlierSiblings = () => []
  assistantError = null
  lastPromptId = null
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname === '/session/status') return Response.json(statusBody)
      if (req.method === 'POST' && url.pathname === '/session') { lastPromptUrl = url; return Response.json({ id: 'sess-1' }) }
      if (req.method === 'GET' && url.pathname === '/session/sess-1') return Response.json({ id: 'sess-1' }, { status: sessionLookupStatus })
      if (req.method === 'GET' && url.pathname === '/session/missing') return new Response('not found', { status: 404 })
      if (req.method === 'POST' && url.pathname === '/session/sess-1/prompt_async') {
        const body = await req.json()
        promptBodies.push(body)
        lastPromptUrl = url
        lastPromptId = body.messageID ?? 'msg_generated'
        if (sendGate) {
          await Promise.race([
            sendGate,
            new Promise<void>((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('client aborted')))),
          ]).catch(() => {})
        }
        if (req.signal.aborted) return new Response(null, { status: 499 })
        return new Response(null, { status: promptStatus })
      }
      if (req.method === 'POST' && url.pathname === '/session/sess-1/abort') return new Response(null, { status: 200 })
      if (req.method === 'POST' && url.pathname.startsWith('/permission/') && url.pathname.endsWith('/reply')) {
        promptBodies.push(await req.json())
        return new Response(null, { status: 200 })
      }
      if (req.method === 'GET' && url.pathname === '/session/sess-1/message') {
        if (messageListStatus !== 200) return new Response(null, { status: messageListStatus })
        if (messageListBody) return Response.json(messageListBody)
        const promptId = lastPromptId ?? 'msg_generated'
        return Response.json([
          { info: { id: promptId, role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
          ...earlierSiblings(promptId),
          { info: { id: 'msg_reply', parentID: promptId, role: 'assistant', time: { created: 99, completed: 100 }, error: assistantError ?? undefined }, parts: turnParts },
        ])
      }
      if (req.method === 'GET' && url.pathname === '/session/sess-1/diff') {
        return Response.json([{ file: 'a.ts', patch: '+added', additions: 1, deletions: 0, status: 'modified' }])
      }
      if (req.method === 'GET' && url.pathname === '/event') {
        lastEventUrl = url
        const stream = new ReadableStream({
          start(controller) {
            eventController = controller
            // Flush headers immediately (a comment line, ignored by SSEBuffer),
            // otherwise an open-but-empty stream leaves the client fetch pending
            // and `status.connected` never flips true.
            controller.enqueue(encoder().encode(': ok\n\n'))
            for (const e of events) controller.enqueue(encoder().encode(`data: ${e}\n\n`))
            if (!eventStreamNeverCloses) controller.close()
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

function adapter(overrides: Partial<{ requestTimeoutSeconds: number; taskTimeoutSeconds: number; pollIntervalMs: number }> = {}) {
  return new OpenCodeAdapter({ baseUrl, requestTimeoutSeconds: 5, taskTimeoutSeconds: 5, pollIntervalMs: 10, ...overrides })
}

function task(overrides: Partial<{ taskId: string; sessionId: string; prompt: string; directory: string }> = {}) {
  return { taskId: 't1', sessionId: 'sess-1', prompt: 'hello', directory: '/my/proj', ...overrides }
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
    expect(lastPromptUrl?.searchParams.get('directory')).toBe('/my/proj')
  })

  test('resume succeeds for an existing session', async () => {
    expect(await adapter().resumeSession('sess-1')).toEqual({ sessionId: 'sess-1', agent: 'opencode' })
  })

  test('resume throws for a missing session', async () => {
    await expect(adapter().resumeSession('missing')).rejects.toThrow(OpenCodeError)
  })
})

describe('send — async prompt + message-list finalization', () => {
  test('starts with prompt_async, passes our messageID and directory, and finalizes from the message list', async () => {
    const out: any[] = []
    for await (const e of adapter().send(task(), new AbortController().signal)) out.push(e)
    expect(out).toEqual([
      { type: 'task.started', taskId: 't1' },
      { type: 'text.completed', taskId: 't1', text: 'hi there' },
      { type: 'session.idle', taskId: 't1' },
    ])
    expect(promptBodies.length).toBe(1)
    expect(promptBodies[0].parts).toEqual([{ type: 'text', text: 'hello' }])
    expect(promptBodies[0].messageID).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(lastPromptUrl?.searchParams.get('directory')).toBe('/my/proj')
    // /event must also be directory-scoped, or it never carries this session's events.
    expect(lastEventUrl?.searchParams.get('directory')).toBe('/my/proj')
  })

  test('emits attachment.completed for a data: URI file attached to a tool state (e.g. a screenshot tool)', async () => {
    turnParts = [
      {
        type: 'tool', tool: 'playwright_browser_take_screenshot',
        state: {
          status: 'completed',
          attachments: [{ id: 'prt_1', type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA' }],
        },
      },
    ]
    const out: any[] = []
    for await (const e of adapter().send(task(), new AbortController().signal)) out.push(e)
    expect(out).toEqual([
      { type: 'task.started', taskId: 't1' },
      { type: 'tool.completed', taskId: 't1', toolName: 'playwright_browser_take_screenshot' },
      { type: 'attachment.completed', taskId: 't1', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA', filename: undefined },
      { type: 'session.idle', taskId: 't1' },
    ])
  })

  test('ignores a tool attachment whose url is not a data: URI (unsupported for now)', async () => {
    turnParts = [
      {
        type: 'tool', tool: 'bash',
        state: { status: 'completed', attachments: [{ id: 'prt_1', type: 'file', mime: 'image/png', url: 'https://example.com/x.png' }] },
      },
    ]
    const out: string[] = []
    for await (const e of adapter().send(task(), new AbortController().signal)) out.push(e.type)
    expect(out).toEqual(['task.started', 'tool.completed', 'session.idle'])
  })

  test('does not forward an attachment from a tool that errored (may be partial/garbage)', async () => {
    turnParts = [
      {
        type: 'tool', tool: 'playwright_browser_take_screenshot',
        state: {
          status: 'error', error: 'crashed mid-capture',
          attachments: [{ id: 'prt_1', type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA' }],
        },
      },
    ]
    const out: string[] = []
    for await (const e of adapter().send(task(), new AbortController().signal)) out.push(e.type)
    expect(out).toEqual(['task.started', 'tool.failed', 'session.idle'])
  })

  test('emits tool.completed/tool.failed for tool parts in the turn', async () => {
    turnParts = [
      { type: 'tool', tool: 'bash', state: { status: 'completed' } },
      { type: 'tool', tool: 'edit', state: { status: 'error', error: 'denied' } },
    ]
    const out: any[] = []
    for await (const e of adapter().send(task(), new AbortController().signal)) out.push(e)
    expect(out).toEqual([
      { type: 'task.started', taskId: 't1' },
      { type: 'tool.completed', taskId: 't1', toolName: 'bash' },
      { type: 'tool.failed', taskId: 't1', toolName: 'edit', error: 'denied' },
      { type: 'session.idle', taskId: 't1' },
    ])
  })

  test('an error on the assistant message maps to task.failed with the structured message', async () => {
    assistantError = { name: 'APIError', data: { message: 'quota exceeded', isRetryable: true } }
    const out: any[] = []
    for await (const e of adapter().send(task(), new AbortController().signal)) out.push(e)
    expect(out.at(-1)).toEqual({ type: 'task.failed', taskId: 't1', reason: 'quota exceeded' })
  })

  test('maps HTTP 429 on prompt_async to rate_limited task.failed', async () => {
    promptStatus = 429
    const out: any[] = []
    for await (const e of adapter().send(task(), new AbortController().signal)) out.push(e)
    expect(out.at(-1)).toEqual({ type: 'task.failed', taskId: 't1', reason: 'rate_limited' })
  })

  test('maps HTTP 503 on prompt_async to capacity_exhausted task.failed', async () => {
    promptStatus = 503
    const out: any[] = []
    for await (const e of adapter().send(task(), new AbortController().signal)) out.push(e)
    expect(out.at(-1)).toEqual({ type: 'task.failed', taskId: 't1', reason: 'capacity_exhausted' })
  })

  describe('multi-step turns — each assistant step is its own message sharing the user message as parentID', () => {
    test('merges tool calls (and their attachments) from earlier sibling messages with the final text from the last one', async () => {
      earlierSiblings = (promptId) => [
        { info: { id: 'msg_1', parentID: promptId, role: 'assistant', time: { created: 1 } }, parts: [{ type: 'tool', tool: 'navigate', state: { status: 'completed' } }] },
        {
          info: { id: 'msg_2', parentID: promptId, role: 'assistant', time: { created: 2 } },
          parts: [{
            type: 'tool', tool: 'screenshot',
            state: { status: 'completed', attachments: [{ id: 'prt_1', type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA' }] },
          }],
        },
      ]
      turnParts = [{ type: 'text', text: 'done' }]
      const out: any[] = []
      for await (const e of adapter().send(task(), new AbortController().signal)) out.push(e)
      expect(out).toEqual([
        { type: 'task.started', taskId: 't1' },
        { type: 'tool.completed', taskId: 't1', toolName: 'navigate' },
        { type: 'tool.completed', taskId: 't1', toolName: 'screenshot' },
        { type: 'attachment.completed', taskId: 't1', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA', filename: undefined },
        { type: 'text.completed', taskId: 't1', text: 'done' },
        { type: 'session.idle', taskId: 't1' },
      ])
    })

    test('sorts sibling messages by creation time rather than trusting the fetched array order', async () => {
      earlierSiblings = (promptId) => [
        { info: { id: 'msg_2', parentID: promptId, role: 'assistant', time: { created: 1 } }, parts: [{ type: 'tool', tool: 'screenshot', state: { status: 'completed' } }] },
        { info: { id: 'msg_1', parentID: promptId, role: 'assistant', time: { created: 0 } }, parts: [{ type: 'tool', tool: 'navigate', state: { status: 'completed' } }] },
      ]
      turnParts = [{ type: 'text', text: 'done' }]
      const out: string[] = []
      for await (const e of adapter().send(task(), new AbortController().signal)) out.push(e.type === 'tool.completed' ? e.toolName : e.type)
      expect(out).toEqual(['task.started', 'navigate', 'screenshot', 'text.completed', 'session.idle'])
    })
  })
})

describe('send — SSE watched concurrently, status poll as fallback', () => {
  test('surfaces a permission.requested event while the session is still busy', async () => {
    statusBody = { 'sess-1': { type: 'busy' } }
    eventStreamNeverCloses = true
    turnParts = [{ type: 'text', text: 'hi there' }]
    events.push(JSON.stringify({
      type: 'permission.asked',
      properties: { id: 'per_1', sessionID: 'sess-1', permission: 'bash', patterns: [], metadata: {}, always: [] },
    }))

    const iter = adapter().send(task(), new AbortController().signal)[Symbol.asyncIterator]()
    const first = await iter.next()
    expect(first.value).toEqual({ type: 'task.started', taskId: 't1' })
    const second = await iter.next()
    expect(second.value).toEqual({ type: 'permission.requested', taskId: 't1', requestId: 'per_1', toolName: 'bash', description: 'bash' })

    // Let the turn finish; the status poll (no session.idle event was queued) finalizes it.
    statusBody = {}
    const rest: any[] = []
    for (;;) {
      const r = await iter.next()
      if (r.done) break
      rest.push(r.value)
    }
    expect(rest.at(-1)).toEqual({ type: 'session.idle', taskId: 't1' })
  })

  test('session.idle SSE is only a hint; polling confirms completion', async () => {
    statusBody = { 'sess-1': { type: 'busy' } }
    eventStreamNeverCloses = true
    events.push(JSON.stringify({ type: 'session.idle', properties: { sessionID: 'sess-1' } }))
    setTimeout(() => { statusBody = {} }, 30)
    const out: any[] = []
    for await (const e of adapter().send(task(), new AbortController().signal)) out.push(e)
    expect(out.at(-1)).toEqual({ type: 'session.idle', taskId: 't1' })
    expect(out.map(e => e.type)).toContain('text.completed')
  })

  test('filters out events for other sessions', async () => {
    events.push(JSON.stringify({ type: 'message.part.updated', properties: { sessionID: 'other-session', part: { type: 'text', text: 'nope' } } }))
    const out: string[] = []
    for await (const e of adapter().send(task(), new AbortController().signal)) out.push(e.type)
    expect(out).toEqual(['task.started', 'text.completed', 'session.idle'])
  })
})

describe('send — abort / timeout / connection failures', () => {
  test('a caller abort stops the turn via /abort and reports task.aborted', async () => {
    statusBody = { 'sess-1': { type: 'busy' } }
    eventStreamNeverCloses = true
    const ac = new AbortController()
    const iter = adapter().send(task(), ac.signal)[Symbol.asyncIterator]()
    expect((await iter.next()).value).toEqual({ type: 'task.started', taskId: 't1' })
    await new Promise(r => setTimeout(r, 20))
    ac.abort()
    const rest: any[] = []
    for (;;) {
      const r = await iter.next()
      if (r.done) break
      rest.push(r.value)
    }
    expect(rest.at(-1)).toEqual({ type: 'task.aborted', taskId: 't1' })
  })

  test('a turn that never goes idle times out as task_timeout, having watched the event stream the whole time', async () => {
    statusBody = { 'sess-1': { type: 'busy' } }
    eventStreamNeverCloses = true
    const out: any[] = []
    for await (const e of adapter({ taskTimeoutSeconds: 0.2 }).send(task(), new AbortController().signal)) out.push(e)
    expect(out.at(-1)).toEqual({ type: 'task.failed', taskId: 't1', reason: 'task_timeout' })
  })

  test('the same stuck turn, but the /event stream never connected — a mid-task permission would have been unobservable', async () => {
    statusBody = { 'sess-1': { type: 'busy' } }
    const noEventFetch: typeof fetch = ((url: any, init: any) => {
      const u = new URL(String(url))
      if (u.pathname === '/event') return Promise.resolve(new Response('nope', { status: 500 }))
      return fetch(url, init)
    }) as typeof fetch
    const a = new OpenCodeAdapter({ baseUrl, requestTimeoutSeconds: 5, taskTimeoutSeconds: 0.2, pollIntervalMs: 10 }, noEventFetch)
    const out: any[] = []
    for await (const e of a.send(task(), new AbortController().signal)) out.push(e)
    expect(out.at(-1)).toEqual({ type: 'task.failed', taskId: 't1', reason: 'task_timeout_no_event_stream' })
  })

  test('lost prompt acknowledgement observes accepted turn without reposting', async () => {
    const brokenFetch: typeof fetch = ((url: any, init: any) => {
      const u = new URL(String(url))
      if (u.pathname === '/session/sess-1/prompt_async') return fetch(url, init).then(() => { throw new Error('socket hang up') })
      return fetch(url, init)
    }) as typeof fetch
    const a = new OpenCodeAdapter({ baseUrl, requestTimeoutSeconds: 5, taskTimeoutSeconds: 5, pollIntervalMs: 10 }, brokenFetch)
    const out: any[] = []
    for await (const e of a.send(task(), new AbortController().signal)) out.push(e)
    expect(out.at(-1)).toEqual({ type: 'session.idle', taskId: 't1' })
    expect(promptBodies).toHaveLength(1)
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
    expect(promptBodies.at(-1)).toEqual({ reply: 'once' })
  })

  test('maps deny to reject', async () => {
    await adapter().respondPermission('per-1', { requestId: 'per-1', behavior: 'deny' })
    expect(promptBodies.at(-1)).toEqual({ reply: 'reject' })
  })
})

describe('getFinalMessage', () => {
  test('concatenates text parts from the last assistant message', async () => {
    messageListBody = [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'part1' }, { type: 'text', text: 'part2' }] },
    ]
    const msg = await adapter().getFinalMessage('sess-1', 't1')
    expect(msg).toEqual({ taskId: 't1', text: 'part1part2' })
  })
})

describe('getDiff', () => {
  test('maps file/patch to path/diff', async () => {
    const diff = await adapter().getDiff('sess-1', 't1')
    expect(diff).toEqual([{ path: 'a.ts', diff: '+added' }])
  })
})


describe('long-running turn regression', () => {
  async function collect(a = adapter()) {
    const out: any[] = []
    for await (const event of a.send(task(), new AbortController().signal)) out.push(event)
    return out
  }

  test('task survives many short-request timeout windows and an SSE disconnect', async () => {
    statusBody = { 'sess-1': { type: 'busy' } }
    // SSE closes immediately. The turn outlasts the per-request timeout 8x.
    const timer = setTimeout(() => { statusBody = {} }, 160)
    try {
      const out = await collect(adapter({ requestTimeoutSeconds: 0.02, taskTimeoutSeconds: 1 }))
      expect(out.at(-2)?.text).toBe('hi there')
      expect(out.at(-1)?.type).toBe('session.idle')
      expect(promptBodies).toHaveLength(1)
    } finally { clearTimeout(timer) }
  })

  test('late SSE permissions are not consumed by orphaned reads after repeated polls', async () => {
    statusBody = { 'sess-1': { type: 'busy' } }
    eventStreamNeverCloses = true
    const timer = setTimeout(() => eventController?.enqueue(encoder().encode(`data: ${JSON.stringify({
      type: 'permission.asked', properties: { id: 'late', sessionID: 'sess-1', permission: 'bash' },
    })}\n\n`)), 100)
    const out: any[] = []
    try {
      for await (const event of adapter({ taskTimeoutSeconds: 0.5 }).send(task(), new AbortController().signal)) {
        out.push(event)
        if (event.type === 'permission.requested') statusBody = {}
      }
      expect(out.filter(e => e.type === 'permission.requested').map(e => e.requestId)).toEqual(['late'])
      expect(out.at(-1)?.type).toBe('session.idle')
    } finally { clearTimeout(timer) }
  })

  test('recovers transient status failures and pending permissions without SSE', async () => {
    let attempts = 0
    let permissionDirectory: string | null = null
    const fallback: typeof fetch = (async (input: any, init: any) => {
      const url = new URL(String(input))
      if (url.pathname === '/event') return new Response(null, { status: 503 })
      if (url.pathname === '/permission') return Response.json([{ id: 'recovered', sessionID: 'sess-1', permission: 'edit' }])
      if (url.pathname === '/permission/recovered/reply') { permissionDirectory = url.searchParams.get('directory'); return Response.json(true) }
      if (url.pathname === '/session/status' && ++attempts < 4) return new Response(null, { status: 503 })
      return fetch(input, init)
    }) as typeof fetch
    const a = new OpenCodeAdapter({ baseUrl, requestTimeoutSeconds: 0.1, taskTimeoutSeconds: 1, pollIntervalMs: 10 }, fallback)
    const out: any[] = []
    for await (const event of a.send(task(), new AbortController().signal)) {
      out.push(event)
      if (event.type === 'permission.requested') await a.respondPermission(event.requestId, { requestId: event.requestId, behavior: 'allow' })
    }
    expect(out.filter(e => e.type === 'permission.requested')).toHaveLength(1)
    expect(permissionDirectory).toBe('/my/proj')
    expect(attempts).toBe(4)
    expect(out.at(-1)?.type).toBe('session.idle')
  })

  test('ignores stale replies and unfinished/tool-call steps even when idle is reported', async () => {
    let reads = 0
    const staged: typeof fetch = (async (input: any, init: any) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/message')) {
        reads++
        const stale = { info: { role: 'assistant', parentID: 'old', time: { created: Date.now() + 100, completed: 10 } }, parts: [{ type: 'text', text: 'STALE' }] }
        if (reads < 3) return Response.json([stale])
        if (reads < 6) return Response.json([stale, { info: { role: 'assistant', parentID: lastPromptId, finish: reads === 5 ? 'tool-calls' : undefined, time: { created: 1, completed: reads === 5 ? 2 : undefined } }, parts: [{ type: 'text', text: 'NOT FINAL' }] }])
      }
      return fetch(input, init)
    }) as typeof fetch
    const out = await collect(new OpenCodeAdapter({ baseUrl, requestTimeoutSeconds: 0.1, taskTimeoutSeconds: 1, pollIntervalMs: 10 }, staged))
    expect(reads).toBe(6)
    expect(out.filter(e => e.type === 'text.completed').map(e => e.text)).toEqual(['hi there'])
  })

  test('hung prompt POST is bounded; ambiguous acceptance is observed without retry', async () => {
    let posts = 0
    const hung: typeof fetch = (async (input: any, init: any) => {
      if (new URL(String(input)).pathname.endsWith('/prompt_async')) {
        posts++
        lastPromptId = JSON.parse(init.body).messageID
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('request timeout')), { once: true }))
      }
      return fetch(input, init)
    }) as typeof fetch
    const out = await collect(new OpenCodeAdapter({ baseUrl, requestTimeoutSeconds: 0.02, taskTimeoutSeconds: 0.2, pollIntervalMs: 5 }, hung))
    expect(posts).toBe(1)
    expect(out.at(-1)?.type).toBe('session.idle')
  })

  test('task deadline aborts a hung POST despite a longer request timeout', async () => {
    const hung: typeof fetch = (async (input: any, init: any) => {
      if (new URL(String(input)).pathname.endsWith('/prompt_async')) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      return fetch(input, init)
    }) as typeof fetch
    const start = Date.now()
    const out = await collect(new OpenCodeAdapter({ baseUrl, requestTimeoutSeconds: 5, taskTimeoutSeconds: 0.05, pollIntervalMs: 5 }, hung))
    expect(Date.now() - start).toBeLessThan(300)
    expect(out.at(-1)?.reason).toMatch(/^task_timeout/)
  })

  test('only a missing session endpoint signals session_missing, not missing status API', async () => {
    messageListStatus = 404
    sessionLookupStatus = 404
    expect((await collect()).at(-1)?.reason).toBe('session_missing')
    const noStatus: typeof fetch = (async (input: any, init: any) => new URL(String(input)).pathname === '/session/status'
      ? new Response(null, { status: 404 }) : fetch(input, init)) as typeof fetch
    const out = await collect(new OpenCodeAdapter({ baseUrl, requestTimeoutSeconds: 0.1, taskTimeoutSeconds: 0.05, pollIntervalMs: 5 }, noStatus))
    expect(out.at(-1)?.reason).toMatch(/^task_timeout/)
  })
})


test('404 from an unsupported async endpoint does not invalidate an existing session', async () => {
  promptStatus = 404
  const out: any[] = []
  for await (const event of adapter().send(task(), new AbortController().signal)) out.push(event)
  expect(out.at(-1)?.reason).toBe('backend_unavailable')
})

test('caller cancellation interrupts an in-flight POST, not just the polling loop', async () => {
  const ac = new AbortController()
  const hung: typeof fetch = (async (input: any, init: any) => {
    if (new URL(String(input)).pathname.endsWith('/prompt_async')) {
      setTimeout(() => ac.abort(), 15)
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    }
    return fetch(input, init)
  }) as typeof fetch
  const a = new OpenCodeAdapter({ baseUrl, requestTimeoutSeconds: 5, taskTimeoutSeconds: 5, pollIntervalMs: 10 }, hung)
  const out: any[] = []
  for await (const event of a.send(task(), ac.signal)) out.push(event)
  expect(out.at(-1)?.type).toBe('task.aborted')
})


test('keeps completed artifacts from earlier steps when the final assistant errors', async () => {
  assistantError = { name: 'APIError', data: { message: 'backend reset' } }
  earlierSiblings = promptId => [{ info: { role: 'assistant', parentID: promptId, time: { created: 1, completed: 2 } }, parts: [{
    type: 'tool', tool: 'capture', state: { status: 'completed', attachments: [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA' }] },
  }] }]
  const out: any[] = []
  for await (const event of adapter().send(task(), new AbortController().signal)) out.push(event)
  expect(out.map(e => e.type)).toEqual(['task.started', 'tool.completed', 'attachment.completed', 'task.failed'])
  expect(out.at(-1)?.reason).toBe('backend reset')
})
