/**
 * Test double for the interactive Codex TUI (codex-cli 0.169.1), run inside a
 * real tmux pane by tmux/codex-manager.test.ts. It mimics only what the
 * router relies on, all observed on the real TUI (docs/codex-tmux-profile.md):
 *   - the idle footer "? for shortcuts", which stays on screen during a turn
 *     next to "• Working (… esc to interrupt)"
 *   - a rollout created on the first submitted message under
 *     <home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl (session_meta,
 *     task_started, user/assistant response_items, function_call,
 *     task_complete [with error] / turn_aborted)
 *   - `notify` ([program, args…] from `-c notify=[…]`) called with the
 *     agent-turn-complete JSON for completed turns only, plus a notify for a
 *     title-generator thread with no rollout, sent FIRST
 *   - steering: input typed mid-turn joins the running turn
 *   - `resume <id>` appends to the existing rollout
 *   - a numbered approval menu with a `›` cursor, answered by a bare digit
 *   - `/model`: a local picker, no rollout record, closed by Esc
 *
 * Prompt commands:
 *   SLOW <ms> <text>  reply "ECHO: <last input>" after a delay (steer target)
 *   TOOL <text>       exec_command function_call, then "ECHO: <text>"
 *   MENU              approval menu, then "CHOSE <digit>" (Esc: turn_aborted)
 *   ERR <text>        turn fails: task_complete with error, no main notify
 *   HANG              no reply until Escape, then turn_aborted
 *   anything else     reply "ECHO: <text>"
 * Flags (before the real Codex args): --home <dir> sets the CODEX_HOME;
 * --no-notify never runs the notify program.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1] }
const home = flag('--home') ?? process.env.CODEX_HOME!
const sendNotify = !argv.includes('--no-notify')
const resumeIdx = argv.indexOf('resume')
const resumeId = resumeIdx === -1 ? undefined : argv[resumeIdx + 1]
const configs = argv.flatMap((a, i) => a === '-c' ? [argv[i + 1]] : [])
const notifyCfg = configs.find(c => c.startsWith('notify='))
const notifyArgv: string[] | undefined = notifyCfg ? JSON.parse(notifyCfg.slice('notify='.length)) : undefined
const threadId = resumeId ?? randomUUID()
const sessionsDir = join(home, 'sessions')
mkdirSync(home, { recursive: true })
// Lets tests assert which flags the profile spawned Codex with.
writeFileSync(join(home, `argv-${threadId}.json`), JSON.stringify(argv))

const pad = (n: number) => String(n).padStart(2, '0')
function findRollout(id: string): string | undefined {
  if (!existsSync(sessionsDir)) return undefined
  for (const y of readdirSync(sessionsDir)) for (const m of readdirSync(join(sessionsDir, y))) for (const d of readdirSync(join(sessionsDir, y, m))) {
    const name = readdirSync(join(sessionsDir, y, m, d)).find(n => n.endsWith(`-${id}.jsonl`))
    if (name) return join(sessionsDir, y, m, d, name)
  }
  return undefined
}
let rollout = resumeId ? findRollout(resumeId) : undefined
const startedAt = new Date()
function ensureRollout(): string {
  if (rollout) return rollout
  const t = startedAt
  const dir = join(sessionsDir, String(t.getFullYear()), pad(t.getMonth() + 1), pad(t.getDate()))
  mkdirSync(dir, { recursive: true })
  const stamp = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}-${pad(t.getMinutes())}-${pad(t.getSeconds())}`
  rollout = join(dir, `rollout-${stamp}-${threadId}.jsonl`)
  record('session_meta', { id: threadId, session_id: threadId, cwd: process.cwd(), originator: 'codex-tui', cli_version: '0.169.1', source: 'cli' })
  return rollout
}
function record(type: string, payload: Record<string, unknown>) {
  appendFileSync(rollout!, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n')
}
const event = (payload: Record<string, unknown>) => record('event_msg', payload)
const userItem = (text: string) => record('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
const assistantItem = (text: string, phase = 'final_answer') =>
  record('response_item', { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text, annotations: [] }] })

function notify(thread: string, inputs: string[], last: string) {
  if (!sendNotify || !notifyArgv) return
  const payload = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': thread, 'turn-id': randomUUID(), cwd: process.cwd(), client: 'codex-tui', 'input-messages': inputs, 'last-assistant-message': last })
  Bun.spawnSync([...notifyArgv, payload], { env: process.env })
}

// ── screen ────────────────────────────────────────────────────────────────
const history: string[] = []
let overlay: string[] | null = null
let working = false
function render() {
  const body = overlay ?? [
    ...history.slice(-30),
    ...(working ? ['• Working (1s • esc to interrupt)'] : []),
    '',
    '› Ask Codex to do anything',
    '  fake-model default · ' + process.cwd(),
    '  ← for agents · ? for shortcuts',
  ]
  process.stdout.write('\x1b[2J\x1b[H' + body.join('\r\n'))
}
const show = (...lines: string[]) => { history.push(...lines); render() }

// ── turns ─────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const allInputs: string[] = []
let steered: string[] = []
let pendingKey: ((key: string) => void) | null = null
let busy = false
let picker = false

async function runTurn(text: string) {
  busy = true
  working = true
  ensureRollout()
  const turnId = randomUUID()
  event({ type: 'task_started', turn_id: turnId })
  userItem(text)
  allInputs.push(text)
  show(`› ${text}`)
  const finish = (reply: string, error?: string) => {
    if (reply) { assistantItem(reply); show(`• ${reply}`) }
    event({ type: 'task_complete', turn_id: turnId, last_agent_message: reply || null, ...(error ? { error: { message: error } } : {}) })
    // The title-generator thread's notify lands first (seen live); it has no rollout.
    notify(randomUUID(), ['Generate a concise, single-line task title…'], 'Title')
    if (!error) notify(threadId, [...allInputs], reply)
  }
  const abort = () => { event({ type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' }); show('■ Conversation interrupted - use /feedback if something went wrong') }
  const waitKey = () => new Promise<string>(r => { pendingKey = r })

  const slow = text.match(/^SLOW (\d+) (.*)$/)
  const tool = text.match(/^TOOL (.*)$/)
  const err = text.match(/^ERR (.*)$/)
  if (slow) {
    await sleep(Number(slow[1]))
    const last = steered.at(-1) ?? slow[2]
    assistantItem(`commentary for ${last}`, 'commentary')
    finish(`ECHO: ${last}`)
  } else if (tool) {
    record('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'ls -la' }), call_id: 'call_1' })
    record('response_item', { type: 'function_call_output', call_id: 'call_1', output: 'ok' })
    show('• Ran ls -la')
    finish(`ECHO: ${tool[1]}`)
  } else if (err) {
    show(`■ {"error":{"message":"${err[1]}"}}`)
    finish('', err[1])
  } else if (text === 'MENU') {
    record('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'touch x', sandbox_permissions: 'require_escalated' }), call_id: 'call_2' })
    working = false
    overlay = [...history.slice(-10), '• Running touch x', '', '  Would you like to run the following command?', '', '  Environment: local', '  Reason: needs write access', '',
      '  $ touch x', '', '› 1. Yes, proceed (y)', '  2. Yes, and don\'t ask again for commands that start with `touch x` (p)',
      '  3. No, and tell Codex what to do differently (esc)', '', '  Press enter to confirm or esc to cancel']
    render()
    const key = await waitKey()
    overlay = null
    working = true
    if (key === 'esc') abort()
    else finish(`CHOSE ${key}`)
  } else if (text === 'HANG') {
    render()
    while ((await waitKey()) !== 'esc') { /* only Esc ends it */ }
    abort()
  } else {
    finish(`ECHO: ${text}`)
  }
  steered = []
  busy = false
  working = false
  render()
}

// ── input ─────────────────────────────────────────────────────────────────
let buffer = ''
process.stdin.setRawMode?.(true)
process.stdin.on('data', (chunk: Buffer) => {
  const s = chunk.toString('utf8').replace(/\x1b\[20[01]~/g, '')
  for (const ch of s) {
    if (pendingKey && (/[0-9]/.test(ch) || ch === '\x1b')) {
      const r = pendingKey; pendingKey = null; r(ch === '\x1b' ? 'esc' : ch); continue
    }
    if (ch === '\x1b') { if (picker) { picker = false; overlay = null; render() } continue }
    if (ch === '\r' || ch === '\n') {
      const line = buffer.trim()
      buffer = ''
      if (!line) continue
      if (line === '/model') {
        picker = true
        overlay = ['  Select Model and Effort', '› 1. Model-A    Fast.', '  2. Model-B    Capable.', '↓', '  enter select · esc back']
        render()
        continue
      }
      if (busy) {
        // Steering: joins the running turn (recorded as another user message in it).
        steered.push(line)
        userItem(line)
        allInputs.push(line)
        show(`› ${line}`)
        continue
      }
      void runTurn(line)
      continue
    }
    if (ch === '\x03') process.exit(0)
    buffer += ch
  }
})
render()
