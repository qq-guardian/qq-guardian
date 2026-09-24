import { existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { dirname, join, resolve } from 'path';
import {
  CONFIG_FILENAME,
  CONFIG_SCHEMA_VERSION,
  migrateLegacyConfig,
  validateCanonicalConfigFile,
  validatePersistedApprovalPatterns,
} from '../core/config/schema.ts';
import { DATABASE_SCHEMA_VERSION, runMigrations } from '../database/migrations/index.ts';
import { getDatabasePath, openDatabaseFile } from '../database/index.ts';
import {
  assertRowCountsPreserved,
  captureOperationalRowCounts,
  detectRetiredDatabaseFields,
  getDatabaseSchemaVersion,
  validateDatabase,
} from '../database/validation.ts';
import {
  acquireMigrationLock,
  artifactMatches,
  assertPathInside,
  copyArtifact,
  describeArtifact,
  ensureRegularFile,
  removeSqliteSidecars,
  removeStagingDirectory,
  replaceFromArtifact,
  readJson,
  snapshotDatabase,
  verifyArtifact,
  writeJournal,
  writeJsonAtomically,
} from './files.ts';
import {
  SHADOW_MIGRATION_FORMAT,
  ShadowMigrationError,
  type GuardianMigrationPaths,
  type GuardianMigrationResult,
  type MigrationArtifact,
  type MigrationArtifacts,
  type MigrationManifest,
  type MigrationValidationReport,
  type ShadowMigrationJournal,
} from './types.ts';

const JOURNAL_FILENAME = 'migration-state.json';
const CREDENTIALS_FILENAME = 'credentials.txt';

interface ResolvedLayout {
  configDir: string;
  dataDir: string;
  configPath: string;
  databasePath: string;
  credentialsPath: string;
  journalPath: string;
}

type RecoveryOutcome = 'none' | 'completed' | 'restored' | 'discarded';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ShadowMigrationError(`${label} is malformed`);
  }
  return value as Record<string, unknown>;
}

function resolveLayout(paths: GuardianMigrationPaths): ResolvedLayout {
  const configDir = resolve(paths.configDir);
  const dataDir = resolve(paths.dataDir);
  const configPath = assertPathInside(configDir, join(configDir, CONFIG_FILENAME), 'config path');
  const databasePath = assertPathInside(dataDir, getDatabasePath(dataDir), 'database path');
  return {
    configDir,
    dataDir,
    configPath,
    databasePath,
    credentialsPath: assertPathInside(dataDir, join(dataDir, CREDENTIALS_FILENAME), 'credentials path'),
    journalPath: assertPathInside(dataDir, join(dataDir, JOURNAL_FILENAME), 'migration journal path'),
  };
}

function migrationId(): string {
  return randomUUID();
}

function migrationDirectoryName(id: string): string {
  return `migration-${new Date().toISOString().replace(/[:.]/g, '-')}-${id}`;
}

function ensureFileOrAbsent(path: string, label: string): boolean {
  if (!existsSync(path)) return false;
  ensureRegularFile(path, label);
  return true;
}

function parseJournal(value: unknown, layout: ResolvedLayout): ShadowMigrationJournal {
  const record = asRecord(value, 'migration journal');
  if (record.format !== SHADOW_MIGRATION_FORMAT || typeof record.id !== 'string') {
    throw new ShadowMigrationError('migration journal has an unsupported format');
  }
  const journal = record as unknown as ShadowMigrationJournal;
  const pathRecord = asRecord(journal.paths, 'migration journal paths');
  if (
    resolve(String(pathRecord.configPath)) !== layout.configPath ||
    resolve(String(pathRecord.databasePath)) !== layout.databasePath ||
    resolve(String(pathRecord.credentialsPath)) !== layout.credentialsPath
  ) {
    throw new ShadowMigrationError('migration journal does not match the configured persistent paths');
  }
  const backupsRoot = assertPathInside(layout.dataDir, join(layout.dataDir, 'backups'), 'backups root');
  const stagingRoot = assertPathInside(layout.dataDir, join(layout.dataDir, 'migration'), 'staging root');
  const backupDir = assertPathInside(backupsRoot, String(pathRecord.backupDir), 'journal backup directory');
  const stagingDir = assertPathInside(stagingRoot, String(pathRecord.stagingDir), 'journal staging directory');
  if (backupDir !== resolve(String(pathRecord.backupDir)) || stagingDir !== resolve(String(pathRecord.stagingDir))) {
    throw new ShadowMigrationError('migration journal has non-canonical artifact paths');
  }
  if (!Object.values([
    'prepared', 'backup_verified', 'staged', 'staged_validated', 'activating',
    'active_validated', 'completed', 'recovery_required',
  ]).includes(journal.phase)) {
    throw new ShadowMigrationError('migration journal has an invalid phase');
  }
  return journal;
}

function loadJournal(layout: ResolvedLayout): ShadowMigrationJournal | null {
  if (!existsSync(layout.journalPath)) return null;
  return parseJournal(readJson(layout.journalPath), layout);
}

function artifactMetadataMatches(value: unknown, expected: MigrationArtifact, label: string): boolean {
  const record = asRecord(value, label);
  return (
    typeof record.path === 'string' &&
    resolve(record.path) === resolve(expected.path) &&
    record.sha256 === expected.sha256 &&
    record.bytes === expected.bytes
  );
}

function optionalArtifactMetadataMatches(
  value: unknown,
  expected: MigrationArtifact | null,
  label: string,
): boolean {
  if (expected === null) return value === null;
  return artifactMetadataMatches(value, expected, label);
}

function completedJournalProvesPreviousConfigGeneration(
  journal: ShadowMigrationJournal,
  layout: ResolvedLayout,
  activeConfigSchemaVersion: unknown,
  canonicalDatabase: boolean,
): boolean {
  if (
    journal.phase !== 'completed' ||
    activeConfigSchemaVersion !== CONFIG_SCHEMA_VERSION - 1 ||
    !canonicalDatabase
  ) {
    return false;
  }

  // The prior generation is trusted only when its immutable backup and
  // validation manifest still agree with the completed journal. Active files
  // are allowed to have evolved since completion, but they must remain at the
  // exact schema versions that generation proved.
  assertRecoverableJournal(journal, layout);
  const manifestPath = assertPathInside(
    journal.paths.backupDir,
    join(journal.paths.backupDir, 'manifest.json'),
    'completed migration manifest',
  );
  ensureRegularFile(manifestPath, 'completed migration manifest');
  const manifest = asRecord(readJson(manifestPath), 'completed migration manifest');
  const target = asRecord(manifest.target, 'completed migration manifest target');
  const validation = asRecord(manifest.validation, 'completed migration validation');
  const source = asRecord(manifest.source, 'completed migration source');

  if (
    manifest.format !== SHADOW_MIGRATION_FORMAT ||
    manifest.migrationId !== journal.id ||
    manifest.createdAt !== journal.createdAt ||
    target.configSchemaVersion !== activeConfigSchemaVersion ||
    target.databaseSchemaVersion !== DATABASE_SCHEMA_VERSION ||
    validation.configSchemaVersion !== activeConfigSchemaVersion ||
    validation.databaseSchemaVersion !== DATABASE_SCHEMA_VERSION ||
    !artifactMetadataMatches(source.config, journal.source.config, 'completed migration source config') ||
    !optionalArtifactMetadataMatches(
      source.database,
      journal.source.database,
      'completed migration source database',
    ) ||
    !optionalArtifactMetadataMatches(
      source.credentials,
      journal.source.credentials,
      'completed migration source credentials',
    )
  ) {
    return false;
  }
  return true;
}

function archiveJournal(layout: ResolvedLayout, journal: ShadowMigrationJournal, reason: string): void {
  const archivePath = assertPathInside(
    layout.dataDir,
    join(layout.dataDir, `migration-state.${journal.id}.${reason}.json`),
    'archived migration journal path'
  );
  if (existsSync(archivePath)) {
    throw new ShadowMigrationError(`refusing to overwrite an existing journal archive: ${archivePath}`);
  }
  // Atomic within dataDir; preserves an audit trail without leaving it active.
  renameSync(layout.journalPath, archivePath);
}

function assertArtifactPath(artifact: MigrationArtifact, expectedPath: string, label: string): void {
  if (resolve(artifact.path) !== resolve(expectedPath)) {
    throw new ShadowMigrationError(`${label} path does not match the migration layout`);
  }
}

function assertRecoverableJournal(journal: ShadowMigrationJournal, layout: ResolvedLayout): asserts journal is ShadowMigrationJournal & {
  source: MigrationArtifacts;
} {
  if (!journal.source) throw new ShadowMigrationError('migration journal has no verified source backup');
  const backupDir = journal.paths.backupDir;
  assertArtifactPath(journal.source.config, join(backupDir, CONFIG_FILENAME), 'source config');
  if (journal.source.database) assertArtifactPath(journal.source.database, join(backupDir, 'qqadmin.db'), 'source database');
  if (journal.source.credentials) assertArtifactPath(journal.source.credentials, join(backupDir, CREDENTIALS_FILENAME), 'source credentials');
  verifyArtifact(journal.source.config, 'source config backup');
  if (journal.source.database) verifyArtifact(journal.source.database, 'source database backup');
  if (journal.source.credentials) verifyArtifact(journal.source.credentials, 'source credentials backup');
  assertPathInside(layout.dataDir, backupDir, 'journal backup directory');
}

function assertCandidateJournal(journal: ShadowMigrationJournal): asserts journal is ShadowMigrationJournal & {
  candidate: { config: MigrationArtifact; database: MigrationArtifact };
} {
  if (!journal.candidate) throw new ShadowMigrationError('migration journal has no staged candidate');
  assertArtifactPath(journal.candidate.config, join(journal.paths.stagingDir, 'config.next.json'), 'candidate config');
  assertArtifactPath(journal.candidate.database, join(journal.paths.stagingDir, 'qqadmin.next.db'), 'candidate database');
  verifyArtifact(journal.candidate.config, 'candidate config');
  verifyArtifact(journal.candidate.database, 'candidate database');
}

function activeMatchesCandidate(journal: ShadowMigrationJournal, layout: ResolvedLayout): boolean {
  if (!journal.candidate) return false;
  return (
    artifactMatches(layout.configPath, journal.candidate.config) &&
    artifactMatches(layout.databasePath, journal.candidate.database)
  );
}

async function validateActiveCandidate(journal: ShadowMigrationJournal, layout: ResolvedLayout): Promise<void> {
  assertCandidateJournal(journal);
  const config = validateCanonicalConfigFile(readJson(layout.configPath));
  await validatePersistedApprovalPatterns(config.config);
  const db = openDatabaseFile(layout.databasePath, true);
  try {
    await validateDatabase(db);
  } finally {
    db.close();
  }
  if (!activeMatchesCandidate(journal, layout)) {
    throw new ShadowMigrationError('active files changed while migration validation was running');
  }
}

function restoreFromBackup(journal: ShadowMigrationJournal, layout: ResolvedLayout): void {
  assertRecoverableJournal(journal, layout);
  if (
    !journal.source.database &&
    existsSync(layout.databasePath) &&
    (!journal.candidate || !artifactMatches(layout.databasePath, journal.candidate.database))
  ) {
    throw new ShadowMigrationError(
      'cannot remove a database that was absent before migration because it no longer matches the staged candidate'
    );
  }
  replaceFromArtifact(journal.source.config.path, layout.configPath, 'source configuration backup');
  if (journal.source.database) {
    removeSqliteSidecars(layout.databasePath);
    replaceFromArtifact(journal.source.database.path, layout.databasePath, 'source database backup');
    if (!artifactMatches(layout.databasePath, journal.source.database)) {
      throw new ShadowMigrationError('restored database does not match its verified backup');
    }
    return;
  }

  if (!existsSync(layout.databasePath)) return;
  removeSqliteSidecars(layout.databasePath);
  unlinkSync(layout.databasePath);
}

function cleanupCompletedStaging(layout: ResolvedLayout, journal: ShadowMigrationJournal): void {
  try {
    removeStagingDirectory(layout.dataDir, journal.paths.stagingDir);
  } catch {
    // Completion is already journaled and active files are verified. A mounted
    // filesystem may transiently hold a staging handle; leave it for manual
    // cleanup instead of turning a completed migration into a failed boot.
  }
}

async function recoverIncompleteJournal(layout: ResolvedLayout): Promise<RecoveryOutcome> {
  const journal = loadJournal(layout);
  if (!journal || journal.phase === 'completed') return 'none';

  if (journal.phase === 'prepared' || journal.phase === 'backup_verified' || journal.phase === 'staged' || journal.phase === 'staged_validated') {
    archiveJournal(layout, journal, 'abandoned-before-activation');
    return 'discarded';
  }

  assertRecoverableJournal(journal, layout);
  if (activeMatchesCandidate(journal, layout)) {
    await validateActiveCandidate(journal, layout);
    journal.phase = 'active_validated';
    delete journal.error;
    writeJournal(layout.journalPath, journal);
    journal.phase = 'completed';
    writeJournal(layout.journalPath, journal);
    cleanupCompletedStaging(layout, journal);
    return 'completed';
  }

  journal.phase = 'recovery_required';
  writeJournal(layout.journalPath, journal);
  restoreFromBackup(journal, layout);
  archiveJournal(layout, journal, 'recovered-source');
  return 'restored';
}

async function configIsCanonical(layout: ResolvedLayout): Promise<boolean> {
  const raw = readJson(layout.configPath);
  const record = asRecord(raw, 'config file');
  const version = record.schemaVersion;
  if (version === CONFIG_SCHEMA_VERSION) {
    const config = validateCanonicalConfigFile(raw);
    await validatePersistedApprovalPatterns(config.config);
    return true;
  }
  if (typeof version === 'number' && version > CONFIG_SCHEMA_VERSION) {
    throw new ShadowMigrationError(`config schema ${version} is newer than this Guardian runtime`);
  }
  return false;
}

async function databaseIsCanonical(layout: ResolvedLayout): Promise<boolean> {
  const db = openDatabaseFile(layout.databasePath, true);
  try {
    const version = getDatabaseSchemaVersion(db);
    if (version > DATABASE_SCHEMA_VERSION) {
      throw new ShadowMigrationError(`database schema ${version} is newer than this Guardian runtime`);
    }
    if (version !== DATABASE_SCHEMA_VERSION) return false;
    await validateDatabase(db);
    return true;
  } finally {
    db.close();
  }
}

function createJournal(layout: ResolvedLayout): ShadowMigrationJournal {
  const id = migrationId();
  const backupDir = assertPathInside(
    layout.dataDir,
    join(layout.dataDir, 'backups', migrationDirectoryName(id)),
    'migration backup directory'
  );
  const stagingDir = assertPathInside(
    layout.dataDir,
    join(layout.dataDir, 'migration', id),
    'migration staging directory'
  );
  const now = new Date().toISOString();
  return {
    format: SHADOW_MIGRATION_FORMAT,
    id,
    createdAt: now,
    updatedAt: now,
    phase: 'prepared',
    paths: {
      configPath: layout.configPath,
      databasePath: layout.databasePath,
      credentialsPath: layout.credentialsPath,
      backupDir,
      stagingDir,
    },
    source: null,
    candidate: null,
  };
}

function createBackups(journal: ShadowMigrationJournal, layout: ResolvedLayout): MigrationArtifacts {
  mkdirSync(journal.paths.backupDir, { recursive: true, mode: 0o700 });
  const config = copyArtifact(layout.configPath, join(journal.paths.backupDir, CONFIG_FILENAME), 'configuration');
  const database = existsSync(layout.databasePath)
    ? snapshotDatabase(layout.databasePath, join(journal.paths.backupDir, 'qqadmin.db'))
    : null;
  const credentials = existsSync(layout.credentialsPath)
    ? copyArtifact(layout.credentialsPath, join(journal.paths.backupDir, CREDENTIALS_FILENAME), 'credentials')
    : null;
  return { config, database, credentials };
}

function readSourceDatabaseMetadata(source: MigrationArtifact | null): {
  rowCounts: Record<string, number>;
  retiredFields: string[];
} {
  if (!source) return { rowCounts: {}, retiredFields: [] };
  const db = openDatabaseFile(source.path, true);
  try {
    return {
      rowCounts: captureOperationalRowCounts(db),
      retiredFields: detectRetiredDatabaseFields(db),
    };
  } finally {
    db.close();
  }
}

async function createCandidateDatabase(
  candidatePath: string,
  source: MigrationArtifact | null,
  sourceRowCounts: Record<string, number>
): Promise<{ artifact: MigrationArtifact; rowCounts: Record<string, number> }> {
  mkdirSync(dirname(candidatePath), { recursive: true, mode: 0o700 });
  if (source) {
    copyArtifact(source.path, candidatePath, 'database staging source');
  }
  let rowCounts: Record<string, number>;
  const db = openDatabaseFile(candidatePath);
  try {
    runMigrations(db);
    const report = await validateDatabase(db);
    assertRowCountsPreserved(sourceRowCounts, report.rowCounts);
    // A staged artifact must be a self-contained main database file; a live
    // runtime can enable WAL after this candidate has been activated.
    db.exec('PRAGMA journal_mode = DELETE');
    rowCounts = report.rowCounts;
  } finally {
    db.close();
    removeSqliteSidecars(candidatePath);
  }
  return { artifact: describeArtifact(candidatePath), rowCounts: rowCounts! };
}

function writeManifest(path: string, manifest: MigrationManifest): void {
  writeJsonAtomically(path, manifest);
}

async function performMigration(layout: ResolvedLayout): Promise<GuardianMigrationResult> {
  const journal = createJournal(layout);
  mkdirSync(layout.dataDir, { recursive: true, mode: 0o700 });
  writeJournal(layout.journalPath, journal);

  try {
    journal.source = createBackups(journal, layout);
    verifyArtifact(journal.source.config, 'configuration backup');
    if (journal.source.database) verifyArtifact(journal.source.database, 'database backup');
    if (journal.source.credentials) verifyArtifact(journal.source.credentials, 'credentials backup');
    journal.phase = 'backup_verified';
    writeJournal(layout.journalPath, journal);

    const sourceMetadata = readSourceDatabaseMetadata(journal.source.database);
    const manifest: MigrationManifest = {
      format: SHADOW_MIGRATION_FORMAT,
      migrationId: journal.id,
      createdAt: journal.createdAt,
      source: journal.source,
      target: {
        configSchemaVersion: CONFIG_SCHEMA_VERSION,
        databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
      },
    };
    writeManifest(join(journal.paths.backupDir, 'manifest.json'), manifest);

    mkdirSync(journal.paths.stagingDir, { recursive: true, mode: 0o700 });
    const migratedConfig = migrateLegacyConfig(readJson(journal.source.config.path));
    const candidateConfigPath = join(journal.paths.stagingDir, 'config.next.json');
    writeJsonAtomically(candidateConfigPath, migratedConfig.file);
    const candidateConfigFile = validateCanonicalConfigFile(readJson(candidateConfigPath));
    await validatePersistedApprovalPatterns(candidateConfigFile.config);
    const candidateConfig = describeArtifact(candidateConfigPath);
    const candidateDatabase = await createCandidateDatabase(
      join(journal.paths.stagingDir, 'qqadmin.next.db'),
      journal.source.database,
      sourceMetadata.rowCounts
    );
    journal.candidate = { config: candidateConfig, database: candidateDatabase.artifact };
    journal.phase = 'staged';
    writeJournal(layout.journalPath, journal);

    const validation: MigrationValidationReport = {
      configSchemaVersion: CONFIG_SCHEMA_VERSION,
      databaseSchemaVersion: DATABASE_SCHEMA_VERSION,
      sourceRowCounts: sourceMetadata.rowCounts,
      candidateRowCounts: candidateDatabase.rowCounts,
      preservedConfigFields: migratedConfig.preservedFields,
      retiredConfigFields: migratedConfig.retiredFields,
      retiredDatabaseFields: sourceMetadata.retiredFields,
    };
    // Keep the verification result beside the shadow artifacts while the
    // candidate awaits activation. The same report is also retained in the
    // immutable backup manifest after staging is cleaned up on success.
    writeJsonAtomically(join(journal.paths.stagingDir, 'validation.json'), validation);
    manifest.validation = validation;
    writeManifest(join(journal.paths.backupDir, 'manifest.json'), manifest);
    journal.phase = 'staged_validated';
    writeJournal(layout.journalPath, journal);

    assertCandidateJournal(journal);
    journal.phase = 'activating';
    writeJournal(layout.journalPath, journal);
    replaceFromArtifact(journal.candidate.config.path, layout.configPath, 'staged configuration');
    if (!artifactMatches(layout.configPath, journal.candidate.config)) {
      throw new ShadowMigrationError('active configuration did not match the staged candidate');
    }
    // A WAL belongs to the former main database and must never accompany the
    // independently validated replacement. Recovery restores the snapshot if
    // startup is interrupted after this point.
    removeSqliteSidecars(layout.databasePath);
    replaceFromArtifact(journal.candidate.database.path, layout.databasePath, 'staged database');
    if (!artifactMatches(layout.databasePath, journal.candidate.database)) {
      throw new ShadowMigrationError('active database did not match the staged candidate');
    }

    journal.phase = 'active_validated';
    writeJournal(layout.journalPath, journal);
    await validateActiveCandidate(journal, layout);
    journal.phase = 'completed';
    delete journal.error;
    writeJournal(layout.journalPath, journal);
    cleanupCompletedStaging(layout, journal);
    return { status: 'migrated', journalPath: layout.journalPath, backupDir: journal.paths.backupDir };
  } catch (error) {
    const activeJournal = loadJournal(layout) ?? journal;
    activeJournal.error = errorMessage(error);
    if (activeJournal.phase === 'activating' || activeJournal.phase === 'active_validated' || activeJournal.phase === 'recovery_required') {
      activeJournal.phase = 'recovery_required';
      writeJournal(layout.journalPath, activeJournal);
      try {
        restoreFromBackup(activeJournal, layout);
        archiveJournal(layout, activeJournal, 'recovered-after-failure');
        throw new ShadowMigrationError(
          `Migration failed after activation began; the verified original data was restored. ${errorMessage(error)}`,
          { cause: error }
        );
      } catch (recoveryError) {
        if (recoveryError instanceof ShadowMigrationError && recoveryError.cause === error) throw recoveryError;
        activeJournal.error = `${errorMessage(error)}; recovery failed: ${errorMessage(recoveryError)}`;
        activeJournal.phase = 'recovery_required';
        writeJournal(layout.journalPath, activeJournal);
        throw new ShadowMigrationError(
          `Migration failed and could not restore automatically. Do not start Guardian; use ${activeJournal.paths.backupDir}. ${errorMessage(recoveryError)}`,
          { cause: recoveryError }
        );
      }
    }
    writeJournal(layout.journalPath, activeJournal);
    throw new ShadowMigrationError(
      `Migration staging failed before live data was changed. ${errorMessage(error)}`,
      { cause: error }
    );
  }
}

/**
 * Runs before configManager.init/openDatabase. It either leaves current data
 * untouched, migrates a fully validated shadow generation, or fails safely.
 */
export async function runGuardianShadowMigration(paths: GuardianMigrationPaths): Promise<GuardianMigrationResult> {
  const layout = resolveLayout(paths);
  const configExists = ensureFileOrAbsent(layout.configPath, 'configuration');
  const databaseExists = ensureFileOrAbsent(layout.databasePath, 'database');
  const journalExists = existsSync(layout.journalPath);
  if (!configExists && !databaseExists && !journalExists) {
    return { status: 'not-needed', journalPath: layout.journalPath };
  }
  if (!journalExists && !configExists && databaseExists) {
    throw new ShadowMigrationError(
      `Refusing to create a replacement config for an existing database. Restore ${layout.configPath} first.`
    );
  }

  const release = acquireMigrationLock(layout.dataDir);
  try {
    const recovery = await recoverIncompleteJournal(layout);
    if (recovery === 'completed') {
      const completed = loadJournal(layout);
      return {
        status: 'recovered',
        journalPath: layout.journalPath,
        backupDir: completed?.paths.backupDir,
      };
    }

    const completedJournal = loadJournal(layout);
    const nowConfigExists = ensureFileOrAbsent(layout.configPath, 'configuration');
    const nowDatabaseExists = ensureFileOrAbsent(layout.databasePath, 'database');
    // A completed shadow migration means this installation previously had a
    // verified configuration *and* database generation. Never let the normal
    // config/database managers interpret a missing artifact as a fresh
    // install: that would silently replace preserved operational state.
    if (completedJournal?.phase === 'completed' && (!nowConfigExists || !nowDatabaseExists)) {
      const missing = [
        !nowConfigExists ? 'configuration' : null,
        !nowDatabaseExists ? 'database' : null,
      ].filter(Boolean).join(' and ');
      throw new ShadowMigrationError(
        `A completed migration journal exists but the active ${missing} is missing. Restore the verified backup in ${completedJournal.paths.backupDir} before starting Guardian.`
      );
    }
    if (!nowConfigExists && !nowDatabaseExists) {
      return { status: 'not-needed', journalPath: layout.journalPath };
    }
    if (!nowConfigExists) {
      throw new ShadowMigrationError(`configuration disappeared during migration recovery: ${layout.configPath}`);
    }

    const rawConfig = readJson(layout.configPath);
    const activeConfigSchemaVersion = asRecord(rawConfig, 'config file').schemaVersion;
    const canonicalConfig = await configIsCanonical(layout);
    const canonicalDatabase = nowDatabaseExists ? await databaseIsCanonical(layout) : false;
    const verifiedConfigUpgrade = completedJournal?.phase === 'completed' && !canonicalConfig
      ? completedJournalProvesPreviousConfigGeneration(
          completedJournal,
          layout,
          activeConfigSchemaVersion,
          canonicalDatabase,
        )
      : false;
    if (completedJournal?.phase === 'completed' && (!canonicalConfig || !canonicalDatabase) && !verifiedConfigUpgrade) {
      throw new ShadowMigrationError(
        `A completed migration journal conflicts with restored legacy data. Restore with the matching pre-migration release, or archive ${layout.journalPath} before intentionally rerunning migration.`
      );
    }
    if (canonicalConfig && (!nowDatabaseExists || canonicalDatabase)) {
      return {
        status: completedJournal?.phase === 'completed' ? 'already-migrated' : 'not-needed',
        journalPath: layout.journalPath,
        backupDir: completedJournal?.paths.backupDir,
      };
    }
    if (verifiedConfigUpgrade) {
      archiveJournal(layout, completedJournal!, 'superseded-by-schema-upgrade');
    }
    return await performMigration(layout);
  } finally {
    release();
  }
}

/** Only resolves a persisted interrupted migration; it never starts a new one. */
export async function recoverGuardianShadowMigration(paths: GuardianMigrationPaths): Promise<GuardianMigrationResult> {
  const layout = resolveLayout(paths);
  if (!existsSync(layout.journalPath)) return { status: 'not-needed', journalPath: layout.journalPath };
  const release = acquireMigrationLock(layout.dataDir);
  try {
    const outcome = await recoverIncompleteJournal(layout);
    const journal = loadJournal(layout);
    return {
      status: outcome === 'completed' || outcome === 'restored' ? 'recovered' : journal?.phase === 'completed' ? 'already-migrated' : 'not-needed',
      journalPath: layout.journalPath,
      backupDir: journal?.paths.backupDir,
    };
  } finally {
    release();
  }
}
