import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it } from 'node:test';
import { ConfigManager } from '../../src/core/config/index.ts';
import { validatePersistedApprovalPatterns } from '../../src/core/config/schema.ts';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

it('does not persist an unsafe approval pattern through an asynchronous config update', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guardian-config-validation-'));
  roots.push(root);
  const manager = new ConfigManager();
  manager.init(root);
  const configPath = join(root, 'config.json');
  const before = readFileSync(configPath, 'utf8');

  await assert.rejects(
    manager.updateValidated({
      approval: {
        groups: {
          '123456': { approvePatterns: ['a{100}(a|aa)+$'] },
        },
      },
    }, validatePersistedApprovalPatterns),
    /ambiguous quantified alternation/,
  );

  assert.equal(readFileSync(configPath, 'utf8'), before);
  assert.equal(manager.get().approval.groups['123456'], undefined);
});
