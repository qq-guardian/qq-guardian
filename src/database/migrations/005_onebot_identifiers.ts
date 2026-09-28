import { DatabaseSync } from 'node:sqlite';

export const version = 5;
export const description = 'Store provider-facing OneBot identifiers as exact decimal text';

const REBUILT_TABLES = [
  'users',
  'auth_sessions',
  'approval_records',
  'captcha_sessions',
  'blacklist',
  'punishment_records',
  'audit_logs',
  'stat_snapshots',
] as const;

const RECREATED_INDEXES = new Set([
  'idx_auth_sessions_user_active',
  'idx_auth_sessions_expiry',
  'idx_approval_status',
  'idx_approval_user',
  'idx_approval_group',
  'idx_captcha_user',
  'idx_blacklist_user',
  'idx_blacklist_group',
  'idx_punishment_user',
  'idx_punishment_group',
  'idx_audit_action',
  'idx_audit_actor',
  'idx_audit_time',
]);

const IDENTIFIER_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  users: ['qq_id'],
  approval_records: ['group_id', 'user_id', 'operator_id'],
  captcha_sessions: ['group_id', 'user_id'],
  blacklist: ['user_id', 'group_id', 'created_by'],
  punishment_records: ['group_id', 'user_id', 'operator_id', 'revoked_by'],
  audit_logs: ['actor_id'],
  stat_snapshots: ['group_id'],
};

// Older releases used core.selfId = 0 while login discovery was unavailable.
// Automated actions could persist that sentinel in actor columns. Zero is not
// a valid OneBot account identifier, so v5 canonicalizes it to the existing
// nullable "system/unknown actor" representation instead of retaining an
// ambiguous identifier or rejecting the whole installation.
const LEGACY_SYSTEM_ACTOR_COLUMNS = new Set([
  'approval_records.operator_id',
  'blacklist.created_by',
  'punishment_records.operator_id',
  'punishment_records.revoked_by',
  'audit_logs.actor_id',
]);

const REBUILT_AUTOINCREMENT_TABLES = [
  'users',
  'approval_records',
  'blacklist',
  'punishment_records',
  'audit_logs',
  'stat_snapshots',
] as const;

function quoted(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function invalidIdentifierSql(column: string, allowLegacySystemActor = false): string {
  const name = quoted(column);
  return `${name} IS NOT NULL AND (
    typeof(${name}) NOT IN ('integer', 'text')
    OR CAST(${name} AS TEXT) = ''
    ${allowLegacySystemActor ? '' : `OR CAST(${name} AS TEXT) = '0'`}
    OR CAST(${name} AS TEXT) GLOB '*[^0-9]*'
    OR (length(CAST(${name} AS TEXT)) > 1 AND substr(CAST(${name} AS TEXT), 1, 1) = '0')
    OR length(CAST(${name} AS TEXT)) > 20
    OR (length(CAST(${name} AS TEXT)) = 20 AND CAST(${name} AS TEXT) > '18446744073709551615')
  )`;
}

function textIdCheck(column: string, nullable = false): string {
  const name = quoted(column);
  const exact = `typeof(${name}) = 'text'
    AND ${name} <> ''
    AND ${name} <> '0'
    AND ${name} NOT GLOB '*[^0-9]*'
    AND (length(${name}) = 1 OR substr(${name}, 1, 1) <> '0')
    AND (length(${name}) < 20 OR (length(${name}) = 20 AND ${name} <= '18446744073709551615'))`;
  return `CHECK (${nullable ? `${name} IS NULL OR (` : ''}${exact}${nullable ? ')' : ''})`;
}

function assertSourceIdentifiers(db: DatabaseSync): void {
  for (const [table, columns] of Object.entries(IDENTIFIER_COLUMNS)) {
    for (const column of columns) {
      const allowLegacySystemActor = LEGACY_SYSTEM_ACTOR_COLUMNS.has(`${table}.${column}`);
      const invalid = db.prepare(
        `SELECT rowid FROM ${quoted(table)} WHERE ${invalidIdentifierSql(column, allowLegacySystemActor)} LIMIT 1`
      ).get() as { rowid: number } | undefined;
      if (invalid) {
        throw new Error(`Cannot canonicalize ${table}.${column}: row ${invalid.rowid} is not a positive unsigned 64-bit decimal identifier`);
      }
    }
  }
}

function assertNoUnknownDependentObjects(db: DatabaseSync): void {
  const placeholders = REBUILT_TABLES.map(() => '?').join(', ');
  const objects = db.prepare(`
    SELECT type, name, tbl_name
    FROM sqlite_master
    WHERE tbl_name IN (${placeholders})
      AND (type = 'trigger' OR (type = 'index' AND name NOT LIKE 'sqlite_autoindex%'))
  `).all(...REBUILT_TABLES) as Array<{ type: string; name: string; tbl_name: string }>;
  const unknown = objects.filter((object) => object.type !== 'index' || !RECREATED_INDEXES.has(object.name));
  if (unknown.length > 0) {
    throw new Error(
      `Cannot safely rebuild tables with custom dependent objects: ${unknown
        .map((object) => `${object.type}:${object.tbl_name}:${object.name}`)
        .join(', ')}`
    );
  }
}

/**
 * Runs inside the existing shadow-database transaction. The active database
 * is replaced only after row-count, integrity, foreign-key, and schema checks
 * pass; the verified pre-migration snapshot remains available for rollback.
 */
export function up(db: DatabaseSync): void {
  assertNoUnknownDependentObjects(db);
  assertSourceIdentifiers(db);
  const sequences = db.prepare(`
    SELECT name, CAST(seq AS TEXT) AS seq
    FROM sqlite_sequence
    WHERE name IN (${REBUILT_AUTOINCREMENT_TABLES.map(() => '?').join(', ')})
  `).all(...REBUILT_AUTOINCREMENT_TABLES) as Array<{ name: string; seq: string }>;

  db.exec(`
    CREATE TABLE users_v5 (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      qq_id          TEXT UNIQUE ${textIdCheck('qq_id', true)},
      username       TEXT UNIQUE,
      password_hash  TEXT,
      role           TEXT NOT NULL DEFAULT 'member',
      login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until   INTEGER,
      last_login     INTEGER,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    INSERT INTO users_v5 (
      id, qq_id, username, password_hash, role, login_attempts,
      locked_until, last_login, created_at, updated_at
    )
    SELECT
      id, CASE WHEN qq_id IS NULL THEN NULL ELSE CAST(qq_id AS TEXT) END,
      username, password_hash, role, login_attempts,
      locked_until, last_login, created_at, updated_at
    FROM users;

    CREATE TABLE auth_sessions_v5 (
      token_id   TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users_v5(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
      issued_at  INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    INSERT INTO auth_sessions_v5
      SELECT token_id, user_id, kind, issued_at, expires_at, revoked_at FROM auth_sessions;

    CREATE TABLE approval_records_v5 (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id     TEXT NOT NULL ${textIdCheck('group_id')},
      user_id      TEXT NOT NULL ${textIdCheck('user_id')},
      flag         TEXT NOT NULL,
      comment      TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'pending',
      reason       TEXT,
      operator_id  TEXT ${textIdCheck('operator_id', true)},
      captcha_id   TEXT,
      created_at   INTEGER NOT NULL,
      processed_at INTEGER,
      expires_at   INTEGER NOT NULL
    );
    INSERT INTO approval_records_v5
    SELECT id, CAST(group_id AS TEXT), CAST(user_id AS TEXT), flag, comment, status, reason,
      CASE WHEN operator_id IS NULL OR CAST(operator_id AS TEXT) = '0' THEN NULL ELSE CAST(operator_id AS TEXT) END,
      captcha_id, created_at, processed_at, expires_at
    FROM approval_records;

    CREATE TABLE captcha_sessions_v5 (
      id           TEXT PRIMARY KEY,
      group_id     TEXT NOT NULL ${textIdCheck('group_id')},
      user_id      TEXT NOT NULL ${textIdCheck('user_id')},
      approval_id  INTEGER NOT NULL,
      type         TEXT NOT NULL,
      challenge    TEXT NOT NULL,
      answer       TEXT NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      solved       INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO captcha_sessions_v5
    SELECT id, CAST(group_id AS TEXT), CAST(user_id AS TEXT), approval_id, type, challenge,
      answer, attempts, max_attempts, created_at, expires_at, solved
    FROM captcha_sessions;

    CREATE TABLE blacklist_v5 (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL ${textIdCheck('user_id')},
      group_id   TEXT ${textIdCheck('group_id', true)},
      reason     TEXT NOT NULL DEFAULT '',
      created_by TEXT ${textIdCheck('created_by', true)},
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      UNIQUE(user_id, group_id)
    );
    INSERT INTO blacklist_v5
    SELECT id, CAST(user_id AS TEXT), CASE WHEN group_id IS NULL THEN NULL ELSE CAST(group_id AS TEXT) END,
      reason, CASE WHEN CAST(created_by AS TEXT) = '0' THEN NULL ELSE CAST(created_by AS TEXT) END,
      created_at, expires_at
    FROM blacklist;

    CREATE TABLE punishment_records_v5 (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id         TEXT NOT NULL ${textIdCheck('group_id')},
      user_id          TEXT NOT NULL ${textIdCheck('user_id')},
      type             TEXT NOT NULL,
      duration_seconds INTEGER,
      reason           TEXT NOT NULL DEFAULT '',
      operator_id      TEXT ${textIdCheck('operator_id', true)},
      created_at       INTEGER NOT NULL,
      expires_at       INTEGER,
      revoked_at       INTEGER,
      revoked_by       TEXT ${textIdCheck('revoked_by', true)}
    );
    INSERT INTO punishment_records_v5
    SELECT id, CAST(group_id AS TEXT), CAST(user_id AS TEXT), type, duration_seconds, reason,
      CASE WHEN CAST(operator_id AS TEXT) = '0' THEN NULL ELSE CAST(operator_id AS TEXT) END,
      created_at, expires_at, revoked_at,
      CASE WHEN revoked_by IS NULL OR CAST(revoked_by AS TEXT) = '0' THEN NULL ELSE CAST(revoked_by AS TEXT) END
    FROM punishment_records;

    CREATE TABLE audit_logs_v5 (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action      TEXT NOT NULL,
      actor_id    TEXT ${textIdCheck('actor_id', true)},
      target_type TEXT,
      target_id   TEXT,
      details     TEXT NOT NULL DEFAULT '{}',
      ip          TEXT,
      created_at  INTEGER NOT NULL
    );
    INSERT INTO audit_logs_v5
    SELECT id, action,
      CASE WHEN actor_id IS NULL OR CAST(actor_id AS TEXT) = '0' THEN NULL ELSE CAST(actor_id AS TEXT) END,
      target_type, target_id, details, ip, created_at
    FROM audit_logs;

    CREATE TABLE stat_snapshots_v5 (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id            TEXT ${textIdCheck('group_id', true)},
      period              TEXT NOT NULL,
      approvals_total     INTEGER NOT NULL DEFAULT 0,
      approvals_passed    INTEGER NOT NULL DEFAULT 0,
      approvals_rejected  INTEGER NOT NULL DEFAULT 0,
      captchas_total      INTEGER NOT NULL DEFAULT 0,
      captchas_passed     INTEGER NOT NULL DEFAULT 0,
      punishments_total   INTEGER NOT NULL DEFAULT 0,
      risk_detections     INTEGER NOT NULL DEFAULT 0,
      created_at          INTEGER NOT NULL,
      UNIQUE(group_id, period)
    );
    INSERT INTO stat_snapshots_v5
    SELECT id, CASE WHEN group_id IS NULL THEN NULL ELSE CAST(group_id AS TEXT) END, period,
      approvals_total, approvals_passed, approvals_rejected, captchas_total,
      captchas_passed, punishments_total, risk_detections, created_at
    FROM stat_snapshots;

    DROP TABLE auth_sessions;
    DROP TABLE users;
    DROP TABLE approval_records;
    DROP TABLE captcha_sessions;
    DROP TABLE blacklist;
    DROP TABLE punishment_records;
    DROP TABLE audit_logs;
    DROP TABLE stat_snapshots;

    ALTER TABLE users_v5 RENAME TO users;
    ALTER TABLE auth_sessions_v5 RENAME TO auth_sessions;
    ALTER TABLE approval_records_v5 RENAME TO approval_records;
    ALTER TABLE captcha_sessions_v5 RENAME TO captcha_sessions;
    ALTER TABLE blacklist_v5 RENAME TO blacklist;
    ALTER TABLE punishment_records_v5 RENAME TO punishment_records;
    ALTER TABLE audit_logs_v5 RENAME TO audit_logs;
    ALTER TABLE stat_snapshots_v5 RENAME TO stat_snapshots;

    CREATE INDEX idx_auth_sessions_user_active ON auth_sessions(user_id, revoked_at);
    CREATE INDEX idx_auth_sessions_expiry ON auth_sessions(expires_at);
    CREATE INDEX idx_approval_status ON approval_records(status);
    CREATE INDEX idx_approval_user ON approval_records(user_id);
    CREATE INDEX idx_approval_group ON approval_records(group_id);
    CREATE INDEX idx_captcha_user ON captcha_sessions(user_id, solved);
    CREATE INDEX idx_blacklist_user ON blacklist(user_id);
    CREATE INDEX idx_blacklist_group ON blacklist(group_id);
    CREATE INDEX idx_punishment_user ON punishment_records(user_id);
    CREATE INDEX idx_punishment_group ON punishment_records(group_id);
    CREATE INDEX idx_audit_action ON audit_logs(action);
    CREATE INDEX idx_audit_actor ON audit_logs(actor_id);
    CREATE INDEX idx_audit_time ON audit_logs(created_at);
  `);

  // Copying only surviving rows into rebuilt AUTOINCREMENT tables would lower
  // SQLite's high-water mark after the previously highest row was deleted.
  // Restore the original sequence exactly so retained foreign/audit references
  // can never be made to appear associated with a newly reused local row ID.
  for (const { name, seq } of sequences) {
    const updated = db.prepare('UPDATE sqlite_sequence SET seq = CAST(? AS INTEGER) WHERE name = ?')
      .run(seq, name);
    if (Number(updated.changes) === 0) {
      db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, CAST(? AS INTEGER))')
        .run(name, seq);
    }
  }
}
