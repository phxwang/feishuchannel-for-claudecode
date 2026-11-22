/**
 * router-task MCP over Streamable HTTP, served from inside the router process
 * (started and stopped with the task service). Same tools and envelopes as the
 * stdio facade, but requests reach the TaskService in-process instead of over
 * task.sock.
 *
 * Stateless transport: every POST gets a fresh facade + transport (all tools
 * are stateless; task state lives in the service). JSON responses, no SSE
 * stream. Security: loopback bind only, Host/Origin allowlist against DNS
 * rebinding, optional bearer token. Admin operations are never exposed.
 */
import { timingSafeEqual } from 'crypto'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { TaskService } from '../task-service/core/service'
import { dispatchFacadeRequest } from '../task-service/ipc/dispatch'
import { createFacade, type FacadeRequester } from './server'

export const MCP_PATH = '/mcp'
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1'])
/** Above router_events_read's longest wait (20 s) so a long poll is never cut. */
const IDLE_TIMEOUT_SECONDS = 60

export interface HttpMcpOptions {
  service: TaskService
  host: string
  /** 0 = pick a free port (tests). */
  port: number
  version: string
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  bearerToken?: string
  log: (msg: string) => void
}

export interface HttpMcpServer {
  url: string
  port: number
  stop(): void
}

function tokenMatches(header: string | null, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '')
  if (!m) return false
  const given = Buffer.from(m[1].trim())
  const want = Buffer.from(token)
  return given.length === want.length && timingSafeEqual(given, want)
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
    status, headers: { 'content-type': 'application/json' },
  })
}

function hostForms(host: string, port: number): string[] {
  const names = host === '::1' ? ['[::1]'] : ['127.0.0.1', 'localhost']
  return names.map(n => `${n}:${port}`)
}

export async function startHttpMcp(o: HttpMcpOptions): Promise<HttpMcpServer> {
  if (!LOOPBACK_HOSTS.has(o.host)) throw new Error(`router-task HTTP must bind a loopback address, got "${o.host}"`)
  const requester: FacadeRequester = {
    request: (method, params) => dispatchFacadeRequest(o.service, method, params),
    close: () => {},
  }
  let allowedHosts: string[] = []
  let allowedOrigins: string[] = []

  const handle = async (req: Request): Promise<Response> => {
    if (new URL(req.url).pathname !== MCP_PATH) return new Response('Not found', { status: 404 })
    if (o.bearerToken && !tokenMatches(req.headers.get('authorization'), o.bearerToken)) return jsonError(401, 'Unauthorized')
    const facade = createFacade({ requester, version: o.version, log: o.log })
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true,
      enableDnsRebindingProtection: true, allowedHosts, allowedOrigins,
    })
    try {
      await facade.connect(transport)
      return await transport.handleRequest(req)
    } catch (e) {
      o.log(`router-task http: request failed: ${e instanceof Error ? e.message : String(e)}`)
      return jsonError(500, 'Internal error')
    } finally {
      void facade.close().catch(() => undefined)
    }
  }

  const server = Bun.serve({ hostname: o.host, port: o.port, idleTimeout: IDLE_TIMEOUT_SECONDS, fetch: handle })
  const port = server.port ?? o.port
  allowedHosts = hostForms(o.host, port)
  allowedOrigins = allowedHosts.map(h => `http://${h}`)
  const url = `http://${allowedHosts[0]}${MCP_PATH}`
  o.log(`task-service: MCP (streamable HTTP) listening on ${url}${o.bearerToken ? ' (bearer token required)' : ''}`)
  return { url, port, stop: () => { server.stop(true) } }
}
