import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { FakeBackend } from './backends/fake'
import { taskServiceConfigSchema } from './config'
import { startTaskService, type RunningTaskService } from './index'
import { IpcClient } from './ipc/client'
import { authorization, prepareArgs, tempRoot } from './test-helpers'

const running: RunningTaskService[] = []
afterEach(() => { for (const r of running.splice(0)) r.stop() })

function setup() {
  const dir = tempRoot('rtask-index-')
  const stateDir = join(dir, 'state')
  const workRoot = join(dir, 'work')
  const workdir = join(workRoot, 'job')
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(workdir, { recursive: true })
  return { dir, stateDir, workRoot, workdir }
}

function input(workRoot: string, enabled: boolean) {
  return taskServiceConfigSchema.parse({
    enabled,
    dynamicWorkdirs: { roots: [workRoot], allowedAgents: ['fake'] },
    backends: { fake: { enabled: true, models: ['fake-a'] } },
    http: { enabled: false },
  })
}

const freePort = () => 20000 + Math.floor(Math.random() * 20000)

describe('startTaskService', () => {
  test('creates a private dir and a 0600 socket, and serves tools over IPC', async () => {
    const s = setup()
    const fake = new FakeBackend()
    const r = await startTaskService({ input: input(s.workRoot, true), projects: {}, allowedRoots: [s.workRoot], stateDir: s.stateDir, log: () => {}, buildBackends: () => [fake] })
    expect(r).not.toBeNull()
    running.push(r!)
    expect(statSync(r!.paths.dir).mode & 0o777).toBe(0o700)
    expect(statSync(r!.paths.socketPath).mode & 0o777).toBe(0o600)
    const client = new IpcClient(r!.paths.socketPath)
    const res = await client.request('tool', { name: 'router_health', arguments: {} }, 5000) as any
    expect(res.envelope.ok).toBe(true)
    expect(r!.hasLiveWork()).toBe(false) // an idle connected client does not pin the router
    client.close()
    // Malformed frames (null, arrays, missing id) are dropped; the service keeps serving.
    const { connect } = await import('net')
    await new Promise<void>(resolve => {
      const s2 = connect(r!.paths.socketPath, () => { s2.write('null\n[1]\n{"method":"tool"}\n"x"\n'); setTimeout(() => { s2.destroy(); resolve() }, 200) })
    })
    const again = new IpcClient(r!.paths.socketPath)
    expect(((await again.request('tool', { name: 'router_health', arguments: {} }, 5000)) as any).envelope.ok).toBe(true)
    again.close()
  })

  test('onWorkdirReleased fires once, when the last task on a workdir closes', async () => {
    const s = setup()
    const fake = new FakeBackend().script('fake-a', { events: [{ type: 'delivery', status: 'accepted' }], hang: true })
    const released: string[] = []
    const r = (await startTaskService({
      input: input(s.workRoot, true), projects: {}, allowedRoots: [s.workRoot], stateDir: s.stateDir, log: () => {},
      buildBackends: () => [fake], onWorkdirReleased: w => { released.push(w) },
    }))!
    running.push(r)
    const h = { workdir: s.workdir } as any
    const start = async (n: string) => {
      const args = prepareArgs(h, { clientTaskId: `j${n}`, scopeKey: `s${n}`, idempotencyKey: `p${n}` })
      const t = ((await r.service.call('router_task_prepare', args)).data as any).task
      await r.service.call('router_task_start', { taskId: t.taskId, idempotencyKey: `st${n}`, expectedControlVersion: t.controlVersion, authorization: authorization(args) })
      return t.taskId as string
    }
    const cancel = async (taskId: string) => {
      const get = async () => ((await r.service.call('router_task_get', { taskId })).data as any).task
      const g = await get()
      const res = await r.service.call('router_task_cancel', {
        taskId, idempotencyKey: `c-${taskId}`, expectedControlVersion: g.controlVersion,
        expectedOwner: g.owner.executionId ? { executionId: g.owner.executionId, generation: g.owner.generation } : null, reason: 'test', graceSeconds: 1,
      })
      expect(res.ok).toBe(true)
      const deadline = Date.now() + 3000
      while ((await get()).phase !== 'CLOSED' && Date.now() < deadline) await new Promise(res => setTimeout(res, 20))
      expect((await get()).phase).toBe('CLOSED')
    }
    const a = await start('1')
    const b = await start('2')
    await cancel(a)
    expect(released).toEqual([])
    await cancel(b)
    await new Promise(res => setTimeout(res, 50))
    expect(released).toEqual([require('fs').realpathSync(s.workdir)])
  })

  test('serves the MCP over Streamable HTTP with the service, and stops it with the service', async () => {
    const s = setup()
    const port = freePort()
    const r = (await startTaskService({ input: { ...input(s.workRoot, true), http: { enabled: true, host: '127.0.0.1', port } }, projects: {}, allowedRoots: [s.workRoot], stateDir: s.stateDir, log: () => {}, buildBackends: () => [new FakeBackend()] }))!
    expect(r.http?.url).toBe(`http://127.0.0.1:${port}/mcp`)
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }
    const res = await fetch(r.http!.url, { method: 'POST', body: JSON.stringify(init), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).result.serverInfo.name).toBe('router-task')
    r.stop()
    await expect(fetch(r.http!.url, { method: 'POST', body: '{}' })).rejects.toThrow()
  })

  test('a taken HTTP port does not stop the task service (fails soft, logged)', async () => {
    const s = setup()
    const port = freePort()
    const blocker = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('x') })
    const logs: string[] = []
    try {
      const r = (await startTaskService({ input: { ...input(s.workRoot, true), http: { enabled: true, host: '127.0.0.1', port } }, projects: {}, allowedRoots: [s.workRoot], stateDir: s.stateDir, log: m => { logs.push(m) }, buildBackends: () => [new FakeBackend()] }))!
      running.push(r)
      expect(r.http).toBeNull()
      expect(logs.some(l => l.includes('MCP HTTP endpoint NOT started'))).toBe(true)
      expect(statSync(r.paths.socketPath).mode & 0o777).toBe(0o600)
    } finally {
      blocker.stop(true)
    }
  })

  test('disabled with no database does not start', async () => {
    const s = setup()
    const r = await startTaskService({ input: input(s.workRoot, false), projects: {}, allowedRoots: [s.workRoot], stateDir: s.stateDir, log: () => {}, buildBackends: () => [] })
    expect(r).toBeNull()
  })

  test('disabled with live tasks runs in drain mode: no new tasks, controls still work', async () => {
    const s = setup()
    const fake = new FakeBackend().script('fake-a', { events: [{ type: 'delivery', status: 'accepted' }], hang: true })
    const r1 = (await startTaskService({ input: input(s.workRoot, true), projects: {}, allowedRoots: [s.workRoot], stateDir: s.stateDir, log: () => {}, buildBackends: () => [fake] }))!
    const harnessLike = { workdir: s.workdir } as any
    const args = prepareArgs(harnessLike)
    const prep = await r1.service.call('router_task_prepare', args)
    const task = (prep.data as any).task
    await r1.service.call('router_task_start', { taskId: task.taskId, idempotencyKey: 's', expectedControlVersion: task.controlVersion, authorization: authorization(args) })
    r1.stop()

    const fake2 = new FakeBackend().script('fake-a', { locate: 'running', hang: true })
    const r2 = (await startTaskService({ input: input(s.workRoot, false), projects: {}, allowedRoots: [s.workRoot], stateDir: s.stateDir, log: () => {}, buildBackends: () => [fake2] }))!
    running.push(r2)
    expect(r2.drain).toBe(true)
    const blocked = await r2.service.call('router_task_prepare', { ...prepareArgs(harnessLike, { clientTaskId: 'j2', scopeKey: 's2', idempotencyKey: 'p2' }) })
    expect(blocked.error?.code).toBe('SERVICE_UNAVAILABLE')
    const got = await r2.service.call('router_task_get', { taskId: task.taskId })
    expect(got.ok).toBe(true)
  })
})
