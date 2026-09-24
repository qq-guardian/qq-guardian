import { DatabaseSync } from 'node:sqlite';
import { assertSafeRegularExpression } from '../core/config/schema.ts';
import { probePatternsInWorkers } from '../core/regex/index.ts';
import { DATABASE_SCHEMA_VERSION } from './migrations/index.ts';

export const OPERATIONAL_TABLES = [
  'users',
  'approval_records',
  'captcha_sessions',
  'blacklist',
  'punishment_records',
  'audit_logs',
  'login_logs',
  'stat_snapshots',
  'risk_rules',
  'auth_sessions',
  'login_rate_limits',
] as const;

const REQUIRED_TABLES = [...OPERATIONAL_TABLES, 'schema_migrations'] as const;
const RISK_ACTIONS = new Set(['mute', 'kick', 'notify_admin', 'log_only', 'off']);
const ONEBOT_ID_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  users: ['qq_id'],
  approval_records: ['group_id', 'user_id', 'operator_id'],
  captcha_sessions: ['group_id', 'user_id'],
  blacklist: ['user_id', 'group_id', 'created_by'],
  punishment_records: ['group_id', 'user_id', 'operator_id', 'revoked_by'],
  audit_logs: ['actor_id'],
  stat_snapshots: ['group_id'],
};

export interface DatabaseValidationReport {
  schemaVersion: number;
  rowCounts: Record<string, number>;
}

export class DatabaseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseValidationError';
  }
}

function tableNames(db: DatabaseSync): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name)
  );
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)
  );
}

function tableColumnTypes(db: DatabaseSync, table: string): Map<string, string> {
  return new Map(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>)
      .map((row) => [row.name, row.type.toUpperCase()])
  );
}

/** Retired columns are reported in the immutable backup manifest before rebuild. */
export function detectRetiredDatabaseFields(db: DatabaseSync): string[] {
  const tables = tableNames(db);
  const retired: string[] = [];
  if (tables.has('users')) {
    const columns = tableColumns(db, 'users');
    for (const column of ['totp_secret', 'totp_enabled']) {
      if (columns.has(column)) retired.push(`users.${column}`);
    }
  }
  if (tables.has('risk_rules')) {
    const columns = tableColumns(db, 'risk_rules');
    for (const column of ['type', 'weight']) {
      if (columns.has(column)) retired.push(`risk_rules.${column}`);
    }
  }
  return retired;
}

function countRows(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function requireColumns(db: DatabaseSync, table: string, columns: readonly string[]): void {
  const actual = tableColumns(db, table);
  for (const column of columns) {
    if (!actual.has(column)) {
      throw new DatabaseValidationError(`${table} is missing required column ${column}`);
    }
  }
}

function validateIdentifierColumns(db: DatabaseSync): void {
  for (const [table, columns] of Object.entries(ONEBOT_ID_COLUMNS)) {
    const types = tableColumnTypes(db, table);
    for (const column of columns) {
      if (types.get(column) !== 'TEXT') {
        throw new DatabaseValidationError(`${table}.${column} must use TEXT affinity`);
      }
      const invalid = db.prepare(`
        SELECT rowid FROM ${table}
        WHERE ${column} IS NOT NULL AND (
          typeof(${column}) <> 'text'
          OR ${column} = ''
          OR ${column} = '0'
          OR ${column} GLOB '*[^0-9]*'
          OR (length(${column}) > 1 AND substr(${column}, 1, 1) = '0')
          OR length(${column}) > 20
          OR (length(${column}) = 20 AND ${column} > '18446744073709551615')
        )
        LIMIT 1
      `).get() as { rowid: number } | undefined;
      if (invalid) {
        throw new DatabaseValidationError(`${table}.${column} contains a non-canonical identifier at row ${invalid.rowid}`);
      }
    }
  }
}

export function getDatabaseSchemaVersion(db: DatabaseSync): number {
  if (!tableNames(db).has('schema_migrations')) return 0;
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
  return row.version ?? 0;
}

/** Captures only tables whose counts have a direct preservation invariant. */
export function captureOperationalRowCounts(db: DatabaseSync): Record<string, number> {
  const present = tableNames(db);
  return Object.fromEntries(
    OPERATIONAL_TABLES
      .filter((table) => present.has(table))
      .map((table) => [table, countRows(db, table)])
  );
}

export function assertRowCountsPreserved(
  source: Record<string, number>,
  candidate: Record<string, number>
): void {
  for (const [table, count] of Object.entries(source)) {
    if (candidate[table] !== count) {
      throw new DatabaseValidationError(
        `${table} row count changed during migration (${count} -> ${candidate[table] ?? 'missing'})`
      );
    }
  }
}

export async function validateDatabase(db: DatabaseSync): Promise<DatabaseValidationReport> {
  const integrity = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
    throw new DatabaseValidationError(`integrity_check failed: ${JSON.stringify(integrity)}`);
  }

  const foreignKeyViolations = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeyViolations.length > 0) {
    throw new DatabaseValidationError(`foreign_key_check failed: ${JSON.stringify(foreignKeyViolations)}`);
  }

  const tables = tableNames(db);
  for (const table of REQUIRED_TABLES) {
    if (!tables.has(table)) throw new DatabaseValidationError(`missing required table ${table}`);
  }

  const schemaVersion = getDatabaseSchemaVersion(db);
  if (schemaVersion !== DATABASE_SCHEMA_VERSION) {
    throw new DatabaseValidationError(
      `schema version ${schemaVersion} does not match ${DATABASE_SCHEMA_VERSION}`
    );
  }

  requireColumns(db, 'users', [
    'id', 'qq_id', 'username', 'password_hash', 'role', 'login_attempts',
    'locked_until', 'last_login', 'created_at', 'updated_at',
  ]);
  const userColumns = tableColumns(db, 'users');
  for (const retired of ['totp_secret', 'totp_enabled']) {
    if (userColumns.has(retired)) throw new DatabaseValidationError(`users still has retired column ${retired}`);
  }

  requireColumns(db, 'risk_rules', [
    'id', 'name', 'pattern', 'action', 'enabled', 'created_at', 'updated_at',
  ]);
  const riskColumns = tableColumns(db, 'risk_rules');
  for (const retired of ['type', 'weight']) {
    if (riskColumns.has(retired)) throw new DatabaseValidationError(`risk_rules still has retired column ${retired}`);
  }
  requireColumns(db, 'auth_sessions', [
    'token_id', 'user_id', 'kind', 'issued_at', 'expires_at', 'revoked_at',
  ]);
  requireColumns(db, 'login_rate_limits', [
    'scope', 'bucket_key', 'attempts', 'reset_at', 'updated_at',
  ]);
  validateIdentifierColumns(db);

  const rules = db.prepare('SELECT id, pattern, action, enabled FROM risk_rules').all() as Array<{
    id: number;
    pattern: string;
    action: string;
    enabled: number;
  }>;
  for (const rule of rules) {
    if (typeof rule.pattern !== 'string' || typeof rule.action !== 'string') {
      throw new DatabaseValidationError(`risk_rules row ${rule.id} has invalid pattern/action`);
    }
    assertSafeRegularExpression(rule.pattern, `risk_rules[${rule.id}].pattern`);
    if (!RISK_ACTIONS.has(rule.action)) {
      throw new DatabaseValidationError(`risk_rules row ${rule.id} has unsupported action ${rule.action}`);
    }
    if (rule.enabled !== 0 && rule.enabled !== 1) {
      throw new DatabaseValidationError(`risk_rules row ${rule.id} has invalid enabled state`);
    }
  }

  const verdicts = await probePatternsInWorkers(rules.map((rule) => rule.pattern));
  for (const rule of rules) {
    if (!verdicts.get(rule.pattern)) {
      throw new DatabaseValidationError(`risk_rules row ${rule.id} failed performance test (possible ReDoS)`);
    }
  }

  return { schemaVersion, rowCounts: captureOperationalRowCounts(db) };
}
