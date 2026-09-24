export const SHADOW_MIGRATION_FORMAT = 'shadow-migration-v1';

export type MigrationPhase =
  | 'prepared'
  | 'backup_verified'
  | 'staged'
  | 'staged_validated'
  | 'activating'
  | 'active_validated'
  | 'completed'
  | 'recovery_required';

export interface GuardianMigrationPaths {
  configDir: string;
  dataDir: string;
}

export interface MigrationArtifact {
  path: string;
  sha256: string;
  bytes: number;
}

export interface MigrationArtifacts {
  config: MigrationArtifact;
  database: MigrationArtifact | null;
  credentials: MigrationArtifact | null;
}

export interface ShadowMigrationJournal {
  format: typeof SHADOW_MIGRATION_FORMAT;
  id: string;
  createdAt: string;
  updatedAt: string;
  phase: MigrationPhase;
  paths: {
    configPath: string;
    databasePath: string;
    credentialsPath: string;
    backupDir: string;
    stagingDir: string;
  };
  source: MigrationArtifacts | null;
  candidate: {
    config: MigrationArtifact;
    database: MigrationArtifact;
  } | null;
  error?: string;
}

export interface MigrationValidationReport {
  configSchemaVersion: number;
  databaseSchemaVersion: number;
  sourceRowCounts: Record<string, number>;
  candidateRowCounts: Record<string, number>;
  preservedConfigFields: string[];
  retiredConfigFields: string[];
  retiredDatabaseFields: string[];
}

export interface MigrationManifest {
  format: typeof SHADOW_MIGRATION_FORMAT;
  migrationId: string;
  createdAt: string;
  source: MigrationArtifacts;
  target: {
    configSchemaVersion: number;
    databaseSchemaVersion: number;
  };
  validation?: MigrationValidationReport;
}

export interface GuardianMigrationResult {
  status: 'not-needed' | 'migrated' | 'already-migrated' | 'recovered';
  journalPath: string;
  backupDir?: string;
}

export class ShadowMigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ShadowMigrationError';
  }
}
