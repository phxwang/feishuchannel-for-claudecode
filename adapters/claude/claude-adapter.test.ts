import { describe, expect, test } from 'bun:test'
import { ClaudeAdapter, ClaudeNotSupportedError, type ClaudeWorkerLink, type ClaudeWorkerLocator } from './claude-adapter'
import type { AgentEvent } from '../agent-adapter'

class FakeLocator implements ClaudeWorkerLocator {
  sent: Record<string, unknown>[] = []
  private online: Set<string>
  constructor(onlineWorkdirs: string[]) { this.online = new Set(onlineWorkdirs) }
  find(workdir: string): ClaudeWorkerLink | undefined {
    if (!this.online.has(workdir)) return undefined
    return { workdir, send: (payload) => { this.sent.push(payload); return true } }
  }
}

async function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const e of iter) out.push(e)
  return out
}

describe('ClaudeAdapter.health', () => {
  test('healthy when a worker is registered for the workdir', async () => {
    const a = new ClaudeAdapter(new FakeLocator(['/x']), () => undefined)
    expect((await a.health({ workdir: '/x' })).healthy).toBe(true)
  })
  test('unhealthy when no worker registered', async () => {
    const a = new ClaudeAdapter(new FakeLocator([]), () => undefined)
    const h = await a.health({ workdir: '/x' })
    expect(h.healthy).toBe(false)
    expect(h.detail).toContain('/x')
  })
})

describe('ClaudeAdapter.createSession / resumeSession', () => {
  test('session id is scoped to the workdir', async () => {
    const a = new ClaudeAdapter(new FakeLocator(['/x']), () => undefined)
    const s = await a.createSession({ conversationKey: 'k', projectId: 'p', workdir: '/x' })
    expect(s).toEqual({ sessionId: 'claude:/x', agent: 'claude' })
    expect(await a.resumeSession(s.sessionId)).toEqual(s)
  })
})

describe('ClaudeAdapter.send', () => {
  test('delivers channel_message and yields started -> idle', async () => {
    const locator = new FakeLocator(['/x'])
    const a = new ClaudeAdapter(locator, () => undefined)
    const events = await collect(a.send({ taskId: 't1', sessionId: 'claude:/x', prompt: 'hi' }, new AbortController().signal))
    expect(events.map(e => e.type)).toEqual(['task.started', 'session.idle'])
    expect(locator.sent[0]).toMatchObject({ type: 'channel_message', content: 'hi' })
  })

  test('yields task.failed when no worker is connected', async () => {
    const a = new ClaudeAdapter(new FakeLocator([]), () => undefined)
    const events = await collect(a.send({ taskId: 't1', sessionId: 'claude:/x', prompt: 'hi' }, new AbortController().signal))
    expect(events).toEqual([{ type: 'task.failed', taskId: 't1', reason: 'backend_unavailable' }])
  })

  test('yields task.aborted when signal is already aborted after delivery', async () => {
    const a = new ClaudeAdapter(new FakeLocator(['/x']), () => undefined)
    const ac = new AbortController()
    ac.abort()
    const events = await collect(a.send({ taskId: 't1', sessionId: 'claude:/x', prompt: 'hi' }, ac.signal))
    expect(events.map(e => e.type)).toEqual(['task.started', 'task.aborted'])
  })
})

describe('ClaudeAdapter.respondPermission', () => {
  test('routes to the workdir resolved for the request id', async () => {
    const locator = new FakeLocator(['/x'])
    const a = new ClaudeAdapter(locator, (id) => (id === 'perm-1' ? '/x' : undefined))
    await a.respondPermission('perm-1', { requestId: 'perm-1', behavior: 'allow' })
    expect(locator.sent[0]).toEqual({ type: 'permission_response', request_id: 'perm-1', behavior: 'allow' })
  })

  test('throws when the request id is unknown', async () => {
    const a = new ClaudeAdapter(new FakeLocator(['/x']), () => undefined)
    await expect(a.respondPermission('ghost', { requestId: 'ghost', behavior: 'deny' })).rejects.toThrow(ClaudeNotSupportedError)
  })

  test('throws when the worker for the resolved workdir is offline', async () => {
    const a = new ClaudeAdapter(new FakeLocator([]), () => '/x')
    await expect(a.respondPermission('perm-1', { requestId: 'perm-1', behavior: 'allow' })).rejects.toThrow(ClaudeNotSupportedError)
  })
})

describe('ClaudeAdapter unsupported operations are explicit, not faked', () => {
  test('getFinalMessage throws', async () => {
    const a = new ClaudeAdapter(new FakeLocator(['/x']), () => undefined)
    await expect(a.getFinalMessage('claude:/x', 't1')).rejects.toThrow(ClaudeNotSupportedError)
  })
  test('getDiff throws', async () => {
    const a = new ClaudeAdapter(new FakeLocator(['/x']), () => undefined)
    await expect(a.getDiff()).rejects.toThrow(ClaudeNotSupportedError)
  })
})
