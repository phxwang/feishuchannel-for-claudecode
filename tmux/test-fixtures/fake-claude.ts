/**
 * Minimal test double for the interactive `claude` CLI, run inside a real
 * tmux pane by tmux/claude-manager.test.ts. Mimics only what the router's
 * Claude profile relies on: the `❯` input prompt, a JSONL transcript, and the
 * Stop hook touching a signal file at the end of a real turn.
 *
 * Prompt commands:
 *   /model     a local command: records "Kept model as X" (no assistant turn,
 *              no Stop hook), exactly like Claude Code
 *   anything else  an assistant turn replying "ECHO: <text>", then Stop
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'

const [transcript, stopSignal] = process.argv.slice(2)
mkdirSync(dirname(transcript), { recursive: true })
mkdirSync(dirname(stopSignal), { recursive: true })

const record = (line: unknown) => appendFileSync(transcript, `${JSON.stringify(line)}\n`)

process.stdout.write('❯ ')
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buffer += chunk
  let nl: number
  while ((nl = buffer.search(/[\r\n]/)) !== -1) {
    const text = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!text) continue
    if (text === '/model') {
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
