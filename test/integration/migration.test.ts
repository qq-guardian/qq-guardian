import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as m001 from '../../src/database/migrations/001_initial.ts';
import * as m002 from '../../src/database/migrations/002_captcha_index.ts';
import * as m003 from '../../src/database/migrations/003_risk_rule_action.ts';
import * as m004 from '../../src/database/migrations/004_canonical_storage.ts';
import { runMigrations } from '../../src/database/migrations/index.ts';
import { buildDefaults } from '../../src/core/config/defaults.ts';
import { resolveNapCatConfigDir } from '../../src/adapters/napcat/runtime-host.ts';
import { describeArtifact, sha256File } from '../../src/migration/files.ts';
import {
  recoverGuardianShadowMigration,
  runGuardianShadowMigration,
} from '../../src/migration/index.ts';

const testRoots: string[] = [];

afterEach(() => {
  while (testRoots.length > 0) rmSync(testRoots.pop()!, { recursive: true, force: true });
});

function createLegacyInstallation(): { root: string; configDir: string; dataDir: string; configPath: string; databasePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'guardian-migration-'));
  testRoots.push(root);
  const configDir = join(root, 'config');
  const dataDir = join(root, 'data');
  const configPath = join(configDir, 'config.json');
  const databasePath = join(dataDir, 'qqadmin.db');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const config = buildDefaults();
  // Deliberately retain the pre-v5 numeric shape in this legacy fixture.
  config.core.selfId = 123456 as never;
  config.core.superAdmins = [123456, 654321] as never;
  config.approval.groups['987654'] = {
    enabled: true,
    action: 'captcha',
    approveKeywords: ['invite'],
    rejectKeywords: ['spam'],
    approvePatterns: ['^trusted-\\d+$'],
    rejectPatterns: ['^bad$'],
    rejectReason: 'manual review required',
    riskEnabled: true,
    autoKickBlacklisted: true,
    notifyOnRisk: true,
    notifyOnJoin: true,
    groupName: 'Migration group',
    welcomeEnabled: true,
    welcomeTemplate: 'welcome {user}',
    curfewEnabled: true,
    curfewStart: '23:30',
    curfewEnd: '06:30',
  };
  const legacyRisk = config.risk as unknown as Record<string, unknown>;
  delete legacyRisk.detectorActions;
  legacyRisk.action = 'kick';
  legacyRisk.threshold = 70;
  legacyRisk.severeThreshold = 90;
  legacyRisk.weights = { advertising: 30 };
  legacyRisk.detectors = { advertising: true, fraud: false, cardMessage: false };
  const legacyConfig = config as unknown as Record<string, unknown>;
  legacyConfig.providerMetadata = {
    vendor: 'SnowLuma',
    transportCapabilities: ['forward-ws', 'reverse-ws'],
  };
  (config.captcha as unknown as Record<string, unknown>).providerOptions = {
    challengeLocale: 'en-US',
  };
  (config.approval.groups['987654'] as unknown as Record<string, unknown>).providerPolicy = {
    eventMode: 'ordered',
  };
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    config,
    deploymentMetadata: { source: 'operator-import' },
  }, null, 2));
  writeFileSync(join(dataDir, 'credentials.txt'), 'legacy-bootstrap-secret\n');

  const db = new DatabaseSync(databasePath);
  m001.up(db);
  m002.up(db);
  m003.up(db);
  db.exec('PRAGMA journal_mode = WAL');
  for (const version of [1, 2, 3]) {
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, 1);
  }
  db.prepare(`
    INSERT INTO users (
      qq_id, username, password_hash, role, totp_secret, totp_enabled,
      login_attempts, locked_until, last_login, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(123456, 'admin', 'legacy-hash', 'super_admin', 'retired-secret', 1, 2, null, 3, 1, 4);
  db.prepare(`
    INSERT INTO approval_records (group_id, user_id, flag, comment, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(987654, 111, 'request-1', 'invite', 'pending', 1, 9_999_999);
  db.prepare(`
    INSERT INTO captcha_sessions (
      id, group_id, user_id, approval_id, type, challenge, answer,
      attempts, max_attempts, created_at, expires_at, solved
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('captcha-1', 987654, 111, 1, 'question', 'q', 'a', 1, 3, 1, 9_999_999, 0);
  db.prepare(`
    INSERT INTO blacklist (user_id, group_id, reason, created_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(222, null, 'legacy blacklist', 123456, 1, null);
  db.prepare(`
    INSERT INTO punishment_records (
      group_id, user_id, type, duration_seconds, reason, operator_id, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(987654, 333, 'mute', 60, 'legacy punishment', 123456, 1, 61);
  db.prepare(`
    INSERT INTO audit_logs (action, actor_id, target_type, target_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('legacy.action', 123456, 'user', '333', '{"source":"legacy"}', 1);
  db.prepare(`INSERT INTO login_logs (user_id, ip, user_agent, success, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(1, '127.0.0.1', 'test', 1, 1);
  db.prepare(`INSERT INTO stat_snapshots (group_id, period, approvals_total, created_at) VALUES (?, ?, ?, ?)`)
    .run(987654, '2026-08-11', 7, 1);
  db.prepare(`
    INSERT INTO risk_rules (name, type, pattern, weight, action, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('legacy rule', 'regex', '^legacy$', 2.5, 'kick', 1, 1, 1);
  // SQLite can preserve signed 64-bit integer literals exactly even though
  // JavaScript Number cannot. These values prove the v5 rebuild casts the
  // database's original digits directly to TEXT without a JS round trip.
  db.exec(`
    UPDATE users
    SET qq_id = 9007199254740993;
    UPDATE approval_records
    SET group_id = 9223372036854775807,
        user_id = 9007199254740993,
        operator_id = 9007199254740994;
    UPDATE captcha_sessions
    SET group_id = 9223372036854775807,
        user_id = 9007199254740993;
    UPDATE blacklist
    SET user_id = 9007199254740994,
        group_id = 9223372036854775807,
        created_by = 9007199254740995;
    UPDATE punishment_records
    SET group_id = 9223372036854775807,
        user_id = 9007199254740993,
        operator_id = 9007199254740995;
    UPDATE audit_logs
    SET actor_id = 9007199254740995,
        target_id = '9007199254740993';
    UPDATE stat_snapshots
    SET group_id = 9223372036854775807;
  `);
  db.close();
  return { root, configDir, dataDir, configPath, databasePath };
}

function rowCount(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function plainRow(db: DatabaseSync, sql: string): Record<string, unknown> {
  return { ...(db.prepare(sql).get() as Record<string, unknown>) };
}

async function createCompletedV5Installation(options: { proveV5?: boolean } = {}): Promise<{
  installation: ReturnType<typeof createLegacyInstallation>;
  journalId: string;
}> {
  const installation = createLegacyInstallation();
  await runGuardianShadowMigration({
    configDir: installation.configDir,
    dataDir: installation.dataDir,
  });

  const config = JSON.parse(readFileSync(installation.configPath, 'utf8')) as {
    schemaVersion: number;
  };
  config.schemaVersion = 5;
  writeFileSync(installation.configPath, `${JSON.stringify(config, null, 2)}\n`);

  const journalPath = join(installation.dataDir, 'migration-state.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    id: string;
    createdAt: string;
    paths: { backupDir: string };
    candidate: { config: { sha256: string; bytes: number } };
  };
  const activeConfig = describeArtifact(installation.configPath);
  journal.candidate.config.sha256 = activeConfig.sha256;
  journal.candidate.config.bytes = activeConfig.bytes;
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  if (options.proveV5 !== false) {
    const manifestPath = join(journal.paths.backupDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      target: { configSchemaVersion: number };
      validation: { configSchemaVersion: number };
    };
    manifest.target.configSchemaVersion = 5;
    manifest.validation.configSchemaVersion = 5;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return { installation, journalId: journal.id };
}

describe('shadow migration', () => {
  it('opens a current NapCat pre-existing config file in place without creating config.json/config.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-napcat-config-'));
    testRoots.push(root);
    const dataDir = join(root, 'data');
    const configPath = join(dataDir, 'config.json');
    mkdirSync(dataDir, { recursive: true });
    const config = buildDefaults();
    config.approval.groups['900001'] = {
      enabled: true,
      action: 'manual',
      approveKeywords: ['preserve-me'],
      rejectKeywords: [],
      approvePatterns: [],
      rejectPatterns: [],
      rejectReason: 'manual review required',
      riskEnabled: true,
      autoKickBlacklisted: true,
      notifyOnRisk: true,
      notifyOnJoin: true,
      groupName: 'Existing NapCat group',
      welcomeEnabled: false,
      welcomeTemplate: 'welcome {user}',
      curfewEnabled: false,
      curfewStart: '23:00',
      curfewEnd: '07:00',
    };
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 3, config }, null, 2));

    const configDir = resolveNapCatConfigDir(configPath);
    await runGuardianShadowMigration({ configDir, dataDir });

    const active = JSON.parse(readFileSync(configPath, 'utf8')) as {
      config: { approval: { groups: Record<string, { approveKeywords: string[] }> } };
    };
    assert.deepEqual(active.config.approval.groups['900001'].approveKeywords, ['preserve-me']);
    assert.equal(existsSync(join(configPath, 'config.json')), false);
  });

  it('backs up and migrates representative Guardian config and operational SQLite data once', async () => {
    const installation = createLegacyInstallation();
    const result = await runGuardianShadowMigration({
      configDir: installation.configDir,
      dataDir: installation.dataDir,
    });
    assert.equal(result.status, 'migrated');
    assert.ok(result.backupDir);

    const activeConfig = JSON.parse(readFileSync(installation.configPath, 'utf8')) as Record<string, unknown>;
    assert.equal(activeConfig.schemaVersion, 6);
    const extensions = activeConfig.extensions as {
      legacy: Record<string, unknown>;
    };
    assert.deepEqual(extensions.legacy['/deploymentMetadata'], { source: 'operator-import' });
    assert.deepEqual(extensions.legacy['/config/providerMetadata'], {
      vendor: 'SnowLuma',
      transportCapabilities: ['forward-ws', 'reverse-ws'],
    });
    assert.deepEqual(extensions.legacy['/config/captcha/providerOptions'], {
      challengeLocale: 'en-US',
    });
    assert.deepEqual(extensions.legacy['/config/approval/groups/987654/providerPolicy'], {
      eventMode: 'ordered',
    });
    const config = activeConfig.config as {
      core: { selfId: string; superAdmins: string[] };
      approval: { groups: Record<string, { action: string; approvePatterns: string[] }> };
      risk: { detectorActions: Record<string, string> };
    };
    assert.equal(config.core.selfId, '123456');
    assert.deepEqual(config.core.superAdmins, ['123456', '654321']);
    assert.equal(config.approval.groups['987654'].action, 'captcha');
    assert.deepEqual(config.approval.groups['987654'].approvePatterns, ['^trusted-\\d+$']);
    assert.equal(config.risk.detectorActions.advertising, 'kick');
    assert.equal(config.risk.detectorActions.fraud, 'off');

    const db = new DatabaseSync(installation.databasePath, { readOnly: true });
    assert.equal(rowCount(db, 'users'), 1);
    assert.equal(rowCount(db, 'approval_records'), 1);
    assert.equal(rowCount(db, 'captcha_sessions'), 1);
    assert.equal(rowCount(db, 'blacklist'), 1);
    assert.equal(rowCount(db, 'punishment_records'), 1);
    assert.equal(rowCount(db, 'audit_logs'), 1);
    assert.equal(rowCount(db, 'login_logs'), 1);
    assert.equal(rowCount(db, 'stat_snapshots'), 1);
    assert.equal(rowCount(db, 'risk_rules'), 1);
    assert.deepEqual(
      plainRow(db, `
        SELECT qq_id, username, password_hash, role, typeof(qq_id) AS storage_type
        FROM users
      `),
      {
        qq_id: '9007199254740993',
        username: 'admin',
        password_hash: 'legacy-hash',
        role: 'super_admin',
        storage_type: 'text',
      },
    );
    assert.deepEqual(
      plainRow(db, `
        SELECT
          group_id, typeof(group_id) AS group_type,
          user_id, typeof(user_id) AS user_type,
          operator_id, typeof(operator_id) AS operator_type
        FROM approval_records
      `),
      {
        group_id: '9223372036854775807', group_type: 'text',
        user_id: '9007199254740993', user_type: 'text',
        operator_id: '9007199254740994', operator_type: 'text',
      },
    );
    assert.deepEqual(
      plainRow(db, `
        SELECT group_id, user_id,
          typeof(group_id) AS group_type, typeof(user_id) AS user_type
        FROM captcha_sessions
      `),
      {
        group_id: '9223372036854775807',
        user_id: '9007199254740993',
        group_type: 'text',
        user_type: 'text',
      },
    );
    assert.deepEqual(
      plainRow(db, `
        SELECT user_id, group_id, created_by,
          typeof(user_id) AS user_type,
          typeof(group_id) AS group_type,
          typeof(created_by) AS creator_type
        FROM blacklist
      `),
      {
        user_id: '9007199254740994',
        group_id: '9223372036854775807',
        created_by: '9007199254740995',
        user_type: 'text',
        group_type: 'text',
        creator_type: 'text',
      },
    );
    assert.deepEqual(
      plainRow(db, `
        SELECT group_id, user_id, operator_id,
          typeof(group_id) AS group_type,
          typeof(user_id) AS user_type,
          typeof(operator_id) AS operator_type
        FROM punishment_records
      `),
      {
        group_id: '9223372036854775807', group_type: 'text',
        user_id: '9007199254740993', user_type: 'text',
        operator_id: '9007199254740995', operator_type: 'text',
      },
    );
    assert.deepEqual(
      plainRow(db, `
        SELECT actor_id, target_id,
          typeof(actor_id) AS actor_type, typeof(target_id) AS target_type
        FROM audit_logs
      `),
      {
        actor_id: '9007199254740995',
        target_id: '9007199254740993',
        actor_type: 'text',
        target_type: 'text',
      },
    );
    assert.deepEqual(
      plainRow(db, `
        SELECT group_id, typeof(group_id) AS storage_type
        FROM stat_snapshots
      `),
      { group_id: '9223372036854775807', storage_type: 'text' },
    );
    assert.deepEqual(
      (db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((column) => column.name),
      ['id', 'qq_id', 'username', 'password_hash', 'role', 'login_attempts', 'locked_until', 'last_login', 'created_at', 'updated_at']
    );
    assert.deepEqual(
      (db.prepare('PRAGMA table_info(risk_rules)').all() as Array<{ name: string }>).map((column) => column.name),
      ['id', 'name', 'pattern', 'action', 'enabled', 'created_at', 'updated_at']
    );
    assert.equal(rowCount(db, 'auth_sessions'), 0);
    db.close();

    const manifest = JSON.parse(readFileSync(join(result.backupDir!, 'manifest.json'), 'utf8')) as {
      validation: {
        preservedConfigFields: string[];
        retiredConfigFields: string[];
        retiredDatabaseFields: string[];
      };
      source: { credentials: { path: string } | null };
    };
    assert.deepEqual(manifest.validation.preservedConfigFields, [
      '/config/approval/groups/987654/providerPolicy',
      '/config/captcha/providerOptions',
      '/config/providerMetadata',
      '/deploymentMetadata',
    ]);
    assert.deepEqual(manifest.validation.retiredConfigFields.sort(), [
      'config.risk.action',
      'config.risk.detectors',
      'config.risk.severeThreshold',
      'config.risk.threshold',
      'config.risk.weights',
    ]);
    assert.deepEqual(manifest.validation.retiredDatabaseFields.sort(), [
      'risk_rules.type',
      'risk_rules.weight',
      'users.totp_enabled',
      'users.totp_secret',
    ]);
    assert.ok(manifest.source.credentials);
    assert.equal(readFileSync(manifest.source.credentials!.path, 'utf8'), 'legacy-bootstrap-secret\n');

    const sourceConfig = JSON.parse(readFileSync(join(result.backupDir!, 'config.json'), 'utf8')) as {
      schemaVersion: number;
      config: { risk: Record<string, unknown> };
    };
    assert.equal(sourceConfig.schemaVersion, 1);
    assert.equal(sourceConfig.config.risk.action, 'kick');
    const sourceDb = new DatabaseSync(join(result.backupDir!, 'qqadmin.db'), { readOnly: true });
    assert.ok((sourceDb.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).some((column) => column.name === 'totp_secret'));
    assert.deepEqual(
      plainRow(sourceDb, `
        SELECT
          CAST(group_id AS TEXT) AS group_id,
          CAST(user_id AS TEXT) AS user_id,
          CAST(operator_id AS TEXT) AS operator_id
        FROM approval_records
      `),
      {
        group_id: '9223372036854775807',
        user_id: '9007199254740993',
        operator_id: '9007199254740994',
      },
    );
    sourceDb.close();

    const rerun = await runGuardianShadowMigration({ configDir: installation.configDir, dataDir: installation.dataDir });
    assert.equal(rerun.status, 'already-migrated');
  });

  it('canonicalizes legacy zero system actors without dropping operational rows', async () => {
    const installation = createLegacyInstallation();
    const db = new DatabaseSync(installation.databasePath);
    db.exec(`
      UPDATE approval_records SET operator_id = 0 WHERE id = 1;
      UPDATE blacklist SET created_by = 0 WHERE id = 1;
      UPDATE punishment_records
      SET operator_id = 0, revoked_at = 2, revoked_by = 0
      WHERE id = 1;
      UPDATE audit_logs SET actor_id = 0 WHERE id = 1;
    `);
    db.close();

    const result = await runGuardianShadowMigration({
      configDir: installation.configDir,
      dataDir: installation.dataDir,
    });
    assert.equal(result.status, 'migrated');

    const migrated = new DatabaseSync(installation.databasePath, { readOnly: true });
    assert.deepEqual(
      plainRow(migrated, `
        SELECT operator_id, typeof(operator_id) AS operator_type
        FROM approval_records WHERE id = 1
      `),
      { operator_id: null, operator_type: 'null' },
    );
    assert.deepEqual(
      plainRow(migrated, `
        SELECT created_by, typeof(created_by) AS creator_type
        FROM blacklist WHERE id = 1
      `),
      { created_by: null, creator_type: 'null' },
    );
    assert.deepEqual(
      plainRow(migrated, `
        SELECT operator_id, revoked_by,
          typeof(operator_id) AS operator_type,
          typeof(revoked_by) AS revoker_type
        FROM punishment_records WHERE id = 1
      `),
      {
        operator_id: null,
        revoked_by: null,
        operator_type: 'null',
        revoker_type: 'null',
      },
    );
    assert.deepEqual(
      plainRow(migrated, `
        SELECT actor_id, typeof(actor_id) AS actor_type
        FROM audit_logs WHERE id = 1
      `),
      { actor_id: null, actor_type: 'null' },
    );
    assert.equal(rowCount(migrated, 'approval_records'), 1);
    assert.equal(rowCount(migrated, 'blacklist'), 1);
    assert.equal(rowCount(migrated, 'punishment_records'), 1);
    assert.equal(rowCount(migrated, 'audit_logs'), 1);
    migrated.close();
  });

  it('preserves schema-v4 users, credentials, sessions, and foreign-key behavior', () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-v4-session-migration-'));
    testRoots.push(root);
    const databasePath = join(root, 'qqadmin.db');
    const db = new DatabaseSync(databasePath);
    db.exec('PRAGMA foreign_keys = ON');
    m001.up(db);
    m002.up(db);
    m003.up(db);
    m004.up(db);
    for (const version of [1, 2, 3, 4]) {
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, 1);
    }
    db.exec(`
      INSERT INTO users (
        qq_id, username, password_hash, role, login_attempts,
        locked_until, last_login, created_at, updated_at
      ) VALUES (
        9007199254740993, 'preserved-admin', 'preserved-password-hash',
        'super_admin', 2, 1234, 5678, 1, 2
      );
      INSERT INTO auth_sessions (
        token_id, user_id, kind, issued_at, expires_at, revoked_at
      ) VALUES (
        'preserved-session', 1, 'refresh', 10, 20, NULL
      );
      INSERT INTO users (
        qq_id, username, password_hash, role, login_attempts,
        locked_until, last_login, created_at, updated_at
      ) VALUES (
        9007199254740994, 'deleted-high-water-user', 'deleted-hash',
        'member', 0, NULL, NULL, 1, 1
      );
      DELETE FROM users WHERE id = 2;
    `);
    assert.deepEqual(plainRow(db, `SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = 'users'`), { seq: '2' });

    runMigrations(db);

    assert.deepEqual(
      plainRow(db, `
        SELECT qq_id, username, password_hash, role, login_attempts,
          locked_until, last_login, typeof(qq_id) AS qq_type
        FROM users WHERE id = 1
      `),
      {
        qq_id: '9007199254740993',
        username: 'preserved-admin',
        password_hash: 'preserved-password-hash',
        role: 'super_admin',
        login_attempts: 2,
        locked_until: 1234,
        last_login: 5678,
        qq_type: 'text',
      },
    );
    assert.deepEqual(
      plainRow(db, `
        SELECT token_id, user_id, kind, issued_at, expires_at, revoked_at,
          typeof(user_id) AS user_type
        FROM auth_sessions
      `),
      {
        token_id: 'preserved-session',
        user_id: 1,
        kind: 'refresh',
        issued_at: 10,
        expires_at: 20,
        revoked_at: null,
        user_type: 'integer',
      },
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(plainRow(db, `SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name = 'users'`), { seq: '2' });
    const nextUser = db.prepare(`
      INSERT INTO users (
        qq_id, username, password_hash, role, login_attempts,
        locked_until, last_login, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('9007199254740994', 'post-migration-user', 'post-migration-hash', 'member', 0, null, null, 3, 3);
    assert.equal(Number(nextUser.lastInsertRowid), 3, 'deleted AUTOINCREMENT ids must never be reused after rebuild');
    db.prepare('DELETE FROM users WHERE id = 1').run();
    assert.equal(rowCount(db, 'auth_sessions'), 0);
    db.close();
  });

  it('refuses to recreate a missing database after a completed migration', async () => {
    const installation = createLegacyInstallation();
    const migrated = await runGuardianShadowMigration({
      configDir: installation.configDir,
      dataDir: installation.dataDir,
    });
    assert.equal(migrated.status, 'migrated');

    rmSync(installation.databasePath);
    await assert.rejects(
      runGuardianShadowMigration({ configDir: installation.configDir, dataDir: installation.dataDir }),
      /completed migration journal exists but the active database is missing/
    );
    assert.equal(existsSync(installation.databasePath), false);
  });

  it('advances a verified completed v5 journal through the v6 migration', async () => {
    const { installation, journalId } = await createCompletedV5Installation();
    const result = await runGuardianShadowMigration({
      configDir: installation.configDir,
      dataDir: installation.dataDir,
    });

    assert.equal(result.status, 'migrated');
    const active = JSON.parse(readFileSync(installation.configPath, 'utf8')) as {
      schemaVersion: number;
    };
    assert.equal(active.schemaVersion, 6);
    assert.ok(existsSync(join(
      installation.dataDir,
      `migration-state.${journalId}.superseded-by-schema-upgrade.json`,
    )));
    const replacementJournal = JSON.parse(
      readFileSync(join(installation.dataDir, 'migration-state.json'), 'utf8'),
    ) as { id: string; phase: string };
    assert.notEqual(replacementJournal.id, journalId);
    assert.equal(replacementJournal.phase, 'completed');

    const db = new DatabaseSync(installation.databasePath, { readOnly: true });
    assert.equal(rowCount(db, 'approval_records'), 1);
    assert.equal(rowCount(db, 'punishment_records'), 1);
    db.close();
  });

  it('rejects an unproven completed-journal schema downgrade without changing live data', async () => {
    const { installation } = await createCompletedV5Installation({ proveV5: false });
    const journalBefore = readFileSync(join(installation.dataDir, 'migration-state.json'), 'utf8');
    const configBefore = readFileSync(installation.configPath, 'utf8');
    const databaseBefore = sha256File(installation.databasePath);

    await assert.rejects(
      runGuardianShadowMigration({
        configDir: installation.configDir,
        dataDir: installation.dataDir,
      }),
      /completed migration journal conflicts with restored legacy data/,
    );
    assert.equal(readFileSync(join(installation.dataDir, 'migration-state.json'), 'utf8'), journalBefore);
    assert.equal(readFileSync(installation.configPath, 'utf8'), configBefore);
    assert.equal(sha256File(installation.databasePath), databaseBefore);
  });

  it('fails a worker-proven unsafe legacy approval pattern before changing either live file', async () => {
    const installation = createLegacyInstallation();
    const safeConfig = readFileSync(installation.configPath, 'utf8');
    const legacy = JSON.parse(readFileSync(installation.configPath, 'utf8')) as {
      config: { approval: { groups: Record<string, { approvePatterns: string[] }> } };
    };
    // This bypasses the synchronous structural heuristic and must still be
    // rejected by the isolated worker probe before candidate activation.
    legacy.config.approval.groups['987654'].approvePatterns = ['(a|aa)+$'];
    writeFileSync(installation.configPath, JSON.stringify(legacy));
    const configBefore = readFileSync(installation.configPath, 'utf8');
    const dbBefore = sha256File(installation.databasePath);

    await assert.rejects(
      runGuardianShadowMigration({ configDir: installation.configDir, dataDir: installation.dataDir }),
      /Migration staging failed before live data was changed/
    );
    assert.equal(readFileSync(installation.configPath, 'utf8'), configBefore);
    assert.equal(sha256File(installation.databasePath), dbBefore);
    assert.ok(existsSync(join(installation.dataDir, 'migration-state.json')));
    const failedJournal = JSON.parse(readFileSync(join(installation.dataDir, 'migration-state.json'), 'utf8')) as { id: string };

    // A retry never reuses the failed candidate: it archives the stale journal,
    // builds a new verified generation, and still preserves the original DB.
    writeFileSync(installation.configPath, safeConfig);
    const retry = await runGuardianShadowMigration({ configDir: installation.configDir, dataDir: installation.dataDir });
    assert.equal(retry.status, 'migrated');
    assert.ok(existsSync(join(installation.dataDir, `migration-state.${failedJournal.id}.abandoned-before-activation.json`)));
  });

  it('fails a worker-proven unsafe legacy risk rule before changing either live file', async () => {
    const installation = createLegacyInstallation();
    const db = new DatabaseSync(installation.databasePath);
    db.prepare('UPDATE risk_rules SET pattern = ? WHERE id = 1').run('(a|aa)+$');
    db.close();
    const configBefore = readFileSync(installation.configPath, 'utf8');
    const dbBefore = sha256File(installation.databasePath);

    await assert.rejects(
      runGuardianShadowMigration({ configDir: installation.configDir, dataDir: installation.dataDir }),
      /Migration staging failed before live data was changed/
    );
    assert.equal(readFileSync(installation.configPath, 'utf8'), configBefore);
    assert.equal(sha256File(installation.databasePath), dbBefore);
    assert.ok(existsSync(join(installation.dataDir, 'migration-state.json')));
  });

  it('rejects an invalid legacy identifier before changing either live file', async () => {
    const installation = createLegacyInstallation();
    const db = new DatabaseSync(installation.databasePath);
    db.prepare('UPDATE approval_records SET group_id = -1 WHERE id = 1').run();
    db.close();
    const configBefore = readFileSync(installation.configPath, 'utf8');
    const dbBefore = sha256File(installation.databasePath);

    await assert.rejects(
      runGuardianShadowMigration({ configDir: installation.configDir, dataDir: installation.dataDir }),
      /Migration staging failed before live data was changed/,
    );
    assert.equal(readFileSync(installation.configPath, 'utf8'), configBefore);
    assert.equal(sha256File(installation.databasePath), dbBefore);
    assert.ok(existsSync(join(installation.dataDir, 'migration-state.json')));
  });

  it('rejects unsafe canonical persisted patterns on the fast path', async () => {
    const installation = createLegacyInstallation();
    await runGuardianShadowMigration({ configDir: installation.configDir, dataDir: installation.dataDir });

    const canonical = JSON.parse(readFileSync(installation.configPath, 'utf8')) as {
      config: { approval: { groups: Record<string, { approvePatterns: string[] }> } };
    };
    canonical.config.approval.groups['987654'].approvePatterns = ['(a|aa)+$'];
    writeFileSync(installation.configPath, JSON.stringify(canonical));
    const databaseBeforeConfigRejection = sha256File(installation.databasePath);

    await assert.rejects(
      runGuardianShadowMigration({ configDir: installation.configDir, dataDir: installation.dataDir }),
      /(?:contains an ambiguous quantified alternation|failed performance test \(possible ReDoS\))/
    );
    assert.equal(sha256File(installation.databasePath), databaseBeforeConfigRejection);

    canonical.config.approval.groups['987654'].approvePatterns = ['^trusted-\\d+$'];
    writeFileSync(installation.configPath, JSON.stringify(canonical));
    const db = new DatabaseSync(installation.databasePath);
    db.prepare('UPDATE risk_rules SET pattern = ? WHERE id = 1').run('(a|aa)+$');
    db.close();
    const configBeforeDatabaseRejection = readFileSync(installation.configPath, 'utf8');
    const databaseBeforeDatabaseRejection = sha256File(installation.databasePath);

    await assert.rejects(
      runGuardianShadowMigration({ configDir: installation.configDir, dataDir: installation.dataDir }),
      /(?:contains an ambiguous quantified alternation|failed performance test \(possible ReDoS\))/
    );
    assert.equal(readFileSync(installation.configPath, 'utf8'), configBeforeDatabaseRejection);
    assert.equal(sha256File(installation.databasePath), databaseBeforeDatabaseRejection);
  });

  it('refuses to invent a replacement config when only an existing database remains', async () => {
    const root = mkdtempSync(join(tmpdir(), 'guardian-configless-db-'));
    testRoots.push(root);
    const configDir = join(root, 'config');
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const databasePath = join(dataDir, 'qqadmin.db');
    const db = new DatabaseSync(databasePath);
    db.exec('CREATE TABLE preserved_state (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO preserved_state VALUES (1, \'keep\');');
    db.close();
    const before = sha256File(databasePath);

    await assert.rejects(
      runGuardianShadowMigration({ configDir, dataDir }),
      /Refusing to create a replacement config/
    );
    assert.equal(existsSync(join(configDir, 'config.json')), false);
    assert.equal(sha256File(databasePath), before);
  });

  it('restores source backups deterministically when an activation journal is interrupted', async () => {
    const installation = createLegacyInstallation();
    const migrated = await runGuardianShadowMigration({ configDir: installation.configDir, dataDir: installation.dataDir });
    const journalPath = join(installation.dataDir, 'migration-state.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      id: string;
      paths: { stagingDir: string; backupDir: string };
      candidate: unknown;
      phase: string;
    };
    mkdirSync(journal.paths.stagingDir, { recursive: true });
    const candidateConfigPath = join(journal.paths.stagingDir, 'config.next.json');
    const candidateDatabasePath = join(journal.paths.stagingDir, 'qqadmin.next.db');
    copyFileSync(installation.configPath, candidateConfigPath);
    copyFileSync(installation.databasePath, candidateDatabasePath);
    journal.candidate = {
      config: describeArtifact(candidateConfigPath),
      database: describeArtifact(candidateDatabasePath),
    };
    journal.phase = 'activating';
    writeFileSync(journalPath, JSON.stringify(journal));

    // Simulate an interruption after the config replacement but before the DB replacement.
    copyFileSync(join(migrated.backupDir!, 'config.json'), installation.configPath);
    const recovered = await recoverGuardianShadowMigration({ configDir: installation.configDir, dataDir: installation.dataDir });
    assert.equal(recovered.status, 'recovered');
    assert.equal(readFileSync(installation.configPath, 'utf8'), readFileSync(join(migrated.backupDir!, 'config.json'), 'utf8'));
    const restored = new DatabaseSync(installation.databasePath, { readOnly: true });
    assert.ok((restored.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).some((column) => column.name === 'totp_secret'));
    restored.close();
    assert.equal(existsSync(journalPath), false);
    assert.ok(existsSync(join(installation.dataDir, `migration-state.${journal.id}.recovered-source.json`)));
  });
});
