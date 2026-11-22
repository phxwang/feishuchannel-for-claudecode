/**
 * Test double for `codex exec --json`, used by task-service/backends/codex.test.ts.
 * Reads the prompt from stdin (argv ends with `-`), emits the exec JSONL event
 * shapes on stdout and writes the `-o` last-message file on completion.
 * Every invocation appends its argv to `<dir of -o>/spawns.jsonl`.
 *
 * Behaviour, switched by prompt text:
 *   FAIL_STARTUP  exit 1 before thread.started (stderr only)
 *   HANG_HARD     thread/turn started, then ignores SIGINT forever
 *   HANG          thread/turn started, then waits; SIGINT exits 130
 *   SLOW          like default, with a pause after turn.started
 *   ERROR         a top-level `error` event, exit 1
 *   FAIL          turn.failed, exit 1
 *   default       command_execution item + agent_message + turn.completed, exit 0
 */
import { appendFileSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

const args = process.argv.slice(2)
if (args.includes('--version')) {
  process.stdout.write('codex-cli 0.0.0-fake\n')
  process.exit(0)
}

const outIdx = args.indexOf('-o')
const lastMessagePath = outIdx >= 0 ? args[outIdx + 1] : null
if (lastMessagePath) appendFileSync(join(dirname(lastMessagePath), 'spawns.jsonl'), `${JSON.stringify({ argv: args, cwd: process.cwd() })}\n`)

const emit = (ev: unknown) => process.stdout.write(`${JSON.stringify(ev)}\n`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const prompt = args.at(-1) === '-' ? readFileSync(0, 'utf8') : ''
const threadId = `thread-${process.pid}`

function startTurn(): void {
  emit({ type: 'thread.started', thread_id: threadId })
  emit({ type: 'turn.started' })
}

async function completeTurn(): Promise<void> {
  const cmd = { id: 'item_0', type: 'command_execution', command: 'bash -lc ls', aggregated_output: '', exit_code: null, status: 'in_progress' }
  emit({ type: 'item.started', item: cmd })
  emit({ type: 'item.completed', item: { ...cmd, aggregated_output: 'a\nb\n', exit_code: 0, status: 'completed' } })
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'reasoning', text: 'thinking' } })
  const reply = `DONE: ${prompt.trim().slice(0, 40)}`
  emit({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: reply } })
  if (lastMessagePath) writeFileSync(lastMessagePath, reply)
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } })
}

async function main(): Promise<void> {
  if (prompt.includes('FAIL_STARTUP')) {
    process.stderr.write('Error: fake startup failure\n')
    process.exit(1)
  }
  startTurn()
  if (prompt.includes('HANG_HARD')) {
    process.on('SIGINT', () => { /* ignored on purpose */ })
    setInterval(() => {}, 1000)
    return
  }
  if (prompt.includes('HANG')) {
    process.on('SIGINT', () => process.exit(130))
    setInterval(() => {}, 1000)
    return
  }
  if (prompt.includes('ERROR')) {
    emit({ type: 'error', message: 'stream disconnected' })
    process.exit(1)
  }
  if (prompt.includes('FAIL')) {
    emit({ type: 'turn.failed', error: { message: 'model refused' } })
    process.exit(1)
  }
  if (prompt.includes('SLOW')) await sleep(800)
  await completeTurn()
  process.exit(0)
}

void main()
