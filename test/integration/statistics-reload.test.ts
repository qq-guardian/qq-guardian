import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getDatabase, openDatabase } from '../../src/database/index.ts';
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
