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
  })
}

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
    expect(r!.hasLiveWork()).toBe(true) // a connected client counts as live work
    client.close()
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
