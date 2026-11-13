import type { BindingStore } from './bindings'

/** A failed task is not a failed session. Never erase context on network,
 * provider, rate-limit or observation errors, nor erase a replacement binding. */
export function evictMissingOpenCodeBinding(store: BindingStore, key: string, sessionId: string, reason: string): boolean {
  if (reason !== 'session_missing' || store.get(key)?.agentSessionId !== sessionId) return false
  store.delete(key)
  return true
}
