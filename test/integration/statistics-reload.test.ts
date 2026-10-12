import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { closeDatabase, getDatabase, openDatabase } from '../../src/database/index.ts';
import { runMigrations } from '../../src/database/migrations/index.ts';
import { statisticsRepo } from '../../src/database/repositories/statistics.ts';

const roots: string[] = [];

afterEach(() => {
  closeDatabase();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

it('does not carry ensured statistic rows across database lifecycle generations', () => {
  const root = mkdtempSync(join(tmpdir(), 'guardian-statistics-reload-'));
  roots.push(root);
  const first = join(root, 'first');
  const second = join(root, 'second');

  openDatabase(first);
  statisticsRepo.bump('777', 'approvals_total');
  closeDatabase();

  openDatabase(second);
  statisticsRepo.bump('777', 'approvals_total');
  const row = getDatabase().prepare(
    'SELECT approvals_total FROM stat_snapshots WHERE group_id = ?'
  ).get('777') as { approvals_total: number } | undefined;
  assert.equal(row?.approvals_total, 1);
});

it('merges historical duplicate global rows before adding the unique index', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES
        (1, 0), (2, 0), (3, 0), (4, 0), (5, 0), (6, 0);
      CREATE TABLE stat_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT,
        period TEXT NOT NULL,
        approvals_total INTEGER NOT NULL DEFAULT 0,
        approvals_passed INTEGER NOT NULL DEFAULT 0,
        approvals_rejected INTEGER NOT NULL DEFAULT 0,
        captchas_total INTEGER NOT NULL DEFAULT 0,
        captchas_passed INTEGER NOT NULL DEFAULT 0,
        punishments_total INTEGER NOT NULL DEFAULT 0,
        risk_detections INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(group_id, period)
      );
      INSERT INTO stat_snapshots(group_id, period, approvals_total, created_at)
        VALUES (NULL, '2026-10-12', 3, 100), (NULL, '2026-10-12', 4, 200);
    `);

    runMigrations(db);

    const rows = db.prepare(
      'SELECT approvals_total, created_at FROM stat_snapshots WHERE group_id IS NULL AND period = ?'
    ).all('2026-10-12') as Array<{ approvals_total: number; created_at: number }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.approvals_total, 7);
    assert.equal(rows[0]?.created_at, 100);
    assert.throws(
      () => db.prepare(
        'INSERT INTO stat_snapshots(group_id, period, created_at) VALUES (NULL, ?, ?)'
      ).run('2026-10-12', 300),
      /UNIQUE constraint failed/,
    );
  } finally {
    db.close();
  }
});

it('serializes competing connections and records every group/global statistics bump once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guardian-statistics-concurrent-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  openDatabase(dataDir);
  const workerUrl = new URL('../helpers/statistics-worker.ts', import.meta.url);
  const workers = [0, 1].map(() => new Worker(workerUrl, {
    execArgv: ['--experimental-strip-types'],
    workerData: { dataDir, groupId: '777', calls: 20 },
  }));

  await Promise.all(workers.map(async (worker) => {
    const [message] = await once(worker, 'message');
    assert.deepEqual(message, { type: 'ready' });
  }));
  const resultPromises = workers.map(async (worker) => (await once(worker, 'message'))[0] as {
    type: string; ok: boolean; message?: string;
  });
  const exitPromises = workers.map((worker) => once(worker, 'exit'));
  workers.forEach((worker) => worker.postMessage({ type: 'start' }));
  const results = await Promise.all(resultPromises);
  await Promise.all(exitPromises);

  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  const period = new Date().toISOString().slice(0, 10);
  const groupRows = getDatabase().prepare(
    'SELECT approvals_total FROM stat_snapshots WHERE group_id = ? AND period = ?'
  ).all('777', period) as Array<{ approvals_total: number }>;
  const globalRows = getDatabase().prepare(
    'SELECT approvals_total FROM stat_snapshots WHERE group_id IS NULL AND period = ?'
  ).all(period) as Array<{ approvals_total: number }>;
  assert.equal(groupRows.length, 1);
  assert.equal(groupRows[0]?.approvals_total, 40);
  assert.equal(globalRows.length, 1);
  assert.equal(globalRows[0]?.approvals_total, 40);
});
