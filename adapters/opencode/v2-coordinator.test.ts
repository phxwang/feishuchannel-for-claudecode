import { describe, expect, test } from 'bun:test'
import { V2SessionCoordinator, nativeInputId, coordinatorKey } from './v2-coordinator'
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean) { for (let n = 0; n < 400; n++) { if (check()) return; await sleep(5) }; throw new Error('condition timed out') }
function fixture(options: { lostAck?: boolean; denied?: boolean; idleTimeoutMs?: number; sse?: boolean; projectionFailsOnce?: boolean } = {}) {
  const history: any[] = [], messages: any[] = [], permissions: any[] = [], posts: any[] = [], started: string[] = [], settled: any[] = [], emitted: any[] = []
  let busy = false, streams = 0, projectionFailures = options.projectionFailsOnce ? 1 : 0
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  const event = (type: string, data: any = {}) => { history.push({ type: `session.next.${type}`, durable: { seq: history.length + 1 }, data: { sessionID: 'ses_test', ...data } });
    streamController?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(history.at(-1))}\r\n\r\n`)) }
  const fetcher = (async (input: any, init: any = {}) => {
    const url = new URL(String(input)), path = url.pathname
    if (path.endsWith('/wait')) {
      if (!busy) return new Response(null, { status: 204 })
      return new Promise<Response>((_, reject) => { if (init.signal.aborted) reject(new Error('aborted')); else init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }) })
    }
    if (path.endsWith('/event')) {
      streams++
      if (!options.sse) return new Response('', { status:503 })
      return new Response(new ReadableStream({start(controller) {
        streamController = controller
        for (const item of history.filter(e => e.durable.seq > Number(url.searchParams.get('after')))) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(item)}\r\n\r\n`))
        init.signal.addEventListener('abort', () => { streamController = undefined; controller.close() }, {once:true})
      }}), {headers:{'content-type':'text/event-stream'}})
    }
    if (path.endsWith('/history')) return Response.json({ data: history.filter(e => e.durable.seq > Number(url.searchParams.get('after'))), hasMore: false })
    if (path.endsWith('/message')) { if (projectionFailures-- > 0) return new Response('{}', {status:503}); return Response.json({ data: messages, cursor: {} }) }
    if (path.endsWith('/permission')) return Response.json({ data: permissions })
    if (path.includes('/permission/') && path.endsWith('/reply')) { posts.push(JSON.parse(init.body)); return new Response(null, {status:204}) }
    if (path.endsWith('/interrupt')) { busy = false; return new Response(null, { status: 204 }) }
    if (path.endsWith('/prompt')) {
      const body = JSON.parse(init.body); posts.push(body)
      if (options.denied) return new Response('{}', { status: 409 })
      busy = true; event('prompt.admitted', { messageID: body.id, delivery: body.delivery })
      if (options.lostAck) throw new Error('lost acknowledgement')
      return Response.json({ data: { id: body.id, sessionID: 'ses_test', admittedSeq: history.length } })
    }
    throw new Error(path)
  }) as typeof fetch
  const coordinator = new V2SessionCoordinator({ baseUrl: 'http://localhost:123', directory: '/tmp', sessionId: 'ses_test',
    requestTimeoutMs: 100, idleTimeoutMs: options.idleTimeoutMs ?? 10000, hardCapMs: 10000, pollMs: 5, calibrationMs: 1 }, {
    started: id => { started.push(id) }, event: (id, e) => { emitted.push({ id, ...e }) },
    settled: async (id, texts, outcome) => { settled.push({ id, texts, outcome }) },
  }, fetcher)
  const consume = (id: string, msg: string) => { event('prompted', { messageID: id }); event('step.started', { assistantMessageID: msg }) }
  const finish = (msg: string, text: string) => { event('text.ended', { assistantMessageID: msg, textID: msg + '-text', text }); event('step.ended', { assistantMessageID: msg });
    messages.push({ id: msg, type: 'assistant', time: { completed: 1 }, finish: 'stop', content: [{ id: msg + '-text', type: 'text', text }] }) }
  return { coordinator, history, messages, permissions, posts, started, settled, emitted, event, consume, finish, idle: () => { busy = false }, streams: () => streams }
}

describe('native v2 execution groups at actual HTTP/durable boundaries', () => {
  test('steer B/C joins busy A; one observer/card owner, ordered per-step final text', async () => {
    const f = fixture()
    const a = await f.coordinator.submit('chat1', 'A', 'start')
    f.consume(nativeInputId('ses_test', 'A'), 'ma'); f.event('tool.called', { assistantMessageID: 'ma', callID: 'tool1', tool: 'bash' })
    const b = await f.coordinator.submit('chat1', 'B', 'constraint')
    const c = await f.coordinator.submit('chat1', 'C', 'more')
    expect(a.joined).toBe(false); expect(b.joined).toBe(true); expect(c.groupId).toBe(a.groupId)
    f.finish('ma', 'checking'); f.consume(nativeInputId('ses_test', 'B'), 'mb'); f.consume(nativeInputId('ses_test', 'C'), 'mc')
    f.finish('mc', 'conclusion'); f.idle(); await until(() => f.settled.length === 1)
    expect(f.started.length).toBe(1); expect(f.streams()).toBe(1)
    expect(f.settled[0].texts.map((p: any) => p.text)).toEqual(['checking', 'conclusion'])
    expect(f.posts.map(x => x.delivery)).toEqual(['steer', 'steer', 'steer'])
  })
  test('queue remains separate; all inputs consumed before group completion', async () => {
    const f = fixture(), a = await f.coordinator.submit('chat1', 'A', 'one')
    f.consume(nativeInputId('ses_test', 'A'), 'ma'); f.finish('ma', 'one done')
    const q = await f.coordinator.submit('chat1', 'Q', 'two', 'queue')
    expect(q.joined).toBe(false); expect(q.groupId).not.toBe(a.groupId)
    f.idle(); await until(() => f.settled.some(x => x.id === a.groupId))
    expect(f.settled.some(x => x.id === q.groupId)).toBe(false)
    f.consume(nativeInputId('ses_test', 'Q'), 'mq'); f.finish('mq', 'queue done')
    await until(() => f.settled.length === 2)
    expect(f.settled[1].texts[0].text).toBe('queue done')
  })
  test('new input after idle evidence creates a new owner instead of suppressing its reply', async () => {
    const f = fixture(), a = await f.coordinator.submit('chat1', 'A', 'one')
    f.consume(nativeInputId('ses_test', 'A'), 'ma'); f.finish('ma', 'done'); f.idle()
    const b = await f.coordinator.submit('chat1', 'B', 'new')
    expect(b.joined).toBe(false); expect(b.groupId).not.toBe(a.groupId)
    f.consume(nativeInputId('ses_test', 'B'), 'mb'); f.finish('mb', 'new done'); f.idle()
    await until(() => f.settled.length === 2)
  })
  test('duplicate Feishu input never POSTs twice, and unknown ack does not fall back', async () => {
    const f = fixture({ lostAck: true }), a = await f.coordinator.submit('chat1', 'A', 'one')
    expect(a.status).toBe('outcome_unknown')
    expect(await f.coordinator.submit('chat1', 'A', 'one')).toEqual(a); expect(f.posts.length).toBe(1)
    f.consume(nativeInputId('ses_test', 'A'), 'ma'); f.finish('ma', 'recovered'); f.idle()
    await until(() => f.settled.length === 1)
  })
  test('cross-chat insertion refused; foreign durable input never leaks its assistant text', async () => {
    const f = fixture(); await f.coordinator.submit('chat1', 'A', 'one')
    await expect(f.coordinator.submit('chat2', 'B', 'foreign')).rejects.toThrow('another chat')
    f.consume('msg_external', 'foreign'); f.finish('foreign', 'SECRET'); f.idle()
    await until(() => f.settled.length === 1)
    expect(f.settled[0].texts).toEqual([]); expect(f.settled[0].outcome.reason).toBe('external_input_detected')
  })
  test('HTTP conflict is not retried, stop uses separate interrupt and stable IDs scope sessions', async () => {
    const f = fixture({ denied: true })
    await expect(f.coordinator.submit('chat1', 'A', 'one')).rejects.toThrow('409')
    expect(f.posts.length).toBe(1)
    expect(nativeInputId('s1', 'm')).not.toBe(nativeInputId('s2', 'm'))
    expect(coordinatorKey('http://host/', '/tmp', 's')).not.toBe(coordinatorKey('http://host/', '/tmp', 'other'))
  })
  test('permission is owned by assistant source; rejected reply does not delete pending input', async () => {
    const f = fixture(); await f.coordinator.submit('chat', 'A', 'one')
    f.consume(nativeInputId('ses_test', 'A'), 'ma')
    f.permissions.push({id:'per_foreign', action:'bash', source:{messageID:'foreign'}}, {id:'per_owned', action:'bash', source:{messageID:'ma'}})
    await until(() => f.emitted.some(e => e.type === 'permission.requested'))
    expect(f.emitted.filter(e => e.type === 'permission.requested').map(e => e.requestId)).toEqual(['per_owned'])
    await f.coordinator.respondPermission('per_owned', false)
    expect(f.posts.at(-1)).toEqual({reply:'reject'})
    await f.coordinator.stop('chat')
    await expect(f.coordinator.submit('chat','B','new')).rejects.toThrow('待处理输入未删除')
    expect(f.settled[0].outcome.reason).toBe('interrupted')
  })
  test('configured idle timeout closes display without claiming remote cancellation, keeps confirmed partial text', async () => {
    const f = fixture({idleTimeoutMs:50}); await f.coordinator.submit('chat','A','one')
    f.consume(nativeInputId('ses_test','A'),'ma')
    f.event('text.ended',{assistantMessageID:'ma', textID:'part',text:'partial'})
    await until(() => f.settled.length === 1)
    expect(f.settled[0].outcome.reason).toBe('task_timeout')
    expect(f.settled[0].outcome.detail).toContain('0.05秒')
    expect(f.settled[0].texts[0].text).toBe('partial')
  })

  test('real SSE framing + polling share ownership, transient projection error never becomes foreign', async () => {
    const f = fixture({sse:true,projectionFailsOnce:true})
    await f.coordinator.submit('chat','A','one'); await until(() => f.streams() === 1)
    f.consume(nativeInputId('ses_test','A'),'ma')
    f.event('tool.called',{assistantMessageID:'ma',callID:'c',tool:'bash'})
    f.event('tool.success',{assistantMessageID:'ma',callID:'c'})
    f.finish('ma','after SSE'); f.idle()
    await until(() => f.settled.length === 1)
    expect(f.streams()).toBe(1)
    expect(f.emitted.filter(e => e.type === 'tool.started').length).toBe(1)
    expect(f.settled[0].texts[0].text).toBe('after SSE')
  })

  test('restart baseline refuses unknown pending queue input before any new prompt can wake it', async () => {
    const f = fixture()
    f.event('prompt.admitted',{messageID:'msg_previous_pending',delivery:'queue'})
    await expect(f.coordinator.submit('chat','A','one')).rejects.toThrow('未消费输入')
    expect(f.posts).toEqual([]); expect(f.started).toEqual([])
  })

})
