/**
 * Test double for the interactive `agy` CLI, run inside a real tmux pane by
 * tmux/agy-manager.test.ts. Mimics only what the router relies on (all
 * verified against agy 1.5.12): the idle footer, a transcript of
 * USER_INPUT / PLANNER_RESPONSE steps, the router plugin's hook files
 * (last.json / Stop.json in $FEISHU_AGY_SIGNAL_DIR), native queuing of
 * messages typed mid-turn, `--conversation` resume, and a numbered
 * permission menu answered by a bare digit.
 *
 * Prompt commands:
 *   SLOW <ms> <text>  reply after a delay (to queue a second message behind)
 *   BG <text>         stop with fullyIdle:false, then wake and reply again
 *   ASK               show a permission menu, reply with the chosen digit
 *   anything else     reply "ECHO: <text>"
 */
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'

const argv = process.argv.slice(2)
const argValue = (flag: string) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1] }
const brainDir = argValue('--brain')!
const conversationId = argValue('--conversation') ?? randomUUID()
// --no-hooks simulates the router's agy plugin not being installed.
const signalDir = argv.includes('--no-hooks') ? undefined : process.env.FEISHU_AGY_SIGNAL_DIR
const transcript = join(brainDir, conversationId, '.system_generated', 'logs', 'transcript_full.jsonl')
mkdirSync(dirname(transcript), { recursive: true })

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
const idle = () => console.log('\n────────\n>\n────────\n? for shortcuts                 fake · model')

let pendingChoice: ((digit: string) => void) | null = null
async function runTurn(text: string) {
  console.log(`> ${text}\nesc to cancel`)
  hook('SessionStart', { lastUserInput: text })
  appendStep('USER_INPUT', { content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>` })
  const stop = (fullyIdle: boolean) => hook('Stop', { lastUserInput: text, fullyIdle, terminationReason: 'NO_TOOL_CALL', error: '' })
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
  if (text === 'ASK') {
    console.log('\nRun this command?\n> 1. Yes, run command\n  2. No, cancel\n\n  ↑/↓ Navigate · tab Amend\n\nesc to cancel            fake · model')
    const digit = await new Promise<string>(r => { pendingChoice = r })
    reply(`CHOSE ${digit}`)
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
let picking = false
process.stdin.setRawMode?.(true)
process.stdin.on('data', (chunk: Buffer) => {
  const s = chunk.toString('utf8').replace(/\x1b\[20[01]~/g, '')
  for (const ch of s) {
    if (pendingChoice && /[0-9]/.test(ch)) { const r = pendingChoice; pendingChoice = null; r(ch); continue }
    if (ch === '\x1b' && picking) { picking = false; idle(); continue }
    if (ch === '\r' || ch === '\n') {
      const line = buffer.trim()
      buffer = ''
      // Like agy's /model: a local panel, no turn, no transcript step, no Stop hook.
      if (line === '/model') { picking = true; console.log('Switch Model\n> Model A   (current)\n  Model B\nKeyboard: ↑/↓ Navigate  enter Select  esc Go Back\n        fake · model'); continue }
      if (line) { queue.push(line); void drain() }
      continue
    }
    if (ch === '\x03') process.exit(0)
    buffer += ch
  }
})
idle()
