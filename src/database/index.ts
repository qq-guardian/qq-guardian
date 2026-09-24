/**
 * Database layer using node:sqlite (Node.js 22.5+ built-in).
 * Zero native addon dependencies — no node-gyp required.
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { runMigrations } from './migrations/index.ts';
import { getLogger } from '../core/logger/index.ts';

export const DATABASE_FILENAME = 'qqadmin.db';
let _db: DatabaseSync | null = null;
let _generation = 0;

export function getDatabasePath(dataDir: string): string {
  return join(dataDir, DATABASE_FILENAME);
}

/** Opens a non-singleton connection for staging, validation, or recovery. */
export function openDatabaseFile(databasePath: string, readOnly = false): DatabaseSync {
  const db = new DatabaseSync(databasePath, { readOnly, timeout: 5000 });
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (!readOnly) db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

export function openDatabase(dataDir: string): DatabaseSync {
  if (_db) return _db;

  mkdirSync(dataDir, { recursive: true });
  const dbPath = getDatabasePath(dataDir);

  _db = openDatabaseFile(dbPath);
  _db.exec('PRAGMA journal_mode = WAL');

  runMigrations(_db);
  _generation += 1;
  getLogger().info({ path: dbPath }, 'Database opened (node:sqlite)');
  return _db;
}

export function getDatabase(): DatabaseSync {
  if (!_db) throw new Error('Database not initialized. Call openDatabase() first.');
  return _db;
}

/** Changes whenever the process opens a new singleton connection. Repository
 * caches use it to avoid carrying facts about a closed/replaced database into
 * a later lifecycle generation. */
export function getDatabaseGeneration(): number {
  return _generation;
}

export function closeDatabase(): void {
  if (_db) { _db.close(); _db = null; }
}
