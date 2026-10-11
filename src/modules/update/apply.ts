import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { NAPCAT_UPDATE_FILES, parseNapCatUpdateArchive } from './archive.ts';

const PLUGIN_PACKAGE_NAME = 'napcat-plugin-qq-guardian';

export interface AppliedUpdate {
  backupPath: string;
  files: number;
}

/** Replace only the fixed runtime files in an already verified NapCat archive. */
export function applyNapCatUpdateArchive(
  archive: Buffer,
  pluginPath: string,
  backupRoot: string,
  version: string,
): AppliedUpdate {
  const files = parseNapCatUpdateArchive(archive);
  validateReleaseManifests(files, version);
  const pluginRoot = realpathSync(pluginPath);
  if (!lstatSync(pluginRoot).isDirectory()) throw new Error('NapCat plugin path is not a directory');

  const targets = NAPCAT_UPDATE_FILES.map((relativePath) => {
    const parts = relativePath.split('/');
    let parent = pluginRoot;
    for (const segment of parts.slice(0, -1)) {
      parent = join(parent, segment);
      const parentStat = lstatSync(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
        throw new Error(`Refusing to update through a non-directory or symbolic link: ${relativePath}`);
      }
    }
    const path = join(pluginRoot, ...parts);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Refusing to replace a non-regular or symbolic-link file: ${relativePath}`);
    }
    return { relativePath, path, mode: info.mode & 0o777 };
  });

  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const resolvedBackupRoot = realpathSync(backupRoot);
  const backupPath = mkdtempSync(join(resolvedBackupRoot, `update-${version.replace(/[^A-Za-z0-9._+-]/g, '_')}-`));
  chmodSync(backupPath, 0o700);
  const previousFiles: Array<{ path: string; sha256: string }> = [];
  try {
    for (const target of targets) {
      const destination = join(backupPath, ...target.relativePath.split('/'));
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(target.path, destination);
      chmodSync(destination, 0o600);
      previousFiles.push({ path: target.relativePath, sha256: sha256(readFileSync(destination)) });
    }
    writeFileSync(join(backupPath, 'manifest.json'), `${JSON.stringify({
      version,
      createdAt: new Date().toISOString(),
      files: previousFiles,
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    rmSync(backupPath, { recursive: true, force: true });
    throw new Error(`Could not create a complete update backup: ${message(error)}`);
  }

  const replaced: typeof targets = [];
  try {
    for (const target of targets) {
      replaceFile(target.path, files.get(target.relativePath)!, target.mode);
      replaced.push(target);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const target of replaced.reverse()) {
      try {
        replaceFile(target.path, readFileSync(join(backupPath, ...target.relativePath.split('/'))), target.mode);
      } catch (rollbackError) {
        rollbackErrors.push(`${target.relativePath}: ${message(rollbackError)}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `Update failed and rollback was incomplete; restore files from ${backupPath}. `
        + `Update error: ${message(error)}. Rollback errors: ${rollbackErrors.join('; ')}`,
      );
    }
    throw new Error(`Update failed; previous files were restored. Backup retained at ${backupPath}. ${message(error)}`);
  }

  return { backupPath, files: targets.length };
}

function validateReleaseManifests(files: Map<string, Buffer>, expectedVersion: string): void {
  for (const name of ['package.json', 'plugin.json']) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(files.get(name)!.toString('utf8'));
    } catch {
      throw new Error(`Update archive has an invalid ${name}`);
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error(`Update archive has an invalid ${name}`);
    }
    const record = manifest as Record<string, unknown>;
    if (record['name'] !== PLUGIN_PACKAGE_NAME || record['version'] !== expectedVersion) {
      throw new Error(`Update archive ${name} does not match the selected QQ Guardian release`);
    }
  }
}

function replaceFile(destination: string, contents: Buffer, mode: number): void {
  const temporary = join(dirname(destination), `.qq-guardian-update-${process.pid}-${randomSuffix()}.tmp`);
  try {
    writeFileSync(temporary, contents, { flag: 'wx', mode });
    chmodSync(temporary, mode);
    renameSync(temporary, destination);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function randomSuffix(): string {
  return randomUUID();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
