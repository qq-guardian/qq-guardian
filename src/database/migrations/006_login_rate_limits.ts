import { DatabaseSync } from 'node:sqlite';

export const version = 6;
export const description = 'Persist login rate-limit buckets and audit account locks';

export function up(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_rate_limits (
      scope      TEXT NOT NULL,
      bucket_key TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      reset_at   INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, bucket_key)
    );

    CREATE INDEX IF NOT EXISTS idx_login_rate_limits_reset
      ON login_rate_limits(reset_at);

    CREATE TRIGGER IF NOT EXISTS trg_users_account_locked_audit
    AFTER UPDATE OF locked_until ON users
    WHEN NEW.locked_until IS NOT NULL
      AND (OLD.locked_until IS NULL OR NEW.locked_until > OLD.locked_until)
    BEGIN
      INSERT INTO audit_logs (
        action, actor_id, target_type, target_id, details, created_at
      ) VALUES (
        'account_locked',
        NULL,
        'user',
        CAST(NEW.id AS TEXT),
        '{}',
        CAST(strftime('%s', 'now') AS INTEGER) * 1000
      );
    END;
  `);
}
