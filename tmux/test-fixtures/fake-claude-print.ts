/**
 * Stand-in for `claude -p --output-format stream-json --verbose
 * --include-partial-messages`, used by task-service/backends/claude.test.ts.
 * Reads the prompt from stdin and writes stream-json events shaped like
 * Claude Code 2.1.x. It logs its argv and FEISHU_* env keys to stderr.
 *
 * Behaviour, by prompt text:
 *   FAIL_STARTUP    a hook line, then exit 1 before system/init
 *   EXIT_NO_RESULT  init, then exit 3 with no result event
 *   ERROR           init, some text, an error result, exit 1
 *   TOOL            a tool_use / tool_result pair (TOOL_FAIL: tool_result is_error)
 *   SLOW            text deltas spaced 120 ms apart
 *   HANG            init, text, a SIGINT-ignoring `sleep` grandchild in the same
 *                   process group, then waits; on SIGINT kills it and exits 130
 *                   (HANG_STUBBORN ignores SIGINT, so only SIGKILL ends it)
 *   PERMISSION      starts the relay from --mcp-config like Claude does, calls its
 *                   `permission` tool, and reports the decision in the result
 *   anything else   replies "ECHO: <prompt>"
 */
import { spawn } from 'child_process'
import { readFileSync } from 'fs'

const argv = process.argv.slice(2)
if (argv.includes('--version')) { process.stdout.write('2.1.330 (Claude Code fake)\n'); process.exit(0) }
const flag = (name: string): string | null => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] ?? null : null }
const sessionId = flag('--session-id') ?? 'no-session'
const out = (obj: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ...obj, session_id: sessionId })}\n`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

process.stderr.write(`${JSON.stringify({ argv, feishuEnv: Object.keys(process.env).filter(k => k.startsWith('FEISHU_')), marker: process.env.ROUTER_TASK_ATTEMPT ?? null })}\n`)
const prompt = readFileSync(0, 'utf8')

function init(): void {
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), model: flag('--model'), permissionMode: flag('--permission-mode'), tools: ['Bash'], mcp_servers: [] })
}

async function streamText(messageId: string, parts: string[], gapMs = 0): Promise<void> {
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: messageId, role: 'assistant', content: [] } } })
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  for (const text of parts) {
    out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
    if (gapMs) await sleep(gapMs)
  }
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } })
  out({ type: 'assistant', parent_tool_use_id: null, message: { id: messageId, role: 'assistant', content: [{ type: 'text', text: parts.join('') }] } })
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_stop' } })
}

function toolPair(id: string, isError: boolean): void {
  out({ type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } })
  out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'boom' : 'a.txt', is_error: isError }] } })
}

function result(text: string, ok = true): void {
  out(ok
    ? { type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', num_turns: 1 }
    : { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['simulated failure'], num_turns: 1 })
}

async function askRelay(): Promise<string> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const config = JSON.parse(readFileSync(flag('--mcp-config')!, 'utf8')).mcpServers.router_task
  const transport = new StdioClientTransport({ command: config.command, args: config.args, env: { ...process.env, ...config.env } as Record<string, string>, stderr: 'inherit' })
  const client = new Client({ name: 'fake-claude', version: '0.0.0' })
  await client.connect(transport)
  try {
    const r: any = await client.callTool({ name: 'permission', arguments: { tool_name: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'toolu_perm1' } }, undefined, { timeout: 60_000 })
    return String(r.content?.[0]?.text ?? '')
  } finally { await client.close() }
}

async function main(): Promise<void> {
  if (prompt.includes('FAIL_STARTUP')) {
    out({ type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup' })
    process.stderr.write('Error: simulated startup failure\n')
    process.exit(1)
  }
  init()
  if (prompt.includes('EXIT_NO_RESULT')) process.exit(3)
  if (prompt.includes('ERROR')) { await streamText('msg_err', ['partial']); result('', false); process.exit(1) }
  if (prompt.includes('HANG')) {
    await streamText('msg_hang', ['working'])
    // A grandchild that ignores SIGINT, so only a group-wide SIGKILL is sure to remove it.
    const child = spawn('sh', ['-c', 'trap "" INT; exec sleep 600'], { stdio: 'ignore' })
    out({ type: 'system', subtype: 'fake_child', pid: child.pid })
    process.on('SIGINT', () => { if (!prompt.includes('HANG_STUBBORN')) { child.kill('SIGKILL'); process.exit(130) } })
    setInterval(() => undefined, 1000)
    return
  }
  if (prompt.includes('PERMISSION')) {
    out({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_p', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_perm1', name: 'Bash', input: { command: 'rm -rf build' } }] } })
    const decision = await askRelay()
    out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_perm1', content: decision, is_error: !decision.includes('"allow"') }] } })
    result(`DECISION ${decision}`)
    return
  }
  if (prompt.includes('TOOL')) {
    toolPair('toolu_1', prompt.includes('TOOL_FAIL'))
    await streamText('msg_after_tool', ['tool ', 'done'])
    result('tool done')
    return
  }
  if (prompt.includes('SLOW')) {
    const parts = Array.from({ length: 10 }, (_, i) => `p${i} `)
    await streamText('msg_slow', parts, 120)
    result(parts.join(''))
    return
  }
  const text = `ECHO: ${prompt.trim()}`
  await streamText('msg_echo', [text.slice(0, 6), text.slice(6)])
  result(text)
}

main().catch(e => { process.stderr.write(`fake-claude-print: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(2) })
