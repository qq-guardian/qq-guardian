import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT=join(import.meta.dirname,'../..');
const verifier=readFileSync(join(ROOT,'scripts','verify-release-assets.mjs'),'utf8');

assert.match(verifier,/qq-guardian-snowluma-installer-/);
assert.match(verifier,/endsWith\('\-win-x64\.zip'\)/);
assert.match(verifier,/if \(zipName\.includes\('qq-guardian-snowluma-installer-'\)/);
assert.doesNotMatch(verifier,/snowluma-installer-v\\\\d/);
