/**
 * Claude Code's `/goal` records in the session transcript (verified live on
 * 2.1.330). The structured `goal_status` attachment is authoritative; pane
 * text such as "✔ Goal achieved" is presentation only and is not read.
 *
 *   {"type":"attachment","attachment":{"type":"goal_status","met":false,"sentinel":true,...}}  goal set
 *   {"type":"attachment","attachment":{"type":"goal_status","met":false,...}}                  evaluated after a turn: unmet, CLI continues
 *   {"type":"attachment","attachment":{"type":"goal_status","met":true,"reason":...}}          achieved
 *   {"type":"attachment","attachment":{"type":"goal_status","met":true,"sentinel":true,...}}   `/goal clear` (NOT achieved)
 *   {"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}  Esc
 *
 * The prefix match also covers `[Request interrupted by user for tool use]`
 * (a rejected tool call). That ends the turn waiting for user input just like
 * Esc, so a goal task stops there as not achieved; the task backend then
 * disarms the still-armed goal on release.
 *
 * The achieved verdict is written after the Stop hooks run, i.e. after the
 * router's own stop signal for that turn has already fired.
 */
import type { GoalSignal } from '../goal'

const INTERRUPTED_PREFIX = '[Request interrupted by user'

function parse(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line)
    return typeof v === 'object' && v !== null ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

function goalStatusSignal(record: Record<string, unknown>): GoalSignal | null {
  const a = record.attachment as Record<string, unknown> | undefined
  if (!a || a.type !== 'goal_status' || typeof a.met !== 'boolean') return null
  const sentinel = a.sentinel === true
  if (a.met) return sentinel ? 'cleared' : 'achieved'
  return sentinel ? 'set' : 'unmet'
}

function isInterruptRecord(record: Record<string, unknown>): boolean {
  if (record.type !== 'user') return false
  const content = (record.message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content.startsWith(INTERRUPTED_PREFIX)
  return Array.isArray(content) && content.some(c =>
    typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text' &&
    String((c as { text?: unknown }).text ?? '').startsWith(INTERRUPTED_PREFIX))
}

export function parseClaudeGoalSignal(line: string): GoalSignal | null {
  // Cheap pre-filters: transcripts are large and almost no line is goal-related.
  const maybeStatus = line.includes('"goal_status"')
  const maybeInterrupt = line.includes(INTERRUPTED_PREFIX)
  if (!maybeStatus && !maybeInterrupt) return null
  const record = parse(line)
  if (!record) return null
  if (maybeStatus) {
    const s = goalStatusSignal(record)
    if (s) return s
  }
  return maybeInterrupt && isInterruptRecord(record) ? 'interrupted' : null
}
