/**
 * Minimal test double for the interactive `claude` CLI, run inside a real
 * tmux pane by tmux/claude-manager.test.ts. Mimics only what the router's
 * Claude profile relies on: the `❯` input prompt, a JSONL transcript, and the
 * Stop hook touching a signal file at the end of a real turn.
 *
 * Prompt commands:
 *   /model     a local command: records "Kept model as X" (no assistant turn,
 *              no Stop hook), exactly like Claude Code
 *   /goal turns=N <condition>
 *              a native goal: "Goal set" (a local-command record), then N
 *              self-continued turns. Each turn Stops, and its goal verdict
 *              (unmet…, finally met) lands AFTER the stop signal, the way
 *              Claude's goal-evaluating Stop hook does. The first turn starts
 *              after 3.5 s so a wait must not mistake "Goal set" for a
 *              finished local command.
 *   /goal hold <condition>
 *              a goal that stays active: one unmet turn, then idle
 *   /goal clear  clears an active goal (goal_status met+sentinel, like Claude)
 *   hang <text>  a turn that streams "WORKING: <text>" and never finishes on
 *              its own. Escape interrupts it the way Claude Code does: a
 *              "[Request interrupted by user]" record and NO Stop hook
 *   anything else  an assistant turn replying "ECHO: <text>", then Stop
 *
 * stdin is raw (when it's a TTY) so a lone Escape keypress arrives at once.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'

const [transcript, stopSignal] = process.argv.slice(2)
mkdirSync(dirname(transcript), { recursive: true })
mkdirSync(dirname(stopSignal), { recursive: true })

const record = (line: unknown) => appendFileSync(transcript, `${JSON.stringify(line)}\n`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const goalStatus = (fields: Record<string, unknown>) => record({ type: 'attachment', attachment: { type: 'goal_status', condition: 'c', ...fields } })
let goalActive = false

async function goalTurns(turns: number, hold: boolean) {
  await sleep(3_500)
  for (let i = 1; i <= turns && goalActive; i++) {
    record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `WORK ${i}` }] } })
    writeFileSync(stopSignal, String(Date.now()))
    await sleep(700)
    if (!goalActive) return
    const met = !hold && i === turns
    goalStatus(met ? { met: true, reason: 'done' } : { met: false })
    if (met) goalActive = false
  }
}

function startGoal(text: string) {
  record({ type: 'user', message: { role: 'user', content: `<command-name>/goal</command-name><command-args>${text.slice(6)}</command-args>` } })
  goalStatus({ met: false, sentinel: true })
  record({ type: 'user', message: { role: 'user', content: `<local-command-stdout>Goal set: ${text.slice(6)}</local-command-stdout>` } })
  goalActive = true
  const turns = /^\/goal turns=(\d+)/.exec(text)
  void goalTurns(turns ? Number(turns[1]) : 1, !turns)
}

let hanging = false
const ESC = '\x1b'

function interruptTurn() {
  if (!hanging) return
  hanging = false
  // Claude Code records the interrupt but does not run Stop hooks for it.
  record({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })
  process.stdout.write('\n  ⎿  Interrupted · What should Claude do instead?\n❯ ')
}

process.stdout.write('❯ ')
let buffer = ''
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  if (chunk.includes(ESC)) {
    interruptTurn()
    chunk = chunk.split(ESC).join('')
  }
  buffer += chunk
  let nl: number
  while ((nl = buffer.search(/[\r\n]/)) !== -1) {
    const text = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!text) continue
    if (text === '/goal clear') {
      if (goalActive) goalStatus({ met: true, sentinel: true })
      goalActive = false
      record({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>Goal cleared: c</local-command-stdout>' })
    } else if (text.startsWith('/goal ')) {
      startGoal(text)
    } else if (text.startsWith('hang ')) {
      record({ type: 'user', message: { role: 'user', content: text } })
      record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `WORKING: ${text.slice(5)}` }] } })
      hanging = true
      continue
    } else if (text === '/model') {
      record({ type: 'system', subtype: 'local_command', content: '<command-name>/model</command-name>' })
      record({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>Kept model as `Opus`</local-command-stdout>' })
    } else {
      record({ type: 'user', message: { role: 'user', content: text } })
      record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `ECHO: ${text}` }] } })
      writeFileSync(stopSignal, String(Date.now()))
    }
    process.stdout.write('\n❯ ')
  }
})
