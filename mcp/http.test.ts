import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { authorization, makeHarness, prepareArgs, type Harness } from '../task-service/test-helpers'
import { startHttpMcp, type HttpMcpServer } from './http'

setDefaultTimeout(30_000)

let h: Harness
let open: HttpMcpServer
let secured: HttpMcpServer
const TOKEN = 't0ken-for-tests'

beforeAll(async () => {
  h = makeHarness()
  await h.ready
  open = await startHttpMcp({ service: h.service, host: '127.0.0.1', port: 0, version: 'test', log: () => {} })
  secured = await startHttpMcp({ service: h.service, host: '127.0.0.1', port: 0, version: 'test', bearerToken: TOKEN, log: () => {} })
})
afterAll(() => { open?.stop(); secured?.stop(); h?.service.stop() })

async function connect(url: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: 'http-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
  return client
}

describe('router-task MCP over Streamable HTTP (in the router process)', () => {
  test('initialize, list tools, and run a task through prepare/start', async () => {
    const client = await connect(open.url)
    try {
      expect(client.getServerVersion()?.name).toBe('router-task')
      const tools = (await client.listTools()).tools.map(t => t.name)
      expect(tools).toContain('router_task_prepare')
      const health: any = await client.callTool({ name: 'router_health', arguments: {} })
      expect(health.structuredContent.ok).toBe(true)

      const args = prepareArgs(h, { clientTaskId: 'http-1', scopeKey: 'http-1', idempotencyKey: 'http-p1' })
      const prep: any = await client.callTool({ name: 'router_task_prepare', arguments: args })
      expect(prep.structuredContent.ok).toBe(true)
      const task = prep.structuredContent.data.task
      const start: any = await client.callTool({ name: 'router_task_start', arguments: { taskId: task.taskId, idempotencyKey: 'http-s1', expectedControlVersion: task.controlVersion, authorization: authorization(args) } })
      expect(start.structuredContent.ok).toBe(true)
    } finally {
      await client.close()
    }
  })

  test('admin operations are not reachable over MCP', async () => {
    const client = await connect(open.url)
    try {
      await expect(client.callTool({ name: 'admin.release', arguments: {} })).rejects.toThrow()
    } finally {
      await client.close()
    }
  })

  test('rejects a foreign Host header (DNS rebinding) and a browser Origin', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    const base = { method: 'POST', body, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }
    const badHost = await fetch(open.url, { ...base, headers: { ...base.headers, host: 'evil.example:80' } })
    expect(badHost.status).toBe(403)
    const badOrigin = await fetch(open.url, { ...base, headers: { ...base.headers, origin: 'https://evil.example' } })
    expect(badOrigin.status).toBe(403)
  })

  test('a configured bearer token is required', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    const r = await fetch(secured.url, { method: 'POST', body, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } })
    expect(r.status).toBe(401)
    const client = await connect(secured.url, { authorization: `Bearer ${TOKEN}` })
    expect(((await client.callTool({ name: 'router_health', arguments: {} })) as any).structuredContent.ok).toBe(true)
    await client.close()
  })

  test('only loopback hosts are accepted', async () => {
    await expect(startHttpMcp({ service: h.service, host: '0.0.0.0', port: 0, version: 'test', log: () => {} })).rejects.toThrow(/loopback/)
  })
})
