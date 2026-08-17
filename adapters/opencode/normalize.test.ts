import { describe, expect, test } from 'bun:test'
import { belongsToSession, normalizeOpenCodeEvent } from './normalize'

describe('belongsToSession', () => {
  test('matches sessionID field', () => {
    expect(belongsToSession({ properties: { sessionID: 's1' } }, 's1')).toBe(true)
  })
  test('does not match a different session', () => {
    expect(belongsToSession({ properties: { sessionID: 's2' } }, 's1')).toBe(false)
  })
  test('no properties -> false', () => {
    expect(belongsToSession({}, 's1')).toBe(false)
  })
})

describe('normalizeOpenCodeEvent', () => {
  test('session.idle', () => {
    expect(normalizeOpenCodeEvent({ type: 'session.idle' }, 't1')).toEqual({ type: 'session.idle', taskId: 't1' })
  })

  test('session.error -> task.failed', () => {
    expect(normalizeOpenCodeEvent({ type: 'session.error', properties: { error: 'boom' } }, 't1'))
      .toEqual({ type: 'task.failed', taskId: 't1', reason: 'boom' })
  })

  test('text part -> text.delta', () => {
    const raw = { type: 'message.part.updated', properties: { part: { type: 'text', text: 'hello' } } }
    expect(normalizeOpenCodeEvent(raw, 't1')).toEqual({ type: 'text.delta', taskId: 't1', text: 'hello' })
  })

  test('tool part running -> tool.started', () => {
    const raw = { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'bash', state: { status: 'running' } } } }
    expect(normalizeOpenCodeEvent(raw, 't1')).toEqual({ type: 'tool.started', taskId: 't1', toolName: 'bash' })
  })

  test('tool part completed -> tool.completed', () => {
    const raw = { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'bash', state: { status: 'completed' } } } }
    expect(normalizeOpenCodeEvent(raw, 't1')).toEqual({ type: 'tool.completed', taskId: 't1', toolName: 'bash' })
  })

  test('tool part error -> tool.failed', () => {
    const raw = { type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'bash', state: { status: 'error', error: 'nope' } } } }
    expect(normalizeOpenCodeEvent(raw, 't1')).toEqual({ type: 'tool.failed', taskId: 't1', toolName: 'bash', error: 'nope' })
  })

  test('finished assistant message -> text.completed', () => {
    const raw = { type: 'message.updated', properties: { info: { role: 'assistant', text: 'done', finished: true } } }
    expect(normalizeOpenCodeEvent(raw, 't1')).toEqual({ type: 'text.completed', taskId: 't1', text: 'done' })
  })

  test('unfinished assistant message -> null', () => {
    const raw = { type: 'message.updated', properties: { info: { role: 'assistant', text: 'partial', finished: false } } }
    expect(normalizeOpenCodeEvent(raw, 't1')).toBeNull()
  })

  test('permission.updated -> permission.requested', () => {
    const raw = { type: 'permission.updated', properties: { id: 'p1', tool: 'bash', description: 'run rm -rf' } }
    expect(normalizeOpenCodeEvent(raw, 't1')).toEqual({ type: 'permission.requested', taskId: 't1', requestId: 'p1', toolName: 'bash', description: 'run rm -rf' })
  })

  test('unrecognized event type -> null (dropped, not guessed)', () => {
    expect(normalizeOpenCodeEvent({ type: 'something.new' }, 't1')).toBeNull()
  })
})
