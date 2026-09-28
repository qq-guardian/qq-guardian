import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(join(ROOT, 'webui/index.html'), 'utf8');

describe('WebUI OneBot identifier integrity', () => {
  it('uses decimal text controls for every provider-facing identifier', () => {
    for (const id of ['cfg-selfid', 'p-gid', 'p-uid', 'bl-uid', 'bl-gid']) {
      assert.match(
        source,
        new RegExp(`<input[^>]*type="text"[^>]*inputmode="numeric"[^>]*id="${id}"`),
        `${id} must remain a text input so browsers never parse it as a floating-point number`,
      );
    }
  });

  it('passes identifiers through as strings at every DOM and API boundary', () => {
    assert.match(source, /const gid = row\.dataset\.gid;/);
    assert.match(source, /userId:\$\('#bl-uid'\)\.value/);
    assert.match(source, /groupId:\$\('#bl-gid'\)\.value\|\|null/);
    assert.match(source, /core:\{selfId:\$\('#cfg-selfid'\)\.value\.trim\(\)\|\|'0'/);
    assert.match(source, /encodeURIComponent\(uid\)/);
    assert.match(source, /encodeURIComponent\(gid\)/);

    assert.doesNotMatch(source, /Number\(\$\('#cfg-selfid'\)/);
    assert.doesNotMatch(source, /Number\(row\.dataset\.gid\)/);
    assert.doesNotMatch(source, /Number\(btn\.dataset\.blUid\)/);
    assert.doesNotMatch(source, /Number\(\$\('#(?:p-gid|p-uid|bl-uid|bl-gid)'\)/);
  });
});
