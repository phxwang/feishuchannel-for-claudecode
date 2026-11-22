/**
 * Test double for the interactive `agy` CLI used by the router task backend
 * tests (task-service/backends/agy.test.ts). Same observable surface as
 * fake-agy.ts (idle footer, USER_INPUT / PLANNER_RESPONSE transcript steps,
 * last.json / Stop.json hook files in $FEISHU_AGY_SIGNAL_DIR, numbered menus
 * answered by a bare digit), plus a few task-specific scenarios.
 *
 * Prompt commands:
 *   ASK               permission menu with a clear allow/deny pair; replies "CHOSE <digit>"
 *   MENU              numbered menu with no allow/deny pair; replies "PICKED <digit>"
 *   TOOL <text>       one tool call step, then "ECHO: <text>"
 *   BG <text>         stop with fullyIdle:false, then wake and reply "BG DONE"
 *   ERR <text>        reply, then stop with error "<text>"
 *   HANG              no reply until Escape; then stop with terminationReason CANCELLED
 *   SLOW <ms> <text>  reply after a delay
 *   anything else     reply "ECHO: <text>"
 * Escape while a menu is open dismisses it (reply "DISMISSED").
 * --brain <dir> sets the transcript root; --no-ready never shows the idle footer.
 */
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'

const argv = process.argv.slice(2)
const argValue = (flag: string) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1] }
const brainDir = argValue('--brain')!
const conversationId = argValue('--conversation') ?? randomUUID()
const showReady = !argv.includes('--no-ready')
const signalDir = process.env.FEISHU_AGY_SIGNAL_DIR
const transcript = join(brainDir, conversationId, '.system_generated', 'logs', 'transcript_full.jsonl')
mkdirSync(dirname(transcript), { recursive: true })
// Lets tests assert which flags the backend spawned agy with.
writeFileSync(join(dirname(transcript), 'argv.json'), JSON.stringify(argv))

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function writeAtomic(path: string, data: unknown) {
  writeFileSync(`${path}.tmp`, JSON.stringify(data))
  renameSync(`${path}.tmp`, path)
}
function hook(event: string, extra: Record<string, unknown> = {}) {
  if (!signalDir) return
  const payload = { conversationId, hookEventName: event, transcriptPath: transcript, ...extra }
  writeAtomic(join(signalDir, `${event}.json`), payload)
  writeAtomic(join(signalDir, 'last.json'), payload)
}
let step = 0
function appendStep(type: string, fields: Record<string, unknown>) {
  appendFileSync(transcript, JSON.stringify({ step_index: step++, type, status: 'DONE', ...fields }) + '\n')
}
const idle = () => { if (showReady) console.log('\n────────\n>\n────────\n? for shortcuts                 fake · model') }

let pendingChoice: ((key: string) => void) | null = null
let pendingCancel: (() => void) | null = null
const waitChoice = () => new Promise<string>(r => { pendingChoice = r })

async function runTurn(text: string) {
  console.log(`> ${text}\nesc to cancel`)
  hook('SessionStart', { lastUserInput: text })
  appendStep('USER_INPUT', { source: 'USER_EXPLICIT', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nfake\n</ADDITIONAL_METADATA>` })
  const stop = (fullyIdle: boolean, extra: Record<string, unknown> = {}) =>
    hook('Stop', { lastUserInput: text, fullyIdle, terminationReason: 'NO_TOOL_CALL', error: '', ...extra })
  const reply = (content: string) => { appendStep('PLANNER_RESPONSE', { content }); console.log(content) }

  const slow = text.match(/^SLOW (\d+) (.*)$/)
  if (slow) { await sleep(Number(slow[1])); reply(`ECHO: ${slow[2]}`); stop(true); return }
  const bg = text.match(/^BG (.*)$/)
  if (bg) {
    appendStep('PLANNER_RESPONSE', { tool_calls: [{ name: 'run_command', args: { CommandLine: 'sleep 1' } }] })
    reply(`ECHO: ${bg[1]}`)
    stop(false)
    await sleep(1200)
    reply('BG DONE')
    stop(true)
    return
  }
  const tool = text.match(/^TOOL (.*)$/)
  if (tool) {
    appendStep('PLANNER_RESPONSE', { tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls -la' } }] })
    appendStep('RUN_COMMAND', { content: 'ok' })
    reply(`ECHO: ${tool[1]}`)
    stop(true)
    return
  }
  const err = text.match(/^ERR (.*)$/)
  if (err) { reply('partial'); stop(true, { error: err[1], terminationReason: 'ERROR' }); return }
  if (text === 'HANG') {
    await new Promise<void>(r => { pendingCancel = r })
    stop(true, { terminationReason: 'CANCELLED' })
    return
  }
  if (text === 'ASK' || text === 'MENU') {
    const menu = text === 'ASK'
      ? 'Run this command?\n> 1. Yes, run command\n  2. No, cancel'
      : 'Which layout do you want?\n> 1. Option A\n  2. Option B'
    console.log(`\n${menu}\n\n  ↑/↓ Navigate · tab Amend\n\nesc to cancel            fake · model`)
    const key = await waitChoice()
    reply(key === 'esc' ? 'DISMISSED' : `${text === 'ASK' ? 'CHOSE' : 'PICKED'} ${key}`)
    stop(true)
    return
  }
  reply(`ECHO: ${text}`)
  stop(true)
}

const queue: string[] = []
let busy = false
async function drain() {
  if (busy) return
  busy = true
  while (queue.length) await runTurn(queue.shift()!)
  busy = false
  idle()
}

let buffer = ''
process.stdin.setRawMode?.(true)
process.stdin.on('data', (chunk: Buffer) => {
  const s = chunk.toString('utf8').replace(/\x1b\[20[01]~/g, '')
  for (const ch of s) {
    if (pendingChoice && /[0-9]/.test(ch)) { const r = pendingChoice; pendingChoice = null; r(ch); continue }
    if (ch === '\x1b') {
      if (pendingChoice) { const r = pendingChoice; pendingChoice = null; r('esc') }
      else if (pendingCancel) { const r = pendingCancel; pendingCancel = null; r() }
      continue
    }
    if (ch === '\r' || ch === '\n') {
      const line = buffer.trim()
      buffer = ''
      if (line) { queue.push(line); void drain() }
      continue
    }
    if (ch === '\x03') process.exit(0)
    buffer += ch
  }
})
idle()
