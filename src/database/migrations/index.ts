import { DatabaseSync } from 'node:sqlite';
import * as m001 from './001_initial.ts';
import * as m002 from './002_captcha_index.ts';
import * as m003 from './003_risk_rule_action.ts';
import * as m004 from './004_canonical_storage.ts';
import * as m005 from './005_onebot_identifiers.ts';
import * as m006 from './006_login_rate_limits.ts';
import { getLogger } from '../../core/logger/index.ts';

interface Migration {
  version: number;
  description: string;
  up: (db: DatabaseSync) => void;
}

export const DATABASE_SCHEMA_VERSION = 6;
const MIGRATIONS: Migration[] = [m001, m002, m003, m004, m005, m006];

export function runMigrations(db: DatabaseSync): void {
  const log = getLogger().child({ module: 'migrations' });

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as unknown as Array<{version:number}>)
      .map((r) => r.version)
  );

  const pending = MIGRATIONS.filter(m => !applied.has(m.version));
  if (pending.length === 0) { log.info('Schema up to date'); return; }

  for (const migration of pending) {
    log.info({ version: migration.version }, `Applying: ${migration.description}`);
    db.exec('BEGIN');
    try {
      migration.up(db);
      db.prepare(
        'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)'
      ).run(migration.version, Date.now());
      db.exec('COMMIT');
      log.info({ version: migration.version }, 'Applied OK');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
