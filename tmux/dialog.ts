/**
 * Plain-text parsers for interactive menus shown inside a tmux-hosted CLI
 * pane (permission prompts, `/model`-style pickers, `/status`-style tab
 * bars). CLI-agnostic: each CLI profile (tmux/profiles/*) passes the few
 * glyphs that differ — the cursor character in front of the selected option
 * and any extra footer lines that may trail a menu.
 *
 * Moved verbatim from claude-tmux-worker.ts; the default options reproduce
 * the original Claude-only behavior exactly.
 */

export interface DialogOption { number: string; label: string }
export interface Dialog {
  /**
   * 'numbered': a real choice menu, option N is selected by its digit (plus
   * Enter for CLIs that need it — see the profile's optionKeys).
   * 'tabs': a tab bar with no numbered jump target — option N is reached by
   * (N - currentNumber) Right presses (wrapping circularly) from the known
   * current tab.
   * 'cursor': a vertical list with a visible `>` cursor and no numbers
   * (agy's `/model` picker) — option N is reached by Up/Down presses from
   * the cursor's row, then Enter. Unlike 'tabs', the starting row is read
   * from the pane, not assumed.
   */
  kind: 'numbered' | 'tabs' | 'cursor'
  question: string
  /**
   * `kind: 'numbered'`: the rest of the dialog box above the question — for
   * a permission prompt the tool, the asking agent, the command and the
   * reason it needs approval — since the question itself is often just the
   * generic "Do you want to proceed?". Absent when nothing sits above it.
   */
  context?: string
  options: DialogOption[]
  /**
   * `kind: 'tabs'`: the tab believed to currently be focused — `'1'`
   * (leftmost) on first detection, since the CLI gives no plain-text signal
   * of which tab is actually open; updated to whichever tab was last
   * switched to for every subsequent card in the same switching session.
   * `kind: 'cursor'`: the row the cursor is on, as read from the pane.
   */
  currentNumber?: string
}

export interface DialogParseOptions {
  /** Characters that may prefix the highlighted option line. Claude: `❯`. agy: `>`. */
  cursorChars?: string
  /** Extra lines tolerated *after* an option block while still treating it as the bottom of the pane (e.g. agy's `↑/↓ Navigate · …` footer). */
  extraTrailingRes?: RegExp[]
  /** Card question used when no prompt line is found above the options. */
  fallbackQuestion?: string
}

const DIVIDER_LINE_RE = /^[\s─╌│]*$/
/** A line that's known decoration rather than further prompt content when it trails an option block — a collapsed-submenu marker (e.g. /model's "▸ More models") or an effort/mode indicator (e.g. "◐ Medium effort (default) ←/→ to adjust"). Narrow on purpose: this only has to cover known real panels, not every possible glyph. */
const TRAILING_DECORATION_RE = /^\s*[▸◐]/
/** An "Esc to <verb>" footer hint, case-insensitively — narrower than matching the bare word "esc" anywhere, which could otherwise wrongly tolerate ordinary reply text that happens to mention "esc" after an option block. */
const ESC_HINT_RE = /\besc\s+to\s+\w+/i
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g
/** The solid rule Claude draws across the top of a dialog box (dashed `╌` rules sit *inside* the box). */
const SOLID_RULE_RE = /^\s*─{3,}\s*$/
/** Lines that belong to the conversation above the dialog, not the dialog itself. */
const TRANSCRIPT_MARKER_RE = /^\s*[⏺⎿✻❯]/
/** Bounds on dialog context so a huge command can't flood the card; the lines nearest the question are kept. */
const MAX_CONTEXT_LINES = 12
const MAX_CONTEXT_LINE_CHARS = 300

/**
 * Lines of the dialog box above its question line, top to bottom: walks up,
 * skipping blank lines right above the question and dashed in-box dividers,
 * and stops at the box's edge — a blank line, the solid top rule, or a line
 * from the conversation transcript.
 */
function dialogContextAbove(lines: readonly string[], questionIdx: number): string | undefined {
  const collected: string[] = []
  let i = questionIdx - 1
  while (i >= 0 && lines[i].trim() === '') i--
  for (; i >= 0 && collected.length < MAX_CONTEXT_LINES; i--) {
    const line = lines[i]
    if (line.trim() === '' || SOLID_RULE_RE.test(line) || TRANSCRIPT_MARKER_RE.test(line)) break
    if (DIVIDER_LINE_RE.test(line)) continue
    const text = line.trim().replace(/^│\s?/, '').trim()
    collected.push(text.length > MAX_CONTEXT_LINE_CHARS ? `${text.slice(0, MAX_CONTEXT_LINE_CHARS)}…` : text)
  }
  return collected.length > 0 ? collected.reverse().join('\n') : undefined
}

const escapeForCharClass = (s: string) => s.replace(/[\\\]^-]/g, '\\$&')

function optionLineRe(cursorChars: string): RegExp {
  return new RegExp(`^\\s*(?:[${escapeForCharClass(cursorChars)}]\\s*)?(\\d+)\\.\\s+(.+?)\\s*$`)
}

/** Strip SGR color/style escape codes so layout-based parsing sees plain text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '')
}

/**
 * Detect an interactive numbered choice menu (permission prompts, etc.) in a
 * captured tmux pane, e.g.:
 *   Do you want to allow Claude to fetch this content?
 *   ❯ 1. Yes
 *     2. Yes, and don't ask again for example.com
 *     3. No, and tell Claude what to do differently (esc)
 *
 * Deliberately conservative to avoid mistaking a numbered list inside the
 * CLI's own *finished* reply text for a pending menu:
 *   - options must be numbered 1..N, consecutive, starting at 1
 *   - the option block must be the last non-blank content in the pane —
 *     a real menu replaces the normal input box/status bar while it's
 *     showing; a finished reply is always followed by both.
 * Tolerates a wrapped description line, a divider, or a blank separator
 * between options, but only when a further option continuing the sequence
 * actually follows (found live on multi-question AskUserQuestion dialogs).
 *
 * The pane can contain more than one numbered-list-shaped block (a finished
 * reply's own prose list above a real dialog further down), so every block
 * is scanned and the last one that sits at the bottom of the pane wins.
 * Returns null if no such menu is found.
 */
export function parseDialogOptions(paneText: string, opts: DialogParseOptions = {}): Dialog | null {
  const optionRe = optionLineRe(opts.cursorChars ?? '❯')
  const trailingRes = [TRAILING_DECORATION_RE, ESC_HINT_RE, ...(opts.extraTrailingRes ?? [])]
  const lines = paneText.split('\n')
  const blocks: { firstOptionIdx: number; lastOptionIdx: number; options: DialogOption[] }[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(optionRe)
    if (!m || m[1] !== '1') continue  // a block only starts at option "1."
    const options: DialogOption[] = [{ number: m[1], label: m[2].trim() }]
    let lastOptionIdx = i
    let j = i + 1
    while (j < lines.length) {
      const m2 = lines[j].match(optionRe)
      if (m2) {
        if (m2[1] !== String(options.length + 1)) break  // non-sequential — block ends here
        options.push({ number: m2[1], label: m2[2].trim() })
        lastOptionIdx = j
        j++
        continue
      }
      // Tolerate this filler line only if the *nearest* upcoming option-shaped
      // line continues the sequence — bounded to "the next thing that looks
      // like an option" rather than scanning arbitrarily far into the pane.
      const nextNumber = String(options.length + 1)
      const nextOptionLine = lines.slice(j + 1).find(l => optionRe.test(l))
      if (nextOptionLine && nextOptionLine.match(optionRe)![1] === nextNumber) { j++; continue }
      break
    }
    blocks.push({ firstOptionIdx: i, lastOptionIdx, options })
    i = lastOptionIdx  // resume scanning right after this block
  }

  for (let b = blocks.length - 1; b >= 0; b--) {
    const { firstOptionIdx, lastOptionIdx, options } = blocks[b]
    let isBottomOfPane = true
    for (let i = lastOptionIdx + 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim() === '' || trailingRes.some(re => re.test(line))) continue
      isBottomOfPane = false
      break  // something else follows — not the bottom of the screen
    }
    if (!isBottomOfPane) continue

    let questionIdx = -1
    for (let i = firstOptionIdx - 1; i >= 0; i--) {
      if (lines[i].trim() === '' || DIVIDER_LINE_RE.test(lines[i])) continue
      questionIdx = i
      break
    }
    const question = questionIdx >= 0 ? lines[questionIdx].trim() : ''
    const context = questionIdx >= 0 ? dialogContextAbove(lines, questionIdx) : undefined
    return {
      kind: 'numbered',
      question: question || opts.fallbackQuestion || 'Claude 需要你的输入',
      ...(context !== undefined && { context }),
      options,
    }
  }
  return null
}

const RUNNING_SHELL_RE = /(\d+)\s+shells?\b/i

/**
 * Reads Claude Code's own "N shell(s) [still running]" footer indicator off
 * the last non-blank line of the pane. Only checked on that last line so
 * this can't match the phrase "shell" appearing incidentally in reply text
 * higher up. Returns 0 when the line doesn't match at all.
 */
export function parseRunningShellCount(paneText: string): number {
  const lines = paneText.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '') continue
    const m = lines[i].match(RUNNING_SHELL_RE)
    return m ? parseInt(m[1], 10) : 0
  }
  return 0
}

const TAB_BAR_RE = /^\s*[A-Z][\w-]*(?:\s{2,}[A-Z][\w-]*){1,}\s*$/
const ESC_TO_CANCEL_RE = /^\s*Esc to cancel\s*$/

/**
 * Detect a plain tab bar (e.g. `/status`'s "Settings  Status   Config   Usage   Stats")
 * with no numbered jump target. Which tab is focused is conveyed only by
 * color/style, so navigation is an *assumption*: option N is reached by
 * (N-1) Right presses from an assumed leftmost starting tab. Only fires when
 * the pane's last non-blank line is literally "Esc to cancel".
 */
export function parseTabBar(paneText: string): Dialog | null {
  const lines = paneText.split('\n')
  let lastNonBlank = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') { lastNonBlank = i; break }
  }
  if (lastNonBlank === -1 || !ESC_TO_CANCEL_RE.test(lines[lastNonBlank])) return null

  for (const line of lines) {
    if (!TAB_BAR_RE.test(line)) continue
    const tabs = line.trim().split(/\s{2,}/)
    if (tabs.length < 2) continue
    return {
      kind: 'tabs',
      question: `切换到哪个标签页？（假设当前在第 1 个「${tabs[0]}」，可能不准）`,
      options: tabs.map((label, i) => ({ number: String(i + 1), label })),
      currentNumber: '1',
    }
  }
  return null
}

/** How many Right presses (there's no Left here) get from tab `from` to tab `to`, wrapping circularly through `numTabs` tabs. */
export function rightPressesToReach(from: string, to: string, numTabs: number): number {
  const delta = (Number(to) - Number(from)) % numTabs
  return (delta + numTabs) % numTabs
}

/** agy's picker footer, e.g. "Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back" or "↑/↓ Navigate · enter Confirm". */
const CURSOR_LIST_FOOTER_RE = /↑\/↓\s+Navigate.*\benter\s+\w+/i
/** Slider/indicator glyphs that can sit directly under a picker's rows (agy's `/model` effort slider) — never a selectable row. */
const NON_ITEM_GLYPH_RE = /[◂▸━●◉]/
/** How many non-blank lines from the bottom the picker footer may sit (agy prints its status line under it). */
const CURSOR_LIST_FOOTER_WINDOW = 3

/**
 * Detect a vertical picker with a visible cursor and no option numbers, e.g.
 * agy's `/model` panel or its workspace-trust prompt:
 *   > Gemini 3.8 Flash             (current)
 *     Claude Sonnet 4.6 (Thinking)
 *     Claude Opus 4.6 (Thinking)
 *   Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back
 *
 * Guarded the same way as the other parsers: the picker's own
 * "↑/↓ Navigate … enter <verb>" footer must be among the last few non-blank
 * lines, so ordinary reply text containing a `> quote` can't trigger it.
 * Rows are the contiguous run of lines at the cursor row's indentation
 * (cursor row `<indent>> label`, other rows `<indent>  label`).
 */
export function parseCursorList(paneText: string, opts: { cursorChar?: string; fallbackQuestion?: string } = {}): Dialog | null {
  const cursor = opts.cursorChar ?? '>'
  const lines = paneText.split('\n')
  const nonBlank: number[] = []
  for (let i = lines.length - 1; i >= 0 && nonBlank.length < CURSOR_LIST_FOOTER_WINDOW; i--) {
    if (lines[i].trim() !== '') nonBlank.push(i)
  }
  const footerIdx = nonBlank.find(i => CURSOR_LIST_FOOTER_RE.test(lines[i]))
  if (footerIdx === undefined) return null

  const cursorLineRe = new RegExp(`^(\\s*)${cursor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\S.*)$`)
  let cursorIdx = -1
  let indent = ''
  for (let i = footerIdx - 1; i >= 0; i--) {
    const m = lines[i].match(cursorLineRe)
    if (m && !NON_ITEM_GLYPH_RE.test(lines[i])) { cursorIdx = i; indent = m[1]; break }
  }
  if (cursorIdx === -1) return null

  const itemRe = new RegExp(`^${indent}  (\\S.*)$`)
  const isItem = (i: number) => i >= 0 && i < footerIdx && itemRe.test(lines[i]) && !NON_ITEM_GLYPH_RE.test(lines[i])
  let first = cursorIdx
  while (isItem(first - 1)) first--
  let last = cursorIdx
  while (isItem(last + 1)) last++

  const tidy = (s: string) => s.trim().replace(/\s{2,}/g, ' ')
  const options: DialogOption[] = []
  for (let i = first; i <= last; i++) {
    const label = i === cursorIdx ? lines[i].match(cursorLineRe)![2] : lines[i].match(itemRe)![1]
    options.push({ number: String(options.length + 1), label: tidy(label) })
  }
  if (options.length < 2) return null

  let question = ''
  for (let i = first - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (t === '' || DIVIDER_LINE_RE.test(lines[i]) || t.endsWith(':')) continue
    question = t
    break
  }
  return {
    kind: 'cursor',
    question: question || opts.fallbackQuestion || '请选择',
    options,
    currentNumber: String(cursorIdx - first + 1),
  }
}

/** Arrow-key presses from row `from` to row `to` in a 'cursor' list: positive = Down, negative = Up. */
export function cursorMovesToReach(from: string, to: string): number {
  return Number(to) - Number(from)
}
