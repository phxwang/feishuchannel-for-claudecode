import { expect, test } from 'bun:test'
import { createBinding, InMemoryBindingStore } from './bindings'
import { evictMissingOpenCodeBinding } from './opencode-recovery'

test('context survives transient task failures; only proven absence evicts the same session', () => {
  const store = new InMemoryBindingStore()
  store.put(createBinding('k', 'p', 'opencode', null, 'sess', '1', 'now'))
  for (const reason of ['connection_failed', 'task_timeout', 'backend_unavailable', 'rate_limited', 'capacity_exhausted', 'provider authentication failed']) {
    expect(evictMissingOpenCodeBinding(store, 'k', 'sess', reason)).toBe(false)
    expect(store.get('k')?.agentSessionId).toBe('sess')
  }
  expect(evictMissingOpenCodeBinding(store, 'k', 'obsolete-session', 'session_missing')).toBe(false)
  expect(evictMissingOpenCodeBinding(store, 'k', 'sess', 'session_missing')).toBe(true)
  expect(store.get('k')).toBeUndefined()
})
