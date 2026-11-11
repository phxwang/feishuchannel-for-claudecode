import { describe, expect, test } from 'bun:test'
import {
  buildSettingsOverride, escapeWorkdirForTranscriptDir, isQuietDone,
  parseAssistantTextLines, parseDialogOptions, sessionNameFor, stopSignalPathFor,
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
