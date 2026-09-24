import { DatabaseSync } from 'node:sqlite';

export const version = 4;
export const description = 'Replace retired score/TOTP storage and add durable auth sessions';

/**
 * This runs only inside the database migration transaction. During a legacy
 * upgrade it is applied to a shadow database; the live database is replaced
 * only after the complete shadow candidate has passed validation.
 */
export function up(db: DatabaseSync): void {
  const dependentObjects = db.prepare(`
    SELECT type, name, tbl_name
    FROM sqlite_master
    WHERE tbl_name IN ('users', 'risk_rules')
      AND ((type = 'trigger') OR (type = 'index' AND name NOT LIKE 'sqlite_autoindex%'))
  `).all() as Array<{ type: string; name: string; tbl_name: string }>;
  if (dependentObjects.length > 0) {
    throw new Error(
      `Cannot safely rebuild tables with custom dependent objects: ${dependentObjects
        .map((object) => `${object.type}:${object.tbl_name}:${object.name}`)
        .join(', ')}`
    );
  }

  db.exec(`
    CREATE TABLE users_v4 (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      qq_id          INTEGER UNIQUE,
      username       TEXT UNIQUE,
      password_hash  TEXT,
      role           TEXT NOT NULL DEFAULT 'member',
      login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until   INTEGER,
      last_login     INTEGER,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );

    INSERT INTO users_v4 (
      id, qq_id, username, password_hash, role, login_attempts,
      locked_until, last_login, created_at, updated_at
    )
    SELECT
      id, qq_id, username, password_hash, role, login_attempts,
      locked_until, last_login, created_at, updated_at
    FROM users;

    DROP TABLE users;
    ALTER TABLE users_v4 RENAME TO users;

    CREATE TABLE risk_rules_v4 (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      pattern    TEXT NOT NULL,
      action     TEXT NOT NULL CHECK (action IN ('mute', 'kick', 'notify_admin', 'log_only', 'off')),
      enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    INSERT INTO risk_rules_v4 (id, name, pattern, action, enabled, created_at, updated_at)
    SELECT id, name, pattern, action, enabled, created_at, updated_at
    FROM risk_rules;

    DROP TABLE risk_rules;
    ALTER TABLE risk_rules_v4 RENAME TO risk_rules;

    CREATE INDEX IF NOT EXISTS idx_risk_rules_enabled ON risk_rules(enabled);

    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_id   TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
      issued_at  INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
      ON auth_sessions(user_id, revoked_at);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
      ON auth_sessions(expires_at);
  `);
}
