import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import Ajv from 'ajv'
import { spawn } from 'child_process'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { IpcServer } from '../task-service/ipc/server'
import { authorization, ended, makeHarness, prepareArgs, waitPhase, type Harness } from '../task-service/test-helpers'

setDefaultTimeout(30_000)

const LAUNCHER = join(import.meta.dir, '..', 'bin', 'router-task-mcp')
let h: Harness
let ipc: IpcServer
let socketPath: string

beforeAll(async () => {
  h = makeHarness()
  await h.ready
  const dir = join(h.stateDir, 'task-service')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  socketPath = join(dir, 'task.sock')
  ipc = new IpcServer({ socketPath, service: h.service, log: () => {} })
  await ipc.listen()
})
afterAll(() => { ipc?.close(); h?.service.stop() })

async function connectClient() {
  const transport = new StdioClientTransport({ command: LAUNCHER, args: ['--service-socket', socketPath], stderr: 'pipe' })
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(transport)
  return { client, transport }
}

describe('router-task MCP facade', () => {
  test('initialize, tools/list with schemas, and matching text/structuredContent', async () => {
    const { client } = await connectClient()
    try {
      expect(client.getServerVersion()?.name).toBe('router-task')
      expect(client.getServerCapabilities()?.tools).toBeDefined()
      expect(client.getServerCapabilities()?.resources).toBeDefined()
      const { tools } = await client.listTools()
      expect(tools.map(t => t.name).sort()).toEqual([
        'router_capabilities', 'router_events_read', 'router_health', 'router_permission_reply', 'router_task_add_turn',
        'router_task_authorize', 'router_task_cancel', 'router_task_close', 'router_task_get', 'router_task_lookup',
        'router_task_prepare', 'router_task_result', 'router_task_seal', 'router_task_start', 'router_turn_text_read',
      ])
      const ajv = new Ajv({ strict: false })
      for (const t of tools) {
        expect(t.inputSchema.type).toBe('object')
        expect(t.outputSchema).toBeDefined()
        expect(() => ajv.compile(t.outputSchema!)).not.toThrow()
      }
      const health = await client.callTool({ name: 'router_health', arguments: {} })
      expect(health.isError).toBe(false)
      const text = (health.content as { type: string; text: string }[])[0].text
      expect(JSON.parse(text)).toEqual(health.structuredContent as object)
      const validate = ajv.compile(tools.find(t => t.name === 'router_health')!.outputSchema!)
      expect(validate(health.structuredContent)).toBe(true)
    } finally { await client.close() }
  })

  test('full task lifecycle over MCP, domain errors as isError results, unknown tool as protocol error', async () => {
    h.fake.script('fake-a', { events: [{ type: 'delivery', status: 'accepted' }, ended('over mcp')] })
    const { client } = await connectClient()
    try {
      const args = prepareArgs(h, { clientTaskId: 'mcp-1', scopeKey: 'mcp-scope', idempotencyKey: 'mcp-prep' })
      const prep = await client.callTool({ name: 'router_task_prepare', arguments: args })
      expect(prep.isError).toBe(false)
      const task = (prep.structuredContent as any).data.task
      const start = await client.callTool({ name: 'router_task_start', arguments: { taskId: task.taskId, idempotencyKey: 'mcp-start', expectedControlVersion: task.controlVersion, authorization: authorization(args) } })
      expect(start.isError).toBe(false)
      const q = await waitPhase(h, task.taskId, 'QUIESCENT')
      const page = await client.callTool({ name: 'router_events_read', arguments: { taskId: task.taskId, afterSeq: 0 } })
      expect((page.structuredContent as any).data.events.length).toBeGreaterThan(3)
      const conflict = await client.callTool({ name: 'router_task_close', arguments: { taskId: task.taskId, idempotencyKey: 'x', expectedControlVersion: 0, expectedOwner: null, reason: 'r' } })
      expect(conflict.isError).toBe(true)
      expect((conflict.structuredContent as any).error.code).toBe('VERSION_CONFLICT')
      const bad = await client.callTool({ name: 'router_task_get', arguments: { taskId: task.taskId, nope: 1 } })
      expect((bad.structuredContent as any).error.code).toBe('INVALID_REQUEST')
      const close = await client.callTool({ name: 'router_task_close', arguments: { taskId: task.taskId, idempotencyKey: 'mcp-close', expectedControlVersion: q.controlVersion, expectedOwner: { executionId: q.owner.executionId, generation: q.owner.generation }, reason: 'done' } })
      expect(close.isError).toBe(false)
      await waitPhase(h, task.taskId, 'CLOSED')
      await expect(client.callTool({ name: 'router_does_not_exist', arguments: {} })).rejects.toThrow()
    } finally { await client.close() }
  })

  test('resource templates and reads', async () => {
    const { client } = await connectClient()
    try {
      const { resourceTemplates } = await client.listResourceTemplates()
      expect(resourceTemplates.map(r => r.uriTemplate)).toEqual(['router://tasks/{taskId}/snapshot', 'router://tasks/{taskId}/result'])
      expect((await client.listResources()).resources).toEqual([])
      const t = h.store.getTaskByClient('test-client', 'mcp-1')!
      const res = await client.readResource({ uri: `router://tasks/${t.taskId}/snapshot` })
      expect(JSON.parse((res.contents[0] as { text: string }).text).taskId).toBe(t.taskId)
      await expect(client.readResource({ uri: 'router://tasks/task_missing/snapshot' })).rejects.toThrow()
    } finally { await client.close() }
  })

  test('facade exit does not stop a running task', async () => {
    h.fake.script('fake-a', { events: [{ type: 'delivery', status: 'accepted' }, { delayMs: 400 }, ended('survived')] })
    const { client } = await connectClient()
    const args = prepareArgs(h, { clientTaskId: 'mcp-2', scopeKey: 'mcp-scope-2', idempotencyKey: 'mcp-prep-2' })
    const prep = await client.callTool({ name: 'router_task_prepare', arguments: args })
    const task = (prep.structuredContent as any).data.task
    await client.callTool({ name: 'router_task_start', arguments: { taskId: task.taskId, idempotencyKey: 'mcp-start-2', expectedControlVersion: task.controlVersion, authorization: authorization(args) } })
    await client.close()
    const q = await waitPhase(h, task.taskId, 'QUIESCENT')
    expect(q.phase).toBe('QUIESCENT')
    const again = await connectClient()
    try {
      const r = await again.client.callTool({ name: 'router_task_result', arguments: { taskId: task.taskId } })
      expect((r.structuredContent as any).data.turns[0].finalText).toBe('survived')
    } finally { await again.client.close() }
  })

  test('stdout carries only JSON-RPC messages', async () => {
    const child = spawn(LAUNCHER, ['--service-socket', socketPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => { out += d.toString() })
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n')
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } })
    await new Promise(r => setTimeout(r, 500))
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'router_health', arguments: {} } })
    await new Promise(r => setTimeout(r, 800))
    child.kill()
    const lines = out.split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(2)
    for (const l of lines) expect(JSON.parse(l).jsonrpc).toBe('2.0')
    expect(JSON.parse(lines[0]).result.protocolVersion).toBe('2025-11-25')
  })

  test('service unavailable is a retryable domain error, not a success', async () => {
    const dead = join(h.stateDir, 'task-service', 'dead.sock')
    const transport = new StdioClientTransport({ command: LAUNCHER, args: ['--service-socket', dead], stderr: 'pipe' })
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    await client.connect(transport)
    try {
      const r = await client.callTool({ name: 'router_task_seal', arguments: { taskId: 'task_x', idempotencyKey: 'k', expectedControlVersion: 0, expectedOwner: null, reason: 'r' } })
      expect(r.isError).toBe(true)
      expect((r.structuredContent as any).error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true, sideEffects: 'unknown' })
    } finally { await client.close() }
  }, 20_000)
})
