/**
 * SQLite persistence for the task service (design doc §10.1). All lifecycle
 * writes go through `tx()` so state, events and operation rows commit together.
 */
import { Database } from 'bun:sqlite'
import { chmodSync, existsSync } from 'fs'
import type { AttemptRecord, TaskEvent, TaskRecord, TurnRecord } from '../model'
import { migrate } from './migrations'

export interface OperationRow {
  clientId: string
  tool: string
  target: string
  idempotencyKey: string
  fingerprint: string
  state: 'pending' | 'completed'
  operationId: string
  envelope: string | null
  createdAt: number
}

export type NewEvent = Omit<TaskEvent, 'taskId' | 'seq' | 'at'>

export class TaskStore {
  readonly db: Database

  constructor(path: string) {
    const fresh = path !== ':memory:' && !existsSync(path)
    this.db = new Database(path, { create: true })
    if (fresh) { try { chmodSync(path, 0o600) } catch { /* best effort */ } }
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    migrate(this.db)
  }

  close(): void { this.db.close() }

  /** Run `fn` inside BEGIN IMMEDIATE; any throw rolls everything back. */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate()
  }

  // ── meta ───────────────────────────────────────────────────────────────
  getMeta(key: string): string | undefined {
    return (this.db.query('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | null)?.value
  }
  setMeta(key: string, value: string): void {
    this.db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  // ── tasks ──────────────────────────────────────────────────────────────
  private parseTask(row: { doc: string } | null): TaskRecord | undefined {
    return row ? JSON.parse(row.doc) as TaskRecord : undefined
  }
  getTask(taskId: string): TaskRecord | undefined {
    return this.parseTask(this.db.query('SELECT doc FROM tasks WHERE task_id = ?').get(taskId) as { doc: string } | null)
  }
  getTaskByClient(clientId: string, clientTaskId: string): TaskRecord | undefined {
    return this.parseTask(this.db.query('SELECT doc FROM tasks WHERE client_id = ? AND client_task_id = ?').get(clientId, clientTaskId) as { doc: string } | null)
  }
  findActiveScope(clientId: string, scopeKey: string): TaskRecord | undefined {
    return this.parseTask(this.db.query("SELECT doc FROM tasks WHERE client_id = ? AND scope_key = ? AND phase != 'CLOSED'").get(clientId, scopeKey) as { doc: string } | null)
  }
  listNonClosed(): TaskRecord[] {
    return (this.db.query("SELECT doc FROM tasks WHERE phase != 'CLOSED'").all() as { doc: string }[]).map(r => JSON.parse(r.doc))
  }
  insertTask(task: TaskRecord, prompt: string): void {
    this.db.query('INSERT INTO tasks (task_id, client_id, client_task_id, scope_key, phase, closed_at, doc) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(task.taskId, task.clientId, task.clientTaskId, task.scopeKey, task.phase, task.closedAtMs, JSON.stringify(task))
    this.db.query('INSERT INTO task_prompts (task_id, prompt) VALUES (?, ?)').run(task.taskId, Buffer.from(prompt, 'utf8'))
  }
  putTask(task: TaskRecord): void {
    const r = this.db.query('UPDATE tasks SET phase = ?, closed_at = ?, doc = ? WHERE task_id = ?')
      .run(task.phase, task.closedAtMs, JSON.stringify(task), task.taskId)
    if (r.changes !== 1) throw new Error(`task ${task.taskId} not found for update`)
  }
  getPrompt(taskId: string): string | undefined {
    const row = this.db.query('SELECT prompt FROM task_prompts WHERE task_id = ?').get(taskId) as { prompt: Uint8Array } | null
    return row ? Buffer.from(row.prompt).toString('utf8') : undefined
  }

  // ── operations ─────────────────────────────────────────────────────────
  getOperation(clientId: string, tool: string, target: string, key: string): OperationRow | undefined {
    const row = this.db.query('SELECT * FROM operations WHERE client_id = ? AND tool = ? AND target = ? AND idempotency_key = ?')
      .get(clientId, tool, target, key) as Record<string, any> | null
    if (!row) return undefined
    return {
      clientId: row.client_id, tool: row.tool, target: row.target, idempotencyKey: row.idempotency_key,
      fingerprint: row.fingerprint, state: row.state, operationId: row.operation_id, envelope: row.envelope, createdAt: row.created_at,
    }
  }
  putOperation(op: OperationRow): void {
    this.db.query(`INSERT INTO operations (client_id, tool, target, idempotency_key, fingerprint, state, operation_id, envelope, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_id, tool, target, idempotency_key) DO UPDATE SET state = excluded.state, envelope = excluded.envelope`)
      .run(op.clientId, op.tool, op.target, op.idempotencyKey, op.fingerprint, op.state, op.operationId, op.envelope, op.createdAt)
  }

  // ── attempts / turns ───────────────────────────────────────────────────
  putAttempt(a: AttemptRecord): void {
    this.db.query('INSERT INTO attempts (attempt_id, task_id, ordinal, doc) VALUES (?, ?, ?, ?) ON CONFLICT(attempt_id) DO UPDATE SET doc = excluded.doc')
      .run(a.executionAttemptId, a.taskId, a.ordinal, JSON.stringify(a))
  }
  getAttempt(id: string): AttemptRecord | undefined {
    const row = this.db.query('SELECT doc FROM attempts WHERE attempt_id = ?').get(id) as { doc: string } | null
    return row ? JSON.parse(row.doc) : undefined
  }
  listAttempts(taskId: string): AttemptRecord[] {
    return (this.db.query('SELECT doc FROM attempts WHERE task_id = ? ORDER BY ordinal').all(taskId) as { doc: string }[]).map(r => JSON.parse(r.doc))
  }
  putTurn(t: TurnRecord): void {
    this.db.query('INSERT INTO turns (turn_id, task_id, doc) VALUES (?, ?, ?) ON CONFLICT(turn_id) DO UPDATE SET doc = excluded.doc')
      .run(t.turnId, t.taskId, JSON.stringify(t))
  }
  getTurn(id: string): TurnRecord | undefined {
    const row = this.db.query('SELECT doc FROM turns WHERE turn_id = ?').get(id) as { doc: string } | null
    return row ? JSON.parse(row.doc) : undefined
  }
  listTurns(taskId: string): TurnRecord[] {
    return (this.db.query('SELECT doc FROM turns WHERE task_id = ? ORDER BY rowid').all(taskId) as { doc: string }[]).map(r => JSON.parse(r.doc))
  }
  putTurnText(turnId: string, text: string, sha256: string): void {
    const bytes = Buffer.from(text, 'utf8')
    this.db.query('INSERT INTO turn_texts (turn_id, text, sha256, bytes) VALUES (?, ?, ?, ?) ON CONFLICT(turn_id) DO UPDATE SET text = excluded.text, sha256 = excluded.sha256, bytes = excluded.bytes')
      .run(turnId, bytes, sha256, bytes.byteLength)
  }
  getTurnText(turnId: string): { bytes: Buffer; sha256: string } | undefined {
    const row = this.db.query('SELECT text, sha256 FROM turn_texts WHERE turn_id = ?').get(turnId) as { text: Uint8Array; sha256: string } | null
    return row ? { bytes: Buffer.from(row.text), sha256: row.sha256 } : undefined
  }

  // ── events ─────────────────────────────────────────────────────────────
  /** Appends events with consecutive seq after task.lastSeq; returns the stored events. Caller persists the updated task. */
  appendEvents(task: TaskRecord, events: NewEvent[], at: string): { task: TaskRecord; stored: TaskEvent[] } {
    let seq = task.lastSeq
    let bytes = task.eventBytes
    const stored: TaskEvent[] = []
    const insert = this.db.query('INSERT INTO events (task_id, seq, bytes, doc) VALUES (?, ?, ?, ?)')
    for (const e of events) {
      seq += 1
      const ev: TaskEvent = { taskId: task.taskId, seq, at, ...e }
      const doc = JSON.stringify(ev)
      const size = Buffer.byteLength(doc, 'utf8')
      insert.run(task.taskId, seq, size, doc)
      bytes += size
      stored.push(ev)
    }
    return { task: { ...task, lastSeq: seq, eventBytes: bytes }, stored }
  }

  readEvents(taskId: string, afterSeq: number, limit: number, maxBytes: number): TaskEvent[] {
    const rows = this.db.query('SELECT bytes, doc FROM events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(taskId, afterSeq, limit) as { bytes: number; doc: string }[]
    const out: TaskEvent[] = []
    let total = 0
    for (const r of rows) {
      if (out.length > 0 && total + r.bytes > maxBytes) break
      total += r.bytes
      out.push(JSON.parse(r.doc))
    }
    return out
  }

  minEventSeq(taskId: string): number | undefined {
    const row = this.db.query('SELECT MIN(seq) AS m FROM events WHERE task_id = ?').get(taskId) as { m: number | null }
    return row.m ?? undefined
  }

  // ── retention ──────────────────────────────────────────────────────────
  closedBefore(cutoffMs: number): string[] {
    return (this.db.query("SELECT task_id FROM tasks WHERE phase = 'CLOSED' AND closed_at IS NOT NULL AND closed_at < ?").all(cutoffMs) as { task_id: string }[])
      .map(r => r.task_id)
  }
  deleteEvents(taskId: string): number {
    return this.db.query('DELETE FROM events WHERE task_id = ?').run(taskId).changes
  }
  deleteResultBodies(taskId: string): void {
    this.db.query('DELETE FROM turn_texts WHERE turn_id IN (SELECT turn_id FROM turns WHERE task_id = ?)').run(taskId)
    this.db.query('DELETE FROM task_prompts WHERE task_id = ?').run(taskId)
  }
}
