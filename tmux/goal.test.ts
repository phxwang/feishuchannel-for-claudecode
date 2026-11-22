import { describe, expect, test } from 'bun:test'
import { goalLeftActive, nextGoalState, type GoalSignal, type GoalState } from './goal'
import { parseClaudeGoalSignal } from './profiles/claude-goal'

const status = (fields: Record<string, unknown>) =>
  JSON.stringify({ type: 'attachment', attachment: { type: 'goal_status', condition: 'c', ...fields } })

describe('parseClaudeGoalSignal (records seen live on Claude Code 2.1.330)', () => {
  test('maps goal_status met/sentinel to set, unmet, achieved and cleared', () => {
    expect(parseClaudeGoalSignal(status({ met: false, sentinel: true }))).toBe('set')
    expect(parseClaudeGoalSignal(status({ met: false }))).toBe('unmet')
    expect(parseClaudeGoalSignal(status({ met: true, reason: 'done' }))).toBe('achieved')
    // `/goal clear` writes met:true WITH sentinel — that is not achievement.
    expect(parseClaudeGoalSignal(status({ met: true, sentinel: true }))).toBe('cleared')
  })

  test('recognizes the Esc interrupt record in both content shapes', () => {
    expect(parseClaudeGoalSignal(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }))).toBe('interrupted')
    expect(parseClaudeGoalSignal(JSON.stringify({ type: 'user', message: { content: '[Request interrupted by user for tool use]' } }))).toBe('interrupted')
  })

  test('ignores prose, echoed markers, other attachments and malformed lines', () => {
    expect(parseClaudeGoalSignal(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '✔ Goal achieved (1 turn)' }] } }))).toBeNull()
    expect(parseClaudeGoalSignal(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'the "goal_status" record and [Request interrupted by user]' }] } }))).toBeNull()
    expect(parseClaudeGoalSignal(JSON.stringify({ type: 'user', message: { content: '<local-command-stdout>Goal set: x</local-command-stdout>' } }))).toBeNull()
    expect(parseClaudeGoalSignal(JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', content: '"goal_status"' } }))).toBeNull()
    expect(parseClaudeGoalSignal('{"type":"attachment","attachment":{"type":"goal_status"')).toBeNull()
  })
})

describe('nextGoalState', () => {
  const run = (signals: GoalSignal[], from: GoalState = 'none') => signals.reduce(nextGoalState, from)

  test('set → unmet… → achieved', () => {
    expect(run(['set', 'unmet', 'unmet', 'achieved'])).toBe('achieved')
  })

  test('a verdict with no active goal in this wait proves nothing', () => {
    expect(run(['achieved'])).toBe('none')
    expect(run(['cleared'])).toBe('none')
    expect(run(['interrupted'])).toBe('none')
  })

  test('an unmet verdict only continues a goal this wait set: a goal left armed earlier does not turn an ordinary message into a goal wait', () => {
    expect(run(['unmet'])).toBe('none')
    expect(run(['unmet', 'achieved'])).toBe('none')
    expect(run(['set', 'unmet'])).toBe('active')
  })

  test('clear and interrupt end an active goal without achieving it', () => {
    expect(run(['set', 'cleared'])).toBe('cleared')
    expect(run(['set', 'unmet', 'interrupted'])).toBe('interrupted')
  })

  test('goalLeftActive only fires on leaving an active goal', () => {
    expect(goalLeftActive('active', 'achieved')).toBe(true)
    expect(goalLeftActive('active', 'active')).toBe(false)
    expect(goalLeftActive('none', 'none')).toBe(false)
  })
})
