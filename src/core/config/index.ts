import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import type { DeepPartial, PluginConfig } from './types.ts';
import { buildDefaults } from './defaults.ts';
import {
  CONFIG_FILENAME,
  createCanonicalConfigFile,
  mergeConfigValues,
  validateCanonicalConfig,
  validateCanonicalConfigFile,
  type ConfigExtensionBag,
} from './schema.ts';
import { bus } from '../events/index.ts';

const BACKUP_DIR = 'config-backups';
const BACKUP_MIN_INTERVAL_MS = 60_000;
const MAX_CONFIG_BACKUPS = 20;

type JsonComparable = null | boolean | number | string | JsonComparable[] | { [key: string]: JsonComparable };

/** Allocation-free equality for already validated JSON-like config values. */
function configValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!configValueEqual(left[index], right[index])) return false;
    }
    return true;
  }

  const leftRecord = left as Record<string, JsonComparable>;
  const rightRecord = right as Record<string, JsonComparable>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
    if (!configValueEqual(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}

/**
 * Only sections named by the caller's partial update can change. Comparing
 * those sections avoids serializing the complete configuration (including
 * hundreds of unrelated group records) for every small settings write.
 */
function partialChangesConfig(
  base: PluginConfig,
  next: PluginConfig,
  partial: DeepPartial<PluginConfig>,
): boolean {
  for (const key of Object.keys(partial) as Array<keyof PluginConfig>) {
    if (!configValueEqual(base[key], next[key])) return true;
  }
  return false;
}

/**
 * Normal runtime configuration manager. Legacy conversion deliberately does
 * not live here: callers must run the shadow migration before this is opened.
 */
export class ConfigManager {
  private cfg!: PluginConfig;
  private extensions: ConfigExtensionBag | undefined;
  private configPath!: string;
  private backupDir!: string;
  private lastBackupTs = 0;

  init(configDir: string): void {
    this.configPath = join(configDir, CONFIG_FILENAME);
    this.backupDir = join(configDir, BACKUP_DIR);
    mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
    try { chmodSync(this.backupDir, 0o700); } catch { /* Best effort outside POSIX filesystems. */ }

    if (existsSync(this.configPath)) {
      this.cfg = this.load();
    } else {
      this.extensions = undefined;
      this.cfg = validateCanonicalConfig(buildDefaults());
      this.save();
    }
  }

  get(): PluginConfig {
    return this.cfg;
  }

  update(partial: DeepPartial<PluginConfig>): void {
    const base = this.cfg;
    const next = this.buildUpdate(base, partial);
    if (!partialChangesConfig(base, next, partial)) return;
    this.commitUpdate(next);
  }

  /**
   * Validates the complete post-merge configuration asynchronously before an
   * atomic write. This is for request paths that accept untrusted values whose
   * safety checks cannot run on the event loop (notably regular expressions).
   * If another update wins while validation is in flight, recompute against
   * that new generation rather than persisting an unvalidated merge.
   */
  async updateValidated(
    partial: DeepPartial<PluginConfig>,
    validate: (candidate: PluginConfig) => Promise<void>,
  ): Promise<void> {
    for (;;) {
      const base = this.cfg;
      const next = this.buildUpdate(base, partial);
      if (!partialChangesConfig(base, next, partial)) return;
      await validate(next);
      if (this.cfg !== base) continue;
      this.commitUpdate(next);
      return;
    }
  }

  private buildUpdate(base: PluginConfig, partial: DeepPartial<PluginConfig>): PluginConfig {
    return validateCanonicalConfig(mergeConfigValues(base, partial));
  }

  private commitUpdate(next: PluginConfig): void {
    this.backup();
    this.cfg = next;
    this.save();
    bus.emit('ConfigChanged', { section: 'config', timestamp: Date.now() });
  }

  private load(): PluginConfig {
    const raw = readFileSync(this.configPath, 'utf8');
    const file = validateCanonicalConfigFile(JSON.parse(raw));
    this.extensions = file.extensions;
    return file.config;
  }

  /** Writes a complete canonical file beside the old one before replacement. */
  private save(): void {
    const tmp = `${this.configPath}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(createCanonicalConfigFile(this.cfg, this.extensions), null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      renameSync(tmp, this.configPath);
      try { chmodSync(this.configPath, 0o600); } catch { /* Windows/virtual filesystems may not expose POSIX modes. */ }
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        // Best effort: never hide the original write error.
      }
      throw error;
    }
  }

  private backup(): void {
    const now = Date.now();
    if (now - this.lastBackupTs < BACKUP_MIN_INTERVAL_MS || !existsSync(this.configPath)) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      copyFileSync(this.configPath, join(this.backupDir, `config-${timestamp}.json`));
      this.lastBackupTs = now;
      this.pruneBackups();
    } catch {
      // Configuration writes remain available if a convenience backup fails.
    }
  }

  private pruneBackups(): void {
    const backups = readdirSync(this.backupDir)
      .filter((name) => /^config-.*\.json$/.test(name))
      .sort();
    const excess = backups.length - MAX_CONFIG_BACKUPS;
    for (const name of excess > 0 ? backups.slice(0, excess) : []) {
      try {
        unlinkSync(join(this.backupDir, name));
      } catch {
        // Best effort only; migration backups use a separate never-pruned path.
      }
    }
  }
}

export const configManager = new ConfigManager();
