import { describe, expect, test } from 'bun:test'
import { markEventProcessed, openDb, PermissionRegistry, SqliteBindingStore } from './storage'
import { createBinding, switchActiveAgent } from './bindings'

describe('SqliteBindingStore', () => {
  test('round-trips a binding', () => {
    const db = openDb(':memory:')
    const store = new SqliteBindingStore(db)
    expect(store.get('k')).toBeUndefined()

    const b = createBinding('k', 'inv', 'claude', 'opencode', 'sess-1', 'v1', '2026-01-01T00:00:00Z')
    store.put(b)
    expect(store.get('k')).toEqual(b)
  })

  test('put upserts on conflict (sticky switch persists)', () => {
    const db = openDb(':memory:')
    const store = new SqliteBindingStore(db)
    const b = createBinding('k', 'inv', 'claude', 'opencode', 'sess-1', 'v1', '2026-01-01T00:00:00Z')
    store.put(b)
    const switched = switchActiveAgent(b, 'opencode', 'sess-2', '2026-01-01T00:05:00Z')
    store.put(switched)
    expect(store.get('k')?.activeAgent).toBe('opencode')
    expect(store.get('k')?.agentSessionId).toBe('sess-2')
  })

  test('delete removes the row', () => {
    const db = openDb(':memory:')
    const store = new SqliteBindingStore(db)
    store.put(createBinding('k', 'inv', 'claude', null, 's', 'v1', '2026-01-01T00:00:00Z'))
    store.delete('k')
    expect(store.get('k')).toBeUndefined()
  })
})

describe('PermissionRegistry', () => {
  test('resolves a registered code', () => {
    const db = openDb(':memory:')
    const reg = new PermissionRegistry(db)
    reg.register('perm-1', '/Users/x/proj', 'task-1', '2026-01-01T00:00:00Z')
    expect(reg.resolve('perm-1')).toEqual({ workdir: '/Users/x/proj', taskId: 'task-1' })
  })

  test('unregistered code resolves to undefined (no broadcast fallback baked in here)', () => {
    const db = openDb(':memory:')
    const reg = new PermissionRegistry(db)
    expect(reg.resolve('never-registered')).toBeUndefined()
  })

  test('consume deletes so the table does not grow unbounded', () => {
    const db = openDb(':memory:')
    const reg = new PermissionRegistry(db)
    reg.register('perm-1', '/Users/x/proj', null, '2026-01-01T00:00:00Z')
    reg.consume('perm-1')
    expect(reg.resolve('perm-1')).toBeUndefined()
  })
})

describe('markEventProcessed', () => {
  test('first sighting returns true', () => {
    const db = openDb(':memory:')
    expect(markEventProcessed(db, 'evt-1', '2026-01-01T00:00:00Z')).toBe(true)
  })

  test('duplicate sighting returns false', () => {
    const db = openDb(':memory:')
    markEventProcessed(db, 'evt-1', '2026-01-01T00:00:00Z')
    expect(markEventProcessed(db, 'evt-1', '2026-01-01T00:00:01Z')).toBe(false)
  })
})
