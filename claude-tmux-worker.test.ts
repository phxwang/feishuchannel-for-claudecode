import { describe, expect, test } from 'bun:test'
import { escapeWorkdirForTranscriptDir, isQuietDone, parseAssistantTextLines, sessionNameFor } from './claude-tmux-worker'

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
