/**
 * Forward-only migrations for task-service.db. Rows store their record as a
 * JSON document (`doc`) plus the indexed columns that need SQL constraints:
 * unique clientTaskId, active scope reservation, operation keys, per-task seq.
 */
import type { Database } from 'bun:sqlite'

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE tasks (
    task_id        TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL,
    client_task_id TEXT NOT NULL,
    scope_key      TEXT NOT NULL,
    phase          TEXT NOT NULL,
    closed_at      INTEGER,
    doc            TEXT NOT NULL,
    UNIQUE (client_id, client_task_id)
  );
  CREATE UNIQUE INDEX tasks_active_scope ON tasks (client_id, scope_key) WHERE phase != 'CLOSED';
  CREATE INDEX tasks_phase ON tasks (phase);
  CREATE TABLE task_prompts (task_id TEXT PRIMARY KEY REFERENCES tasks(task_id), prompt BLOB NOT NULL);
  CREATE TABLE operations (
    client_id       TEXT NOT NULL,
    tool            TEXT NOT NULL,
    target          TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    fingerprint     TEXT NOT NULL,
    state           TEXT NOT NULL,
    operation_id    TEXT NOT NULL,
    envelope        TEXT,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (client_id, tool, target, idempotency_key)
  );
  CREATE TABLE attempts (
    attempt_id TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL REFERENCES tasks(task_id),
    ordinal    INTEGER NOT NULL,
    doc        TEXT NOT NULL,
    UNIQUE (task_id, ordinal)
  );
  CREATE TABLE turns (
    turn_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    doc     TEXT NOT NULL
  );
  CREATE INDEX turns_task ON turns (task_id);
  CREATE TABLE turn_texts (
    turn_id TEXT PRIMARY KEY REFERENCES turns(turn_id),
    text    BLOB NOT NULL,
    sha256  TEXT NOT NULL,
    bytes   INTEGER NOT NULL
  );
  CREATE TABLE events (
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    seq     INTEGER NOT NULL,
    bytes   INTEGER NOT NULL,
    doc     TEXT NOT NULL,
    PRIMARY KEY (task_id, seq)
  );
  `,
]

export function migrate(db: Database): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
  const row = db.query('SELECT version FROM schema_version').get() as { version: number } | null
  let version = row?.version ?? 0
  if (!row) db.query('INSERT INTO schema_version (version) VALUES (0)').run()
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version]
    db.transaction(() => {
      db.exec(sql)
      db.query('UPDATE schema_version SET version = ?').run(version + 1)
    }).immediate()
    version++
  }
  return version
}
