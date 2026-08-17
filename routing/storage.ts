/**
 * SQLite persistence — design doc §9 (持久化与并发).
 *
 * MVP subset actually wired up so far: conversation_bindings (sticky agent
 * binding), permissions (precise callback routing — replaces the
 * resolveWorkdir()-then-broadcast fallback in router.ts), and
 * processed_events (inbound Feishu event_id/message_id idempotency).
 * tasks/agent_sessions/card_states/backend_health land once the Adapter
 * layer is wired to real task execution.
 */
import { Database } from 'bun:sqlite'
import type { AgentKind, ConversationBinding } from './types'
import type { BindingStore } from './bindings'

export function openDb(path: string): Database {
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_bindings (
      conversation_key    TEXT PRIMARY KEY,
      project_id          TEXT NOT NULL,
      configured_primary  TEXT NOT NULL,
      configured_fallback TEXT,
      active_agent        TEXT NOT NULL,
      agent_session_id    TEXT NOT NULL,
      route_version       TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS permissions (
      code       TEXT PRIMARY KEY,
      workdir    TEXT NOT NULL,
      task_id    TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id     TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL
    );
  `)
  return db
}

// ── Conversation bindings ────────────────────────────────────────────────

export class SqliteBindingStore implements BindingStore {
  constructor(private db: Database) {}

  get(key: string): ConversationBinding | undefined {
    const row = this.db.query('SELECT * FROM conversation_bindings WHERE conversation_key = ?').get(key) as any
    if (!row) return undefined
    return {
      conversationKey: row.conversation_key,
      projectId: row.project_id,
      configuredPrimary: row.configured_primary,
      configuredFallback: row.configured_fallback,
      activeAgent: row.active_agent,
      agentSessionId: row.agent_session_id,
      routeVersion: row.route_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  put(binding: ConversationBinding): void {
    this.db.query(`
      INSERT INTO conversation_bindings
        (conversation_key, project_id, configured_primary, configured_fallback, active_agent, agent_session_id, route_version, created_at, updated_at)
      VALUES ($key, $project, $primary, $fallback, $active, $session, $version, $created, $updated)
      ON CONFLICT(conversation_key) DO UPDATE SET
        project_id = excluded.project_id,
        configured_primary = excluded.configured_primary,
        configured_fallback = excluded.configured_fallback,
        active_agent = excluded.active_agent,
        agent_session_id = excluded.agent_session_id,
        route_version = excluded.route_version,
        updated_at = excluded.updated_at
    `).run({
      $key: binding.conversationKey,
      $project: binding.projectId,
      $primary: binding.configuredPrimary,
      $fallback: binding.configuredFallback,
      $active: binding.activeAgent,
      $session: binding.agentSessionId,
      $version: binding.routeVersion,
      $created: binding.createdAt,
      $updated: binding.updatedAt,
    })
  }

  delete(key: string): void {
    this.db.query('DELETE FROM conversation_bindings WHERE conversation_key = ?').run(key)
  }
}

// ── Permission / confirm-card callback registry ──────────────────────────

export interface RegisteredCallback { workdir: string; taskId: string | null }

/**
 * Maps a permission/confirm card's `code` to the workdir (and eventually
 * adapter instance) that issued it, so router.ts's card.action.trigger
 * handler can route the button click precisely instead of broadcasting to
 * every connected worker when resolveWorkdir(chatId) is ambiguous or stale.
 */
export class PermissionRegistry {
  constructor(private db: Database) {}

  register(code: string, workdir: string, taskId: string | null, now: string): void {
    this.db.query(`
      INSERT INTO permissions (code, workdir, task_id, created_at) VALUES ($code, $workdir, $taskId, $now)
      ON CONFLICT(code) DO UPDATE SET workdir = excluded.workdir, task_id = excluded.task_id
    `).run({ $code: code, $workdir: workdir, $taskId: taskId, $now: now })
  }

  resolve(code: string): RegisteredCallback | undefined {
    const row = this.db.query('SELECT workdir, task_id FROM permissions WHERE code = ?').get(code) as any
    if (!row) return undefined
    return { workdir: row.workdir, taskId: row.task_id }
  }

  /** Single-use: call once the callback has been routed so the table doesn't grow unbounded. */
  consume(code: string): void {
    this.db.query('DELETE FROM permissions WHERE code = ?').run(code)
  }
}

// ── Inbound event idempotency ────────────────────────────────────────────

/**
 * Marks a Feishu event/message id as processed. Returns true if this is the
 * first time we've seen it (caller should proceed), false if it's a
 * duplicate delivery (caller should drop it).
 */
export function markEventProcessed(db: Database, eventId: string, now: string): boolean {
  const result = db.query('INSERT OR IGNORE INTO processed_events (event_id, processed_at) VALUES (?, ?)').run(eventId, now)
  return result.changes > 0
}
