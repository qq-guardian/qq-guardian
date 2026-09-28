import test from 'node:test';
import assert from 'node:assert/strict';
import { withLock } from '../../src/core/locks.ts';

test('withLock queues same-name work in FIFO order and releases after failure', async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = withLock('approval:one', async () => {
    order.push('first:start');
    await firstGate;
    order.push('first:end');
  });
  const second = withLock('approval:one', async () => {
    order.push('second');
  });

  assert.deepEqual(order, ['first:start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);

  await assert.rejects(
    withLock('approval:one', async () => {
      throw new Error('expected');
    }),
    /expected/
  );

  await withLock('approval:one', async () => {
    order.push('after-error');
  });
  assert.equal(order.at(-1), 'after-error');
});

test('withLock does not serialize unrelated keys', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let secondStarted = false;

  const first = withLock('approval:first', async () => {
    await gate;
  });
  const second = withLock('approval:second', async () => {
    secondStarted = true;
  });

  await second;
  assert.equal(secondStarted, true);
  release();
  await first;
});
