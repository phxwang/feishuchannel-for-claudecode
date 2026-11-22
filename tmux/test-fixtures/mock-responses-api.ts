/**
 * Local mock of the OpenAI Responses API (streaming SSE), used to drive the
 * REAL Codex TUI by hand without any billable model call. Not used by the
 * automated tests. See docs/codex-tmux-profile.md, "Re-verifying".
 *
 *   bun tmux/test-fixtures/mock-responses-api.ts <port> <request-log.jsonl>
 *
 * Prompts: RUNCMD (escalated exec_command, which triggers an approval prompt),
 * SLOW (6 s delay), FAIL (HTTP 400, which fails the turn), anything else
 * replies "commentary for <text>" + "ECHO: <text>".
 */
import { appendFileSync } from 'fs'

const port = Number(process.argv[2] ?? 18765)
const LOG = process.argv[3] ?? '/dev/null'
let n = 0

function sse(events: unknown[]): Response {
  const body = events.map(e => `event: ${(e as any).type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function lastUserText(body: any): string {
  const input = Array.isArray(body?.input) ? body.input : []
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i]
    if (it?.type === 'function_call_output' || it?.type === 'custom_tool_call_output') return '__TOOL_OUTPUT__'
    if (it?.role === 'user' && Array.isArray(it.content)) {
      const t = it.content.map((c: any) => c.text ?? '').join('')
      if (!t.startsWith('<environment_context') && !t.startsWith('<')) return t
    }
  }
  return ''
}

function completed(id: string, items: unknown[]) {
  return [
    { type: 'response.created', response: { id } },
    ...items.map((item, i) => ({ type: 'response.output_item.done', output_index: i, item })),
    { type: 'response.completed', response: { id, usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 } } },
  ]
}
const msg = (text: string, phase = 'final_answer') => ({ type: 'message', role: 'assistant', id: `msg_${++n}`, phase, content: [{ type: 'output_text', text, annotations: [] }] })

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)
    const text = req.method === 'POST' ? await req.text() : ''
    let body: any = null
    try { body = JSON.parse(text) } catch {}
    appendFileSync(LOG, JSON.stringify({ method: req.method, path: url.pathname, tools: body?.tools?.map((t: any) => t.name ?? t.type), lastUser: body ? lastUserText(body) : undefined }) + '\n')
    if (url.pathname.endsWith('/models')) return Response.json({ models: [], data: [] })
    if (!url.pathname.endsWith('/responses')) return new Response('not found', { status: 404 })
    const user = lastUserText(body)
    const id = `resp_${++n}`
    if (user === '__TOOL_OUTPUT__') return sse(completed(id, [msg('TOOL DONE')]))
    if (user.startsWith('RUNCMD')) {
      const names: string[] = (body?.tools ?? []).map((t: any) => t.name)
      const tool = names.includes('shell') ? 'shell' : names.includes('exec_command') ? 'exec_command' : names[0]
      const args = tool === 'shell'
        ? { command: ['bash', '-lc', 'echo approved'], sandbox_permissions: 'require_escalated', justification: 'probe approval prompt' }
        : { cmd: 'echo approved', sandbox_permissions: 'require_escalated', justification: 'probe approval prompt' }
      return sse(completed(id, [{ type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: tool, arguments: JSON.stringify(args) }]))
    }
    if (user.startsWith('SLOW')) await Bun.sleep(6000)
    if (user.startsWith('FAIL')) return new Response(JSON.stringify({ error: { message: 'mock failure', type: 'server_error' } }), { status: 400 })
    return sse(completed(id, [msg(`commentary for ${user}`, 'commentary'), msg(`ECHO: ${user}`)]))
  },
})
console.log(`mock on ${port}`)
