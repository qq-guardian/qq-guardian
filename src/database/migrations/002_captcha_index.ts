import { DatabaseSync } from 'node:sqlite';

export const version     = 2;
export const description = 'Add index on captcha_sessions(user_id, solved)';

export function up(db: DatabaseSync): void {
  // The hot path in handlePrivateMessage queries:
  //   WHERE user_id = ? AND solved = 0 AND expires_at > ?
  // Without an index this is a full table scan on every private message from
  // a user currently under captcha challenge.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_captcha_user
    ON captcha_sessions(user_id, solved);
  `);
}

