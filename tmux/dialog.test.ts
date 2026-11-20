import { describe, expect, test } from 'bun:test'
import { cursorMovesToReach, parseCursorList, parseDialogOptions } from './dialog'

describe('parseCursorList', () => {
  const TRUST_PANE = `Accessing workspace:
/private/tmp/agytmux
Do you trust the contents of this project?
Antigravity CLI requires permission to read, edit, and execute files here.
> Yes, I trust this folder
  No, exit
  ↑/↓ Navigate · enter Confirm
                                                     auto · Gemini 3.8 Flash · high`

  test('detects the workspace-trust picker', () => {
    const d = parseCursorList(TRUST_PANE)!
    expect(d.kind).toBe('cursor')
    expect(d.options.map(o => o.label)).toEqual(['Yes, I trust this folder', 'No, exit'])
    expect(d.currentNumber).toBe('1')
    expect(d.question).toBe('Antigravity CLI requires permission to read, edit, and execute files here.')
  })

  test('reads the cursor position when it is not on the first row', () => {
    const pane = `Pick one
  Alpha
> Beta
  Gamma
↑/↓ Navigate · enter Select`
    const d = parseCursorList(pane)!
    expect(d.currentNumber).toBe('2')
    expect(cursorMovesToReach(d.currentNumber!, '1')).toBe(-1)
    expect(cursorMovesToReach(d.currentNumber!, '3')).toBe(1)
  })

  test('requires the picker footer near the bottom — a quoted line in reply text never matches', () => {
    expect(parseCursorList(`Here is a quote:\n> something wise\n  continued\n\n? for shortcuts`)).toBeNull()
    expect(parseCursorList(`> a\n  b\n↑/↓ Navigate · enter Select\nmore\nlines\nbelow\nhere`)).toBeNull()
  })

  test('needs at least two rows', () => {
    expect(parseCursorList(`> only\n↑/↓ Navigate · enter Select`)).toBeNull()
  })
})

describe('parseDialogOptions — default (Claude) behavior is unchanged', () => {
  const pane = `Run this command?\n> 1. Yes\n  2. No\n\nesc to cancel`
  test('a ">" cursor is not accepted unless the profile asks for it', () => {
    expect(parseDialogOptions(pane)).toBeNull()
  })
  test('with cursorChars ">" the same menu parses', () => {
    const d = parseDialogOptions(pane, { cursorChars: '>❯', fallbackQuestion: 'x' })!
    expect(d.options.map(o => o.label)).toEqual(['Yes', 'No'])
    expect(d.question).toBe('Run this command?')
  })
})
