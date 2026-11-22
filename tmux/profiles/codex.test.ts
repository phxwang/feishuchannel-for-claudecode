import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CODEX_NOTIFY_SCRIPT, buildCodexSpawnArgs, codexSessionNameFor, codexSignalDirFor, createCodexProfile, isCodexReady,
  notifiedThreadIds, parseCodexDialog, readCodexStop,
} from './codex'
import {
  dayDirs, findRollout, isCodexTurnEndLine, isCodexTurnStartLine, isOwnTuiSession, lastTurnEnd, parseCodexProgressLines,
  parseCodexTextLines, rolloutIdFromPath, rolloutsCreatedSince,
} from './codex-rollout'

// Records trimmed from real codex-cli 0.169.1 rollouts (2026-11-22, mock model).
const META = (cwd: string, extra: Record<string, unknown> = {}) => JSON.stringify({ timestamp: '2026-11-22T10:18:26.000Z', type: 'session_meta', payload: { id: '01a202c3-a893-7ab1-b2a7-86c468053100', cwd, originator: 'codex-tui', cli_version: '0.169.1', source: 'cli', ...extra } })
const TASK_STARTED = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: '01a202c4-f76d-7380-ad97-f4023563c404' } })
const USER = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'RUNCMD please' }] } })
const ENV_CONTEXT = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…' }] } })
const FUNCTION_CALL = JSON.stringify({ type: 'response_item', payload: { type: 'function_call', id: 'fc_23', name: 'exec_command', arguments: '{"cmd":"touch /tmp/x && echo hi","sandbox_permissions":"require_escalated","justification":"probe"}', call_id: 'call_23' } })
const CUSTOM_CALL = JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'const r = await tools.exec_command({cmd:"pwd"})\ntext(r)', call_id: 'call_a' } })
const SHELL_ARRAY_CALL = JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["bash","-lc","ls -la"]}' } })
const AGENT_EVENT = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'TOOL DONE' }], phase: 'final_answer' } } })
const COMMENTARY = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Looking at the files.', annotations: [] }] } })
const ANSWER = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'TOOL DONE', annotations: [] }] } })
const COMPLETE = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't', last_agent_message: 'TOOL DONE', duration_ms: 14262 } })
const FAILED = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 't', last_agent_message: null, error: { message: '{"error":{"message":"mock failure","type":"server_error"}}' } } })
const ABORTED = JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't', reason: 'interrupted', duration_ms: 2214 } })

describe('Codex rollout parsing', () => {
  test('reply text is every assistant response_item (commentary and final), never the duplicate event copy', () => {
    expect(parseCodexTextLines([META('/w'), TASK_STARTED, ENV_CONTEXT, USER, COMMENTARY, FUNCTION_CALL, AGENT_EVENT, ANSWER, COMPLETE])).toEqual(['Looking at the files.', 'TOOL DONE'])
  })
  test('skips blank, partial and non-JSON lines', () => {
    expect(parseCodexTextLines(['', '{"type":"response_item","pay', 'garbage', '[1,2]', ANSWER.slice(0, 30)])).toEqual([])
  })
  test('progress: function calls by their command or path, custom tool calls by the first input line', () => {
    expect(parseCodexProgressLines([FUNCTION_CALL, CUSTOM_CALL, SHELL_ARRAY_CALL, ANSWER])).toEqual([
      { tool: 'exec_command', summary: 'touch /tmp/x && echo hi' },
      { tool: 'exec', summary: 'const r = await tools.exec_command({cmd:"pwd"})' },
      { tool: 'shell', summary: 'bash -lc ls -la' },
    ])
  })
  test('turn start and turn end records', () => {
    expect(isCodexTurnStartLine(TASK_STARTED)).toBe(true)
    expect(isCodexTurnStartLine(USER)).toBe(false)
    expect([COMPLETE, FAILED, ABORTED].map(isCodexTurnEndLine)).toEqual([true, true, true])
    expect([TASK_STARTED, ANSWER, AGENT_EVENT].map(isCodexTurnEndLine)).toEqual([false, false, false])
    // Assistant text that merely mentions the record name is not a turn end.
    const quoting = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'emits "task_complete"' }] } })
    expect(isCodexTurnEndLine(quoting)).toBe(false)
  })
  test('rollout id comes from the file name', () => {
    expect(rolloutIdFromPath('/h/sessions/2026/11/22/rollout-2026-11-22T18-18-26-01a202c3-a893-7ab1-b2a7-86c468053100.jsonl')).toBe('01a202c3-a893-7ab1-b2a7-86c468053100')
    expect(rolloutIdFromPath('/h/other.jsonl')).toBeUndefined()
  })
})

describe('readCodexStop / lastTurnEnd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-stop-'))
  const write = (name: string, lines: string[]) => { const p = join(dir, name); writeFileSync(p, lines.join('\n') + '\n'); return p }
  const id = '01a202c3-a893-7ab1-b2a7-86c468053100'
  test('a completed turn is done and names the thread', () => {
    const p = write(`rollout-2026-11-22T18-18-26-${id}.jsonl`, [META('/w'), TASK_STARTED, ANSWER, COMPLETE])
    expect(readCodexStop(p)).toEqual({ wait: 'done', conversationId: id })
  })
  test('a failed turn surfaces its error; only the latest turn end counts', () => {
    const p = write('rollout-x-11111111-2222-3333-4444-555555555555.jsonl', [META('/w'), FAILED, TASK_STARTED, COMPLETE, TASK_STARTED, FAILED])
    expect(readCodexStop(p)).toEqual({ wait: 'done', conversationId: '11111111-2222-3333-4444-555555555555', error: '{"error":{"message":"mock failure","type":"server_error"}}' })
    expect(lastTurnEnd(write('b.jsonl', [FAILED, COMPLETE]))).toEqual({ kind: 'complete' })
  })
  test('an Esc interrupt is not an error', () => {
    expect(lastTurnEnd(write('c.jsonl', [TASK_STARTED, ABORTED]))).toEqual({ kind: 'aborted' })
    expect(readCodexStop(write('c2.jsonl', [ABORTED])).error).toBeUndefined()
  })
  test('missing transcript or file never throws', () => {
    expect(readCodexStop(null)).toEqual({ wait: 'done' })
    expect(readCodexStop(join(dir, 'missing.jsonl'))).toEqual({ wait: 'done' })
  })
})

describe('Codex spawn argv', () => {
  const NOTIFY = '/repo/codex-plugin/notify.sh'
  test('defaults: workspace-write sandbox, on-request approval, notify bridge, session-only trust', () => {
    expect(buildCodexSpawnArgs('/bin/codex', '/w/inv4', {}, NOTIFY)).toEqual([
      '/bin/codex', '-s', 'workspace-write', '-a', 'on-request',
      '-c', 'notify=["/bin/sh","/repo/codex-plugin/notify.sh"]',
      '-c', 'projects={"/w/inv4"={trust_level="trusted"}}',
    ])
  })
  test('model, effort, read-only sandbox, never-ask approval and resume', () => {
    expect(buildCodexSpawnArgs('codex', '/w', { model: 'gpt-6.2-sol', effort: 'high', sandbox: 'read-only', permissionMode: 'never' }, NOTIFY, '01a202c3-a893-7ab1-b2a7-86c468053100')).toEqual([
      'codex', 'resume', '01a202c3-a893-7ab1-b2a7-86c468053100', '-s', 'read-only', '-a', 'never', '-m', 'gpt-6.2-sol',
      '-c', 'model_reasoning_effort="high"',
      '-c', 'notify=["/bin/sh","/repo/codex-plugin/notify.sh"]',
      '-c', 'projects={"/w"={trust_level="trusted"}}',
    ])
  })
  test('workdir paths with quotes or backslashes stay valid TOML strings', () => {
    const args = buildCodexSpawnArgs('codex', '/w/a "b"\\c', {}, NOTIFY)
    expect(args.at(-1)).toBe('projects={"/w/a \\"b\\"\\\\c"={trust_level="trusted"}}')
  })
  test('refuses full access, bypass flags and junk values', () => {
    expect(() => buildCodexSpawnArgs('codex', '/w', { sandbox: 'danger-full-access' }, NOTIFY)).toThrow(/not allowed/)
    expect(() => buildCodexSpawnArgs('codex', '/w', { permissionMode: 'dangerously-bypass-approvals-and-sandbox' }, NOTIFY)).toThrow(/not allowed/)
    expect(() => buildCodexSpawnArgs('codex', '/w', { permissionMode: 'untrusted' }, NOTIFY)).toThrow(/not allowed/)
    expect(() => buildCodexSpawnArgs('codex', '/w', { model: '--dangerously-bypass-approvals-and-sandbox' }, NOTIFY)).toThrow(/invalid codex model/)
    expect(() => buildCodexSpawnArgs('codex', '/w', { effort: 'high"\nnotify=[]' }, NOTIFY)).toThrow(/invalid codex reasoning effort/)
    expect(() => buildCodexSpawnArgs('codex', '/w', {}, NOTIFY, '../../x')).toThrow(/invalid codex session id/)
    expect(buildCodexSpawnArgs('codex', '/w', {}, NOTIFY).join(' ')).not.toMatch(/dangerously|approve-for-me|full-access/)
  })
  test('planSpawn keeps an argv-prefix bin and sets the per-workdir signal dir', () => {
    const p = createCodexProfile({ bin: ['/usr/bin/bun', 'fake.ts'], signalRoot: '/sig' })
    const plan = p.planSpawn('/w/inv4', {})
    expect(plan.argv.slice(0, 4)).toEqual(['/usr/bin/bun', 'fake.ts', '-s', 'workspace-write'])
    expect(plan.env).toEqual({ FEISHU_CODEX_SIGNAL_DIR: join('/sig', codexSessionNameFor('/w/inv4')) })
    expect(plan.sessionId).toBeUndefined()
    expect(createCodexProfile().planSpawn('/w', {}).argv.join(' ')).toContain(CODEX_NOTIFY_SCRIPT)
  })
  test('session name is stable, tmux-safe and distinct from Claude/agy', () => {
    expect(codexSessionNameFor('/Users/x/inv4')).toMatch(/^feishu-codex-[0-9a-f]{10}$/)
    expect(codexSessionNameFor('/Users/x/inv4')).toBe(codexSessionNameFor('/Users/x/inv4'))
  })
})

// Pane captures from the real codex-cli 0.169.1 TUI in tmux (2026-11-22), trailing spaces trimmed.
const IDLE_PANE = `› hello there

• commentary for hello there

• ECHO: hello there
  1. Apple
  2. Banana

  Worked for <1s • 18:16

› Ask Codex to do anything

  mock-model default · /private/tmp/codex-probe/work
  ← for agents · ? for shortcuts                                                       ⚠ 1 warning · f2 to view`

const WORKING_PANE = `› SLOW first

• Working (3s • esc to interrupt)

• Messages to be submitted after next tool call (press esc to interrupt and send immediately)
  ↳ second msg

› Ask Codex to do anything

  mock-model default · /private/tmp/codex-probe/work
  ← for agents · ? for shortcuts                                                       ⚠ 2 warnings · f2 to view`

const APPROVAL_PANE = `› RUNCMD please

• Running touch /tmp/codex-probe-should-ask && echo hi

  Would you like to run the following command?

  Environment: local

  Reason: probe approval prompt

  $ touch /tmp/codex-probe-should-ask && echo hi

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`touch /tmp/codex-probe-should-ask\` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`

const MODEL_PANE = `  Select Model and Effort

› 1. GPT-6.2-Sol    Fast, go-to model for coding and everyday work.
  2. GPT-6.2-Astra  Our most capable model for complex coding and professional work.
  3. GPT-6.1 Terra  Efficient model that excels at visual understanding and computer use.
↓

  enter select · esc back`

const TRUST_PANE = `  Folder access
  /private/tmp/codex-probe/work
  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.
› 1. Trust and continue
  2. Back to Agent Command Center
  enter continue · esc back`

describe('Codex panes', () => {
  test('ready only when idle: the footer is shown and nothing is working', () => {
    expect(isCodexReady(IDLE_PANE)).toBe(true)
    expect(isCodexReady(WORKING_PANE)).toBe(false)
    expect(isCodexReady(APPROVAL_PANE)).toBe(false)
    expect(isCodexReady(TRUST_PANE)).toBe(false)
  })
  test('approval prompt: numbered, question is the prompt plus its command', () => {
    const d = parseCodexDialog(APPROVAL_PANE)!
    expect(d.kind).toBe('numbered')
    expect(d.question).toBe('Would you like to run the following command?\n$ touch /tmp/codex-probe-should-ask && echo hi')
    expect(d.options.map(o => o.label)).toEqual([
      'Yes, proceed (y)',
      "Yes, and don't ask again for commands that start with `touch /tmp/codex-probe-should-ask` (p)",
      'No, and tell Codex what to do differently (esc)',
    ])
  })
  test('/model picker is a numbered dialog despite the scroll arrow and footer', () => {
    const d = parseCodexDialog(MODEL_PANE)!
    expect(d.kind).toBe('numbered')
    expect(d.question).toBe('Select Model and Effort')
    expect(d.options).toHaveLength(3)
  })
  test('the folder-trust screen is still recognized as a dialog (never expected, since trust is passed per session)', () => {
    expect(parseCodexDialog(TRUST_PANE)?.options.map(o => o.label)).toEqual(['Trust and continue', 'Back to Agent Command Center'])
  })
  test('a numbered list in a finished reply is not a dialog', () => {
    expect(parseCodexDialog(IDLE_PANE)).toBeNull()
    expect(parseCodexDialog(WORKING_PANE)).toBeNull()
  })
  test('an option is picked by the bare digit (Codex acts at once, no Enter)', () => {
    expect(createCodexProfile().optionKeys({ number: '2', label: 'x' })).toEqual([['-l', '2']])
  })
})

describe('Codex session identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-id-'))
  const sessions = join(root, 'sessions')
  const workdir = join(root, 'w')
  mkdirSync(workdir)
  const MAIN = '01a202c3-a893-7ab1-b2a7-86c468053100'
  const TITLE = '01a202c3-ba92-7231-a582-3506aee26fc3'
  const OTHER_CWD = '01a202c5-0000-7000-8000-000000000001'
  const SUB = '01a202c5-0000-7000-8000-000000000002'
  const rollout = (day: string, id: string, meta: string) => {
    const dir = join(sessions, day)
    mkdirSync(dir, { recursive: true })
    const p = join(dir, `rollout-2026-11-22T18-18-26-${id}.jsonl`)
    writeFileSync(p, meta + '\n')
    return p
  }

  test('finds a rollout by id across day dirs, newest first', () => {
    rollout('2026/11/21', OTHER_CWD, META('/elsewhere'))
    const p = rollout('2026/11/22', MAIN, META(workdir))
    expect(dayDirs(sessions)).toEqual([join(sessions, '2026/11/22'), join(sessions, '2026/11/21')])
    expect(findRollout(sessions, MAIN)).toBe(p)
    expect(findRollout(sessions, TITLE)).toBeNull()
  })

  test('only interactive top-level sessions in the same workdir count', () => {
    expect(isOwnTuiSession(JSON.parse(META(workdir)).payload, workdir)).toBe(true)
    expect(isOwnTuiSession(JSON.parse(META('/elsewhere')).payload, workdir)).toBe(false)
    expect(isOwnTuiSession(JSON.parse(META(workdir, { originator: 'codex_exec', source: 'exec' })).payload, workdir)).toBe(false)
    expect(isOwnTuiSession(JSON.parse(META(workdir, { source: { subagent: { other: 'guardian' } } })).payload, workdir)).toBe(false)
  })

  test('discoverSessionId prefers a notified thread with a rollout, skipping the title thread', () => {
    const signalRoot = join(root, 'sig')
    const profile = createCodexProfile({ codexHome: root, signalRoot })
    profile.prepareSpawn!(workdir)
    const dir = codexSignalDirFor(workdir, signalRoot)
    rollout('2026/11/22', SUB, META(workdir, { source: { subagent: 'x' } }))
    // Title thread notified last (newest mtime) but has no rollout; a sub-agent thread has one but isn't ours.
    writeFileSync(join(dir, `notify-${MAIN}.json`), JSON.stringify({ 'thread-id': MAIN }))
    writeFileSync(join(dir, `notify-${SUB}.json`), JSON.stringify({ 'thread-id': SUB }))
    writeFileSync(join(dir, `notify-${TITLE}.json`), JSON.stringify({ 'thread-id': TITLE }))
    expect(notifiedThreadIds(dir)).toContain(TITLE)
    expect(profile.discoverSessionId!(workdir)).toBe(MAIN)
  })

  test('without notify, a single new rollout in the workdir is used; two are ambiguous', () => {
    const w2 = join(root, 'w2')
    mkdirSync(w2)
    const profile = createCodexProfile({ codexHome: root, signalRoot: join(root, 'sig2') })
    expect(profile.discoverSessionId!(w2)).toBeUndefined()  // never spawned by this profile: no fallback
    profile.prepareSpawn!(w2)
    expect(profile.discoverSessionId!(w2)).toBeUndefined()
    const a = rollout('2026/11/22', '01a202c6-0000-7000-8000-00000000000a', META(w2))
    expect(rolloutsCreatedSince(sessions, w2, 0)).toEqual([a])
    expect(profile.discoverSessionId!(w2)).toBe('01a202c6-0000-7000-8000-00000000000a')
    rollout('2026/11/22', '01a202c6-0000-7000-8000-00000000000b', META(w2))
    expect(profile.discoverSessionId!(w2)).toBeUndefined()
  })

  test('transcriptPath resolves the real rollout; findLatestTranscript never guesses', () => {
    const profile = createCodexProfile({ codexHome: root })
    expect(profile.transcriptPath(workdir, MAIN)).toBe(findRollout(sessions, MAIN)!)
    expect(profile.transcriptPath(workdir, TITLE)).not.toContain('2026')
    expect(profile.findLatestTranscript(workdir)).toBeNull()
    expect(profile.stopSignalPath(workdir, MAIN)).toBeNull()
  })
})

describe('codex-plugin/notify.sh', () => {
  const run = (payload: string, env: Record<string, string>) =>
    Bun.spawnSync(['sh', CODEX_NOTIFY_SCRIPT, payload], { env: { PATH: process.env.PATH ?? '', ...env } }).exitCode
  const PAYLOAD = '{"type":"agent-turn-complete","thread-id":"01a202c3-a893-7ab1-b2a7-86c468053100","turn-id":"t","cwd":"/w","client":"codex-tui","input-messages":["hi"],"last-assistant-message":"ECHO: hi"}'

  test('is a no-op outside router-spawned sessions (no signal dir env, or no such dir)', () => {
    expect(run(PAYLOAD, {})).toBe(0)
    expect(run(PAYLOAD, { FEISHU_CODEX_SIGNAL_DIR: '/nonexistent/feishu-codex' })).toBe(0)
  })
  test('writes notify-<thread>.json and last.json atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-notify-'))
    expect(run(PAYLOAD, { FEISHU_CODEX_SIGNAL_DIR: dir })).toBe(0)
    expect(readFileSync(join(dir, 'notify-01a202c3-a893-7ab1-b2a7-86c468053100.json'), 'utf8')).toBe(PAYLOAD)
    expect(readFileSync(join(dir, 'last.json'), 'utf8')).toBe(PAYLOAD)
    expect(readdirSync(dir).filter(n => n.startsWith('.'))).toEqual([])
  })
  test('ignores payloads without a well-formed thread id (no path traversal)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-notify-'))
    expect(run('{"thread-id":"../../evil"}', { FEISHU_CODEX_SIGNAL_DIR: dir })).toBe(0)
    expect(run('not json', { FEISHU_CODEX_SIGNAL_DIR: dir })).toBe(0)
    expect(readdirSync(dir)).toEqual([])
  })
})
