import { describe, expect, test } from 'bun:test'
import {
  buildSettingsOverride, escapeWorkdirForTranscriptDir, isQuietDone,
  parseAssistantTextLines, parseDialogOptions, parseProgressLines, parseTabBar, rightPressesToReach, sessionNameFor, stopSignalPathFor, stripAnsi,
} from './claude-tmux-worker'

describe('sessionNameFor', () => {
  test('is deterministic for the same workdir', () => {
    expect(sessionNameFor('/Users/x/Projects/foo')).toBe(sessionNameFor('/Users/x/Projects/foo'))
  })
  test('differs for different workdirs', () => {
    expect(sessionNameFor('/Users/x/Projects/foo')).not.toBe(sessionNameFor('/Users/x/Projects/bar'))
  })
  test('is a valid tmux session name (no slashes/spaces)', () => {
    expect(sessionNameFor('/Users/x/Projects/foo')).toMatch(/^feishu-claude-[a-f0-9]{10}$/)
  })
})

describe('parseProgressLines', () => {
  test('extracts tool name and a short input summary', () => {
    const lines = [JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] },
    })]
    expect(parseProgressLines(lines)).toEqual([{ tool: 'Bash', summary: 'ls -la' }])
  })

  test('tries fields in priority order and falls back to empty summary', () => {
    const withPath = parseProgressLines([JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } }] },
    })])
    expect(withPath).toEqual([{ tool: 'Read', summary: '/a.ts' }])

    const noMatchingField = parseProgressLines([JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Mystery', input: { foo: 'bar' } }] },
    })])
    expect(noMatchingField).toEqual([{ tool: 'Mystery', summary: '' }])
  })

  test('truncates a long summary field', () => {
    const long = 'x'.repeat(200)
    const out = parseProgressLines([JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: long } }] },
    })])
    expect(out[0].summary.length).toBe(81) // 80 chars + the truncation ellipsis
    expect(out[0].summary.endsWith('…')).toBe(true)
  })

  test('collects multiple tool_use blocks from the same turn', () => {
    const lines = [JSON.stringify({
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'checking files' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
        { type: 'tool_use', name: 'Read', input: { file_path: '/b.ts' } },
      ] },
    })]
    expect(parseProgressLines(lines)).toEqual([
      { tool: 'Read', summary: '/a.ts' },
      { tool: 'Read', summary: '/b.ts' },
    ])
  })

  test('ignores non-assistant lines and malformed JSON without throwing', () => {
    const lines = ['{not json', JSON.stringify({ type: 'user', message: { content: 'hi' } })]
    expect(parseProgressLines(lines)).toEqual([])
  })
})

describe('escapeWorkdirForTranscriptDir', () => {
  test('matches Claude Code CLI\'s own project-dir naming (slash -> dash)', () => {
    expect(escapeWorkdirForTranscriptDir('/Users/openclaw/Projects/feishuchannel'))
      .toBe('-Users-openclaw-Projects-feishuchannel')
  })
})

describe('parseAssistantTextLines', () => {
  test('extracts plain string content', () => {
    const lines = [JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi there' } })]
    expect(parseAssistantTextLines(lines)).toEqual(['hi there'])
  })

  test('extracts and joins text blocks from array content', () => {
    const lines = [JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] },
    })]
    expect(parseAssistantTextLines(lines)).toEqual(['hello world'])
  })

  test('skips tool_use-only turns with no text block', () => {
    const lines = [JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] },
    })]
    expect(parseAssistantTextLines(lines)).toEqual([])
  })

  test('ignores non-assistant lines (user, summary)', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'summary' }),
    ]
    expect(parseAssistantTextLines(lines)).toEqual([])
  })

  test('skips malformed JSON lines without throwing', () => {
    const lines = ['{not json', JSON.stringify({ type: 'assistant', message: { content: 'ok' } })]
    expect(parseAssistantTextLines(lines)).toEqual(['ok'])
  })

  test('skips blank lines', () => {
    expect(parseAssistantTextLines(['', '   ', ''])).toEqual([])
  })

  test('collects multiple assistant turns in order', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: 'first' } }),
      JSON.stringify({ type: 'assistant', message: { content: 'second' } }),
    ]
    expect(parseAssistantTextLines(lines)).toEqual(['first', 'second'])
  })

  // Captured verbatim (2026-11-11) from a real transcript: a repeat /model
  // with nothing to pick resolves instantly with no real assistant turn and
  // no Stop-hook signal at all — reported live as "/model stuck again"
  // because sendAndAwaitReply had nothing else to notice it was done.
  test('surfaces a local_command system line\'s stdout (current CLI build)', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'local_command', content: '<local-command-name>/model</local-command-name>' }),
      JSON.stringify({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>Kept model as `Opus 5.5`</local-command-stdout>' }),
    ]
    expect(parseAssistantTextLines(lines)).toEqual(['Kept model as `Opus 5.5`'])
  })

  test('surfaces a user-line-wrapped local-command-stdout (older CLI build)', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '<command-name>/model</command-name>' } }),
      JSON.stringify({ type: 'user', message: { content: '<local-command-stdout>Set model to `Opus 5.5` and saved as your default for new sessions</local-command-stdout>' } }),
    ]
    expect(parseAssistantTextLines(lines)).toEqual(['Set model to `Opus 5.5` and saved as your default for new sessions'])
  })

  test('does not mistake an ordinary user message for local-command output', () => {
    const lines = [JSON.stringify({ type: 'user', message: { content: 'hello there' } })]
    expect(parseAssistantTextLines(lines)).toEqual([])
  })

  test('rejects a mismatched stdout-open/stderr-close wrapper instead of extracting it anyway', () => {
    const lines = [JSON.stringify({
      type: 'system', subtype: 'local_command',
      content: '<local-command-stdout>partial</local-command-stderr>',
    })]
    expect(parseAssistantTextLines(lines)).toEqual([])
  })
})

describe('stopSignalPathFor', () => {
  test('is deterministic and keyed by session id', () => {
    expect(stopSignalPathFor('abc')).toBe(stopSignalPathFor('abc'))
    expect(stopSignalPathFor('abc')).not.toBe(stopSignalPathFor('def'))
  })
})

describe('buildSettingsOverride', () => {
  test('produces valid JSON with a Stop hook touching the session\'s signal path', () => {
    const parsed = JSON.parse(buildSettingsOverride('session-123'))
    const command: string = parsed.hooks.Stop[0].hooks[0].command
    expect(command).toContain(stopSignalPathFor('session-123'))
    expect(parsed.hooks.Stop[0].hooks[0].type).toBe('command')
  })
})

describe('stripAnsi', () => {
  test('removes SGR color/style codes', () => {
    expect(stripAnsi('\x1b[1m\x1b[36mhello\x1b[0m')).toBe('hello')
  })
  test('leaves plain text untouched', () => {
    expect(stripAnsi('plain text, no codes')).toBe('plain text, no codes')
  })
  test('lets parseDialogOptions see through color codes applied to a real menu', () => {
    const colored = [
      '\x1b[36mDo you want to allow Claude to fetch this content?\x1b[0m',
      '\x1b[32m❯ 1. Yes\x1b[0m',
      '  2. No',
    ].join('\n')
    const dialog = parseDialogOptions(stripAnsi(colored))
    expect(dialog).not.toBeNull()
    expect(dialog!.question).toBe('Do you want to allow Claude to fetch this content?')
  })
})

describe('parseDialogOptions', () => {
  // Captured verbatim (2026-11-11) from a real claude CLI run asked to WebFetch a URL.
  const realPermissionDialog = [
    '❯ use the WebFetch tool to fetch https://example.com and summarize it',
    '',
    "⏺ I don't have a direct WebFetch tool in this session, so I'll use the web-fetch agent, which stands in for it.",
    '',
    '  Fetch(https://example.com)',
    '  ⎿  Fetching…',
    '     (ctrl+b ctrl+b (twice) to run in background)',
    '',
    ' Fetch · from the web-fetch agent',
    ' Claude wants to fetch content from example.com',
    '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    ' url: https://example.com/',
    " │ prompt: What is the page title, main text, and all links on this page?",
    '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    ' Do you want to allow Claude to fetch this content?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for example.com",
    '   3. No, and tell Claude what to do differently (esc)',
    '',
    '',
  ].join('\n')

  test('extracts options and the question from a real permission dialog', () => {
    const dialog = parseDialogOptions(realPermissionDialog)
    expect(dialog).not.toBeNull()
    expect(dialog!.question).toBe('Do you want to allow Claude to fetch this content?')
    expect(dialog!.options).toEqual([
      { number: '1', label: 'Yes' },
      { number: '2', label: "Yes, and don't ask again for example.com" },
      { number: '3', label: 'No, and tell Claude what to do differently (esc)' },
    ])
  })

  test('does not mistake a numbered list in a finished reply for a dialog', () => {
    const finishedReply = [
      '❯ give me three steps',
      '',
      '⏺ Here are three steps:',
      '',
      '  1. First, do this',
      '  2. Then do that',
      '  3. Finally, done',
      '',
      '✻ Cooked for 3s · done 6:00 PM',
      '',
      '────────────────────',
      '❯ ',
      '────────────────────',
      '  ⏸ manual mode on · ? for shortcuts',
    ].join('\n')
    expect(parseDialogOptions(finishedReply)).toBeNull()
  })

  test('rejects non-consecutive option numbers', () => {
    const text = ['Pick one:', '1. Yes', '2. No', '4. Cancel', ''].join('\n')
    expect(parseDialogOptions(text)).toBeNull()
  })

  test('rejects options that do not start at 1', () => {
    const text = ['Pick one:', '2. Yes', '3. No', ''].join('\n')
    expect(parseDialogOptions(text)).toBeNull()
  })

  test('returns null when there are no numbered options at all', () => {
    expect(parseDialogOptions('just a normal reply\nwith no menu\n')).toBeNull()
  })

  test('tolerates trailing blank padding after the option block', () => {
    const text = ['Pick one:', '1. Yes', '2. No', '', '', ''].join('\n')
    const dialog = parseDialogOptions(text)
    expect(dialog).not.toBeNull()
    expect(dialog!.options).toHaveLength(2)
  })

  test('falls back to a generic question when no non-divider line precedes the options', () => {
    const text = ['1. Yes', '2. No', ''].join('\n')
    expect(parseDialogOptions(text)!.question).toBe('Claude 需要你的输入')
  })

  // Captured verbatim (2026-11-11) from a real /model panel — reported live
  // as "no card" because its trailing "▸ More models" / effort-indicator /
  // "Enter to set as default · s to use this session only · Esc to cancel"
  // footer isn't literally blank, which the original "must be the literal
  // bottom of the screen" rule rejected outright.
  const realModelPicker = [
    '❯ /model',
    '',
    '────────────────────',
    '  Select model',
    '  Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.',
    '',
    '    1.  Default (recommended)  Opus 5.5 · Best for everyday, complex tasks',
    '  ❯ 2.  Opus 5.5 ✔             For complex work and everyday tasks',
    '    3.  Fable 5.2              For your toughest challenges',
    '    4.  Sonnet 5.5             Most efficient for simpler tasks',
    '    5.  Haiku 5.5              Fastest for quick answers',
    '    ▸   More models',
    '',
    '  ◐ Medium effort (default) ←/→ to adjust',
    '',
    '  Enter to set as default · s to use this session only · Esc to cancel',
    '',
  ].join('\n')

  test('tolerates /model\'s trailing "more models"/effort/footer decoration', () => {
    const dialog = parseDialogOptions(realModelPicker)
    expect(dialog).not.toBeNull()
    expect(dialog!.options).toEqual([
      { number: '1', label: 'Default (recommended)  Opus 5.5 · Best for everyday, complex tasks' },
      { number: '2', label: 'Opus 5.5 ✔             For complex work and everyday tasks' },
      { number: '3', label: 'Fable 5.2              For your toughest challenges' },
      { number: '4', label: 'Sonnet 5.5             Most efficient for simpler tasks' },
      { number: '5', label: 'Haiku 5.5              Fastest for quick answers' },
    ])
  })

  test('rejects a reply that happens to mention "esc" without the "Esc to <verb>" footer shape', () => {
    const text = [
      'Pick one:', '1. Yes', '2. No', '',
      'Note: pressing esc elsewhere in this app does something unrelated.',
    ].join('\n')
    expect(parseDialogOptions(text)).toBeNull()
  })

  test('still rejects a finished reply whose trailing lines mention neither Esc nor the decoration glyphs', () => {
    // Same shape as the "finished reply" guard above, confirming the new
    // trailing-decoration tolerance doesn't quietly widen that hole.
    const finishedReply = [
      '❯ give me three steps',
      '',
      '⏺ Here are three steps:',
      '',
      '  1. First, do this',
      '  2. Then do that',
      '  3. Finally, done',
      '',
      '✻ Cooked for 3s · done 6:00 PM',
      '',
      '────────────────────',
      '❯ ',
      '────────────────────',
      '  ⏸ manual mode on · ? for shortcuts',
    ].join('\n')
    expect(parseDialogOptions(finishedReply)).toBeNull()
  })
})

describe('parseTabBar', () => {
  // Shape captured verbatim (2026-11-11) from a real /status panel.
  const realStatusPanel = [
    '❯ /status',
    '',
    '────────────────────',
    '  Settings  Status   Config   Usage   Stats',
    '',
    '  Version:                2.1.322',
    '  Session ID:             aaaaaaaa',
    '',
    '  Esc to cancel',
  ].join('\n')

  test('extracts tab labels and offers them as options, 1-indexed', () => {
    const dialog = parseTabBar(realStatusPanel)
    expect(dialog).not.toBeNull()
    expect(dialog!.kind).toBe('tabs')
    expect(dialog!.options).toEqual([
      { number: '1', label: 'Settings' },
      { number: '2', label: 'Status' },
      { number: '3', label: 'Config' },
      { number: '4', label: 'Usage' },
      { number: '5', label: 'Stats' },
    ])
  })

  test('requires the pane to end with "Esc to cancel"', () => {
    const noEscLine = realStatusPanel.split('\n').slice(0, -1).join('\n')
    expect(parseTabBar(noEscLine)).toBeNull()
  })

  test('returns null when there is no tab-bar-shaped line', () => {
    const text = ['❯ hello', '', '⏺ hi there', '', 'Esc to cancel'].join('\n')
    expect(parseTabBar(text)).toBeNull()
  })

  test('does not mistake a single capitalized word for a tab bar', () => {
    const text = ['Settings', '', 'Esc to cancel'].join('\n')
    expect(parseTabBar(text)).toBeNull()
  })

  test('marks the leftmost tab as currentNumber on first detection', () => {
    expect(parseTabBar(realStatusPanel)!.currentNumber).toBe('1')
  })
})

describe('rightPressesToReach', () => {
  test('matches the original "from leftmost" assumption when from is 1', () => {
    expect(rightPressesToReach('1', '3', 5)).toBe(2)
  })
  test('is 0 when already on the target tab', () => {
    expect(rightPressesToReach('3', '3', 5)).toBe(0)
  })
  test('moves forward within range', () => {
    expect(rightPressesToReach('3', '5', 5)).toBe(2)
  })
  test('wraps around past the last tab to reach an earlier one', () => {
    // 3 -> 4 -> 5 -> 1, three Right presses, not "two Left presses" (there is no Left)
    expect(rightPressesToReach('3', '1', 5)).toBe(3)
  })
  test('wraps around with a single press when already adjacent past the end', () => {
    expect(rightPressesToReach('5', '1', 5)).toBe(1)
  })
})

describe('isQuietDone', () => {
  test('false before the quiet period has elapsed', () => {
    expect(isQuietDone(1000, 2000, 2500)).toBe(false)
  })
  test('true once the quiet period has elapsed', () => {
    expect(isQuietDone(1000, 3600, 2500)).toBe(true)
  })
  test('true exactly at the boundary', () => {
    expect(isQuietDone(1000, 3500, 2500)).toBe(true)
  })
})
