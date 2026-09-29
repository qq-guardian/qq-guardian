import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANONICAL_REPO = 'https://github.com/qq-guardian/qq-guardian';
const CANONICAL_RELEASES = `${CANONICAL_REPO}/releases/latest`;

test('repository metadata and release links use the canonical repository', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const distPackageJson = JSON.parse(readFileSync(join(ROOT, 'dist', 'package.json'), 'utf8'));
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const deploymentGuide = readFileSync(join(ROOT, 'docs', 'deployment', 'snowluma.md'), 'utf8');

  assert.equal(packageJson.homepage, CANONICAL_REPO);
  assert.equal(packageJson.repository.url, `${CANONICAL_REPO}.git`);
  assert.equal(packageJson.napcat.homepage, CANONICAL_REPO);
  assert.equal(distPackageJson.homepage, CANONICAL_REPO);
  assert.equal(distPackageJson.napcat.homepage, CANONICAL_REPO);
  assert.ok(readme.includes(CANONICAL_RELEASES));
  assert.ok(deploymentGuide.includes(CANONICAL_RELEASES));
  assert.equal(readme.includes('https://github.com/ShiYuPIay/qq-guardian/releases/latest'), false);
  assert.equal(deploymentGuide.includes('https://github.com/ShiYuPIay/napcat-plugin-qq-guardian/releases/latest'), false);
});
