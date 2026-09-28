import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { createHash, randomUUID } from 'crypto';
import { dirname, join, relative, resolve } from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { MigrationArtifact, ShadowMigrationJournal } from './types.ts';
import { ShadowMigrationError } from './types.ts';

const HASH_BUFFER_SIZE = 1024 * 1024;

/** Some Windows/virtual filesystems reject fsync on an otherwise valid file. */
function syncBestEffort(fd: number): void {
  try {
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
  }
}

export function assertPathInside(root: string, path: string, label: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const relation = relative(resolvedRoot, resolvedPath);
  if (relation === '..' || relation.startsWith('..\\') || relation.startsWith('../') || relation === '') {
    if (relation === '') return resolvedPath;
    throw new ShadowMigrationError(`${label} must remain within ${resolvedRoot}`);
  }
  if (relation.startsWith('..') || resolve(resolvedRoot, relation) !== resolvedPath) {
    throw new ShadowMigrationError(`${label} must remain within ${resolvedRoot}`);
  }
  return resolvedPath;
}

export function ensureRegularFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new ShadowMigrationError(`${label} does not exist as a regular file: ${path}`);
  }
}

export function sha256File(path: string): string {
  const fd = openSync(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_SIZE);
  try {
    let offset = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

export function describeArtifact(path: string): MigrationArtifact {
  ensureRegularFile(path, 'artifact');
  return { path: resolve(path), sha256: sha256File(path), bytes: statSync(path).size };
}

export function verifyArtifact(artifact: MigrationArtifact, label: string): void {
  ensureRegularFile(artifact.path, label);
  const bytes = statSync(artifact.path).size;
  const hash = sha256File(artifact.path);
  if (bytes !== artifact.bytes || hash !== artifact.sha256) {
    throw new ShadowMigrationError(`${label} no longer matches its verified checksum`);
  }
}

export function artifactMatches(path: string, expected: MigrationArtifact): boolean {
  try {
    const actual = describeArtifact(path);
    return actual.bytes === expected.bytes && actual.sha256 === expected.sha256;
  } catch {
    return false;
  }
}

export function writeFileAtomically(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.${process.pid}.tmp`);
  let fd: number | undefined;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    fd = openSync(temporary, 'r+');
    syncBestEffort(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // The original error is more useful than best-effort temporary cleanup.
    }
    throw error;
  }
}

export function writeJsonAtomically(path: string, value: unknown): void {
  writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function copyArtifact(source: string, destination: string, label: string): MigrationArtifact {
  ensureRegularFile(source, label);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  try {
    chmodSync(destination, 0o600);
  } catch {
    // Windows and some mounted filesystems do not expose POSIX file modes.
  }
  const copied = describeArtifact(destination);
  const original = describeArtifact(source);
  if (copied.bytes !== original.bytes || copied.sha256 !== original.sha256) {
    throw new ShadowMigrationError(`${label} copy did not match the source checksum`);
  }
  return copied;
}

/** Uses SQLite's own snapshot facility so WAL state is included safely. */
export function snapshotDatabase(source: string, destination: string): MigrationArtifact {
  ensureRegularFile(source, 'database source');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (existsSync(destination)) unlinkSync(destination);
  const db = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
  try {
    const escapedDestination = resolve(destination).replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escapedDestination}'`);
  } finally {
    db.close();
  }
  try {
    chmodSync(destination, 0o600);
  } catch {
    // Windows and some mounted filesystems do not expose POSIX file modes.
  }
  return describeArtifact(destination);
}

/** Replaces a single target only after an on-disk local temporary copy exists. */
export function replaceFromArtifact(source: string, target: string, label: string): MigrationArtifact {
  ensureRegularFile(source, label);
  const temporary = join(dirname(target), `.${randomUUID()}.${process.pid}.next`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  try {
    copyFileSync(source, temporary);
    const fd = openSync(temporary, 'r+');
    try {
      syncBestEffort(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, target);
    try {
      chmodSync(target, 0o600);
    } catch {
      // Windows and some mounted filesystems do not expose POSIX file modes.
    }
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // Preserve the replacement error.
    }
    throw new ShadowMigrationError(`Could not replace ${label}: ${String(error)}`, { cause: error });
  }
  return describeArtifact(target);
}

export function removeSqliteSidecars(databasePath: string): void {
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${databasePath}${suffix}`;
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
}

export function removeStagingDirectory(dataDir: string, stagingDir: string): void {
  const migrationRoot = assertPathInside(dataDir, join(dataDir, 'migration'), 'migration root');
  const resolvedStaging = assertPathInside(migrationRoot, stagingDir, 'staging directory');
  if (existsSync(resolvedStaging)) rmSync(resolvedStaging, { recursive: true, force: false });
}

export function writeJournal(path: string, journal: ShadowMigrationJournal): void {
  journal.updatedAt = new Date().toISOString();
  writeJsonAtomically(path, journal);
}

export function acquireMigrationLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const lockPath = join(dataDir, 'migration.lock');
  const createLock = (): number => openSync(lockPath, 'wx');
  let fd: number;
  try {
    fd = createLock();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;

    let holder: { pid?: unknown } = {};
    try {
      holder = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    } catch {
      // A torn stale lock has no live file descriptor because its writer closes it.
    }
    const pid = typeof holder.pid === 'number' && Number.isSafeInteger(holder.pid) && holder.pid > 0
      ? holder.pid
      : undefined;
    if (pid !== undefined) {
      try {
        process.kill(pid, 0);
        throw new ShadowMigrationError(`A Guardian migration is already running (pid ${pid})`);
      } catch (probeError) {
        if (probeError instanceof ShadowMigrationError) throw probeError;
        if ((probeError as NodeJS.ErrnoException).code === 'EPERM') {
          throw new ShadowMigrationError(`A Guardian migration lock is held by inaccessible pid ${pid}`);
        }
        if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
      }
    }
    if (pid === undefined && Date.now() - statSync(lockPath).mtimeMs < 30_000) {
      throw new ShadowMigrationError('A Guardian migration lock is being initialized; retry shortly');
    }
    const stalePath = join(dataDir, `migration.lock.stale-${Date.now()}-${randomUUID()}`);
    renameSync(lockPath, stalePath);
    fd = createLock();
  }

  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    syncBestEffort(fd);
  } finally {
    closeSync(fd);
  }
  return () => {
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {
      // A stale lock is recoverable on next startup; never mask a migration result.
    }
  };
}
