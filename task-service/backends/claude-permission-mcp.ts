/**
 * Claude permission relay (design doc §11.4). A tiny stdio MCP server that
 * Claude starts through the attempt's mcp.json and calls as
 * `--permission-prompt-tool mcp__router_task__permission`. Each call is
 * forwarded to the task service over task.sock (`permission.ask`) and blocks
 * until it answers. The relay never decides anything itself: any error,
 * timeout, cancellation or lost socket is a deny.
 *
 * stdout carries MCP protocol only; diagnostics go to stderr.
 *
 * Env: ROUTER_TASK_SOCKET, ROUTER_TASK_ATTEMPT_ID, ROUTER_TASK_RELAY_TOKEN.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'crypto'
import { IpcClient } from '../ipc/client'
import type { PermissionAskParams } from '../ipc/protocol'

export const RELAY_TOOL_NAME = 'permission'
/** Longer than any permissionTimeoutSeconds; the service answers deny on its own expiry. */
export const ASK_TIMEOUT_MS = 2 * 60 * 60 * 1000

export interface RelayEnv { socketPath: string; attemptId: string; relayToken: string }

export type ClaudeDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

export const TOOL_DEFINITION = {
  name: RELAY_TOOL_NAME,
  description: 'Asks the task owner whether Claude may run a tool. Used only as --permission-prompt-tool.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      tool_name: { type: 'string', description: 'Name of the tool Claude wants to run.' },
      input: { type: 'object', description: 'The tool input.' },
      tool_use_id: { type: 'string', description: 'The tool_use id of the pending call.' },
    },
    required: ['tool_name', 'input'],
  },
}

export function readRelayEnv(env: Record<string, string | undefined>): RelayEnv | null {
  const socketPath = env.ROUTER_TASK_SOCKET
  const attemptId = env.ROUTER_TASK_ATTEMPT_ID
  const relayToken = env.ROUTER_TASK_RELAY_TOKEN
  return socketPath && attemptId && relayToken ? { socketPath, attemptId, relayToken } : null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Validate Claude's tool arguments into an IPC request; null when malformed. */
export function toAskParams(env: RelayEnv, args: unknown): PermissionAskParams | null {
  if (!isRecord(args) || typeof args.tool_name !== 'string' || !args.tool_name || !isRecord(args.input)) return null
  const toolUseId = typeof args.tool_use_id === 'string' && args.tool_use_id ? args.tool_use_id : `relay_${randomUUID()}`
  return { executionAttemptId: env.attemptId, relayToken: env.relayToken, toolUseId, toolName: args.tool_name, input: args.input }
}

/** Map the service's answer to Claude's contract. Anything but an explicit allow is a deny. */
export function toClaudeDecision(answer: unknown, originalInput: Record<string, unknown>): ClaudeDecision {
  if (isRecord(answer) && answer.behavior === 'allow') {
    return { behavior: 'allow', updatedInput: isRecord(answer.updatedInput) ? answer.updatedInput : originalInput }
  }
  const message = isRecord(answer) && typeof answer.message === 'string' && answer.message ? answer.message : 'Denied by the task service.'
  return { behavior: 'deny', message }
}

export async function decide(client: Pick<IpcClient, 'request'>, env: RelayEnv | null, args: unknown, timeoutMs = ASK_TIMEOUT_MS): Promise<ClaudeDecision> {
  if (!env) return { behavior: 'deny', message: 'Permission relay is not configured.' }
  const params = toAskParams(env, args)
  if (!params) return { behavior: 'deny', message: 'Permission relay received a malformed request.' }
  try {
    const answer = await client.request('permission.ask', params as unknown as Record<string, unknown>, timeoutMs)
    return toClaudeDecision(answer, params.input)
  } catch (e) {
    process.stderr.write(`router-task permission relay: ${e instanceof Error ? e.message : String(e)}\n`)
    return { behavior: 'deny', message: 'Permission relay could not reach the task service.' }
  }
}

export function createRelayServer(env: RelayEnv | null): Server {
  const server = new Server({ name: 'router_task', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [TOOL_DEFINITION] }))
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    if (req.params.name !== RELAY_TOOL_NAME) {
      return { isError: true, content: [{ type: 'text' as const, text: `unknown tool ${req.params.name}` }] }
    }
    // One connection per call: closing it on cancellation makes the service deny that exact request.
    const client = env ? new IpcClient(env.socketPath) : null
    const onAbort = () => client?.close()
    extra.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const decision = client ? await decide(client, env, req.params.arguments) : await decide({ request: async () => null }, null, null)
      return { content: [{ type: 'text' as const, text: JSON.stringify(decision) }] }
    } finally {
      extra.signal.removeEventListener('abort', onAbort)
      client?.close()
    }
  })
  return server
}

if (import.meta.main) {
  const env = readRelayEnv(process.env)
  if (!env) process.stderr.write('router-task permission relay: missing ROUTER_TASK_* environment; every request will be denied\n')
  const server = createRelayServer(env)
  server.connect(new StdioServerTransport()).catch(e => {
    process.stderr.write(`router-task permission relay: failed to start: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  })
}
