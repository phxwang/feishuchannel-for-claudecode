import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  agyProfile, agySessionNameFor, agyTranscriptPath, buildAgySpawnArgs, parseAgyProgressLines, parseAgyTextLines, readAgyStop,
} from './agy'

// Step lines trimmed from a real agy 1.5.12 transcript_full.jsonl (2026-11-20).
const USER_INPUT = JSON.stringify({ step_index: 10, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>\nNow really run `rm junk.txt`.\n</USER_REQUEST>' })
const TOOL_CALL = JSON.stringify({ step_index: 11, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', model: 'gemini-3.8-flash-high', tool_calls: [{ name: 'run_command', args: { BypassSandbox: false, CommandLine: 'rm junk.txt', WaitMsBeforeAsync: 5000, toolSummary: 'Remove junk file' } }] })
const TOOL_STEP = JSON.stringify({ step_index: 12, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'Created At: 2026-11-20T11:44:31+08:00' })
const REPLY = JSON.stringify({ step_index: 13, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '`rm junk.txt` has been executed.\n\nHere is a list of 3 fruits:\n1. Apple\n2. Banana\n3. Orange', thinking: 'internal' })
const READ_FILE = JSON.stringify({ step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { Path: '/tmp/x/junk.txt' } }] })
const MIXED = JSON.stringify({ step_index: 25, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Running `sleep 20` in the background; waiting for it to finish.', tool_calls: [{ name: 'manage_task', args: { Action: 'status', TaskId: 't/task-24' } }] })
const SYSTEM = JSON.stringify({ step_index: 31, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'The following is a <SYSTEM_MESSAGE> ...' })

describe('parseAgyTextLines', () => {
  test('returns only PLANNER_RESPONSE content, in order', () => {
    expect(parseAgyTextLines([USER_INPUT, TOOL_CALL, TOOL_STEP, REPLY, SYSTEM])).toEqual([
      '`rm junk.txt` has been executed.\n\nHere is a list of 3 fruits:\n1. Apple\n2. Banana\n3. Orange',
    ])
  })
  test('keeps text that precedes a tool call in the same step', () => {
    expect(parseAgyTextLines([MIXED])).toEqual(['Running `sleep 20` in the background; waiting for it to finish.'])
  })
  test('skips blank, partial and non-JSON lines', () => {
    expect(parseAgyTextLines(['', '{"type":"PLANNER_RES', 'garbage', REPLY.slice(0, 20)])).toEqual([])
  })
})

describe('parseAgyProgressLines', () => {
  test('summarizes each tool call by its most useful argument', () => {
    expect(parseAgyProgressLines([TOOL_CALL, READ_FILE, REPLY])).toEqual([
      { tool: 'run_command', summary: 'rm junk.txt' },
      { tool: 'read_file', summary: '/tmp/x/junk.txt' },
    ])
  })
  test('falls back to toolSummary, then to nothing', () => {
    const line = JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'manage_task', args: { toolSummary: 'Check task' } }, { name: 'noop', args: {} }] })
    expect(parseAgyProgressLines([line])).toEqual([{ tool: 'manage_task', summary: 'Check task' }, { tool: 'noop', summary: '' }])
  })
})

describe('agy spawn plan', () => {
  test('zero config: only the session-scoped workspace trust, no model/effort/mode flags', () => {
    const args = buildAgySpawnArgs('/usr/bin/agy', '/w/inv4', {})
    expect(args).toEqual(['/usr/bin/agy', '--settings', JSON.stringify({ trustedWorkspaces: ['/w/inv4'] })])
  })
  test('passes configured flags and resumes a known conversation', () => {
    const args = buildAgySpawnArgs('/usr/bin/agy', '/w/inv4', { model: 'claude-opus-4-6-thinking', effort: 'high', permissionMode: 'accept-edits' }, 'conv-1')
    expect(args).toEqual([
      '/usr/bin/agy', '--conversation', 'conv-1', '--model', 'claude-opus-4-6-thinking', '--effort', 'high', '--mode', 'accept-edits',
      '--settings', JSON.stringify({ trustedWorkspaces: ['/w/inv4'] }),
    ])
  })
  test('the signal dir env var is set so the router plugin hook activates', () => {
    const plan = agyProfile.planSpawn('/w/inv4', {})
    expect(plan.env.FEISHU_AGY_SIGNAL_DIR).toContain(agySessionNameFor('/w/inv4'))
    expect(plan.sessionId).toBeUndefined()
  })
  test('never auto-approves everything', () => {
    expect(buildAgySpawnArgs('agy', '/w', { permissionMode: 'auto' }).join(' ')).not.toContain('dangerously')
  })
})

describe('agy session naming and paths', () => {
  test('session name is stable, tmux-safe and distinct from Claude sessions', () => {
    const n = agySessionNameFor('/Users/openclaw/Projects/inv4')
    expect(n).toMatch(/^feishu-agy-[0-9a-f]{10}$/)
    expect(agySessionNameFor('/Users/openclaw/Projects/inv4')).toBe(n)
  })
  test('transcript path follows agy brain layout', () => {
    expect(agyTranscriptPath('abc')).toMatch(/\.gemini\/antigravity-cli\/brain\/abc\/\.system_generated\/logs\/transcript_full\.jsonl$/)
  })
})

describe('readAgyStop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-stop-'))
  test('fullyIdle false means background work is still running', () => {
    const p = join(dir, 'a.json')
    writeFileSync(p, JSON.stringify({ conversationId: 'c1', terminationReason: 'NO_TOOL_CALL', fullyIdle: false, lastUserInput: 'Run sleep', error: '' }))
    expect(readAgyStop(p)).toEqual({ wait: 'wait-capped', conversationId: 'c1', lastUserInput: 'Run sleep' })
  })
  test('fullyIdle true is done; an error is surfaced', () => {
    const p = join(dir, 'b.json')
    writeFileSync(p, JSON.stringify({ conversationId: 'c1', terminationReason: 'ERROR', fullyIdle: true, lastUserInput: 'x', error: 'RESOURCE_EXHAUSTED: weekly quota' }))
    expect(readAgyStop(p)).toEqual({ wait: 'done', conversationId: 'c1', lastUserInput: 'x', error: 'RESOURCE_EXHAUSTED: weekly quota' })
  })
  test('a missing or corrupt file is treated as done, never throws', () => {
    expect(readAgyStop(join(dir, 'missing.json'))).toEqual({ wait: 'done' })
    const p = join(dir, 'c.json')
    writeFileSync(p, '{not json')
    expect(readAgyStop(p)).toEqual({ wait: 'done' })
  })
})

// Pane captures from a real agy 1.5.12 tmux session (2026-11-20), trailing
// spaces trimmed.
const PERMISSION_PANE = `> Create a file note.txt containing hi, then run \`cat note.txt\`.
● Edited 1 file (note.txt)
● Ran 2 commands (cat note.txt ×2) (ctrl+o to expand)
Command
────────────────────────────────────────────────────────────

Requesting permission for:
   cat note.txt

Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation for commands that start with 'cat'
  3. Yes, and always allow for commands that start with 'cat' (Persist to settings.json)
  4. No, cancel

  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command

esc to cancel                                                     Gemini 3.8 Flash · high`

const IDLE_AFTER_LIST_PANE = `> Now really run \`rm junk.txt\`. Then give me a numbered list of 3 fruits.
● Ran (rm junk.txt) (ctrl+o to expand)
  rm junk.txt has been executed.
  Here is a list of 3 fruits:
  1. Apple
  2. Banana
  3. Orange
────────────────────────────────────────────────────────────
>
────────────────────────────────────────────────────────────
? for shortcuts                                              auto · Gemini 3.8 Flash · high`

const MODEL_PANE = `Switch Model

  Search:
          ────────────────────
> Gemini 3.8 Flash             (current)
  Claude Sonnet 4.6 (Thinking)
  Claude Opus 4.6 (Thinking)
  GPT-OSS 120B (Medium)

  Effort  ◂        ●━━━━━━━━━━━━━━●━━━━━━━━━━━━━━◉        ▸
                  low          medium          high
            Deeper reasoning for complex problems — slower but stronger

Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back
                                                             auto · Gemini 3.8 Flash · high`

describe('agy dialogs', () => {
  test('permission prompt with a ">" cursor becomes a numbered dialog', () => {
    const d = agyProfile.parseDialog(PERMISSION_PANE)!
    expect(d.kind).toBe('numbered')
    expect(d.question).toBe('Run this command?')
    expect(d.options.map(o => o.label)).toEqual([
      'Yes, run command',
      "Yes, and always allow in this conversation for commands that start with 'cat'",
      "Yes, and always allow for commands that start with 'cat' (Persist to settings.json)",
      'No, cancel',
    ])
  })
  test('a numbered list in a finished reply is not mistaken for a dialog', () => {
    expect(agyProfile.parseDialog(IDLE_AFTER_LIST_PANE)).toBeNull()
  })
  test('/model picker becomes a cursor dialog starting at the highlighted row', () => {
    const d = agyProfile.parseDialog(MODEL_PANE)!
    expect(d.kind).toBe('cursor')
    expect(d.currentNumber).toBe('1')
    expect(d.options.map(o => o.label)).toEqual([
      'Gemini 3.8 Flash (current)', 'Claude Sonnet 4.6 (Thinking)', 'Claude Opus 4.6 (Thinking)', 'GPT-OSS 120B (Medium)',
    ])
    expect(d.question).toBe('Switch Model')
  })
  test('selecting an option sends only the digit (agy selects immediately, no Enter)', () => {
    expect(agyProfile.optionKeys({ number: '2', label: 'x' })).toEqual([['-l', '2']])
  })
  test('ready once the idle footer is shown', () => {
    expect(agyProfile.isReady(IDLE_AFTER_LIST_PANE)).toBe(true)
    expect(agyProfile.isReady(PERMISSION_PANE)).toBe(false)
  })
})
