import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkDocumentationLinks } from '../../scripts/check-doc-links.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('all repository-local Markdown links resolve', () => {
  assert.deepEqual(checkDocumentationLinks({ root: ROOT }), []);
});
