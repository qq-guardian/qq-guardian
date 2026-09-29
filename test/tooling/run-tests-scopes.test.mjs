import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

function listScope(scope) {
  const result = spawnSync(process.execPath, ['scripts/run-tests.mjs', scope, '--list'], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `failed to list test scope ${scope}: ${result.stderr}`);

  return result.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => file.replaceAll('\\\\', '/'))
    .sort();
}

test('all scope is exactly the union of the Node test scopes', () => {
  const unit = listScope('unit');
  const integration = listScope('integration');
  const tooling = listScope('tooling');
  const all = listScope('all');

  const expected = [...new Set([...unit, ...integration, ...tooling])].sort();

  assert.deepEqual(all, expected);
  assert.equal(new Set(all).size, all.length);
});

test('all scope never includes Playwright WebUI specs', () => {
  const all = listScope('all');

  assert.ok(all.every((file) => !file.startsWith('test/webui/')));
});
