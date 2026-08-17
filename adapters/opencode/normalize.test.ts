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

  test('session.error -> task.failed, extracting the structured error message', () => {
    const raw = { type: 'session.error', properties: { error: { name: 'APIError', data: { message: 'boom', isRetryable: false } } } }
    expect(normalizeOpenCodeEvent(raw, 't1')).toEqual({ type: 'task.failed', taskId: 't1', reason: 'boom' })
  })

  test('session.error falls back to the error name when data.message is missing', () => {
    const raw = { type: 'session.error', properties: { error: { name: 'UnknownError', data: {} } } }
    expect(normalizeOpenCodeEvent(raw, 't1')).toEqual({ type: 'task.failed', taskId: 't1', reason: 'UnknownError' })
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

  test('step-start/step-finish parts are not text/tool -> null', () => {
    expect(normalizeOpenCodeEvent({ type: 'message.part.updated', properties: { part: { type: 'step-start' } } }, 't1')).toBeNull()
  })

  test('message.updated is not modeled (AssistantMessage carries no full text) -> null', () => {
    const raw = { type: 'message.updated', properties: { info: { role: 'assistant', sessionID: 's1' } } }
    expect(normalizeOpenCodeEvent(raw, 't1')).toBeNull()
  })

  test('permission.asked -> permission.requested', () => {
    const raw = { type: 'permission.asked', properties: { id: 'per_1', sessionID: 's1', permission: 'bash', patterns: [], metadata: {}, always: [] } }
    expect(normalizeOpenCodeEvent(raw, 't1')).toEqual({ type: 'permission.requested', taskId: 't1', requestId: 'per_1', toolName: 'bash', description: 'bash' })
  })

  test('unrecognized event type -> null (dropped, not guessed)', () => {
    expect(normalizeOpenCodeEvent({ type: 'something.new' }, 't1')).toBeNull()
  })
})
