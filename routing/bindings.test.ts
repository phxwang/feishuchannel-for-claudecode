import { describe, expect, test } from 'bun:test'
import {
  activeAgentFor, conversationKey, createBinding, InMemoryBindingStore, switchActiveAgent,
} from './bindings'

describe('conversationKey', () => {
  test('p2p key', () => {
    expect(conversationKey({ kind: 'p2p', userOpenId: 'ou_1', projectId: 'inv' })).toBe('p2p:ou_1:inv')
  })
  test('group thread key', () => {
    expect(conversationKey({ kind: 'group_thread', chatId: 'oc_1', rootMessageId: 'om_1', projectId: 'inv' }))
      .toBe('group:oc_1:thread:om_1:inv')
  })
  test('group (no thread) key', () => {
    expect(conversationKey({ kind: 'group', chatId: 'oc_1', projectId: 'inv' })).toBe('group:oc_1:inv')
  })
})

describe('sticky binding', () => {
  test('no binding yet -> uses configured primary', () => {
    const store = new InMemoryBindingStore()
    expect(activeAgentFor(store, 'k', 'claude')).toBe('claude')
  })

  test('existing binding overrides configured primary (sticky)', () => {
    const store = new InMemoryBindingStore()
    const b = createBinding('k', 'inv', 'claude', 'opencode', 'sess-1', 'v1', '2026-01-01T00:00:00Z')
    const switched = switchActiveAgent(b, 'opencode', 'sess-2', '2026-01-01T00:05:00Z')
    store.put(switched)
    // config still says primary=claude, but the sticky binding says opencode
    expect(activeAgentFor(store, 'k', 'claude')).toBe('opencode')
    expect(store.get('k')?.agentSessionId).toBe('sess-2')
  })

  test('delete clears the binding, reverting to configured primary', () => {
    const store = new InMemoryBindingStore()
    store.put(createBinding('k', 'inv', 'claude', null, 's', 'v1', '2026-01-01T00:00:00Z'))
    store.delete('k')
    expect(activeAgentFor(store, 'k', 'claude')).toBe('claude')
  })
})
