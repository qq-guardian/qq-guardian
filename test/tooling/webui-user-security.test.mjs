import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(join(ROOT, 'webui/user-security.js'), 'utf8');
const context = {};
runInNewContext(source, context, { filename: 'webui/user-security.js' });
const security = context.QQGuardianUserSecurity;

describe('WebUI user mutation guard', () => {
  it('disables deleting the signed-in account', () => {
    assert.deepEqual(
      { ...security.deleteState({ id: 7, is_usable_super_admin: true }, 7, 2) },
      { disabled: true, reason: 'self' },
    );
  });

  it('disables deleting the final usable super administrator', () => {
    assert.deepEqual(
      { ...security.deleteState({ id: 7, is_usable_super_admin: true }, 3, 1) },
      { disabled: true, reason: 'last_usable_super_admin' },
    );
  });

  it('allows mutations that leave a usable administrator behind', () => {
    assert.deepEqual(
      { ...security.deleteState({ id: 7, is_usable_super_admin: true }, 3, 2) },
      { disabled: false, reason: null },
    );
    assert.deepEqual(
      { ...security.deleteState({ id: 8, is_usable_super_admin: false }, 3, 1) },
      { disabled: false, reason: null },
    );
  });
});
