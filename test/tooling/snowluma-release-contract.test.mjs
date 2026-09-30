import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('SnowLuma provider release follows the official platform/flavor matrix', () => {
  const upstream = JSON.parse(readFileSync(join(ROOT, 'UPSTREAM-SNOWLUMA.json'), 'utf8'));
  const release = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');

  assert.equal(upstream.officialRelease, 'v1.14.20');
  assert.equal(upstream.nativeBinariesRedistributed, false);
  assert.deepEqual(Object.keys(upstream.platforms).sort(), ['linux-arm64', 'linux-x64', 'win-x64']);

  for (const token of [
    'platform: win-x64',
    'platform: linux-x64',
    'platform: linux-arm64',
    'node scripts/package-snowluma.mjs --platform=\${{ matrix.platform }} --flavor=lite',
    'node scripts/package-snowluma.mjs --platform=\${{ matrix.platform }} --flavor=full',
    'verify-snowluma-provider-layout.mjs',
  ]) {
    assert.ok(release.includes(token), 'release workflow is missing: ' + token);
  }

  assert.equal(release.includes('package-project.mjs'), false);
  assert.equal(release.includes('releaseDownload.zip'), false);
});

test('provider packaging and unattended launch assets are tracked', () => {
  for (const path of [
    'scripts/package-snowluma.mjs',
    'scripts/verify-snowluma-provider-layout.mjs',
    'deploy/native/unattended-start.ps1',
    'deploy/native/unattended-start.sh',
  ]) {
    assert.equal(existsSync(join(ROOT, path)), true, 'missing release asset: ' + path);
  }

  const compose = readFileSync(join(ROOT, 'deploy', 'compose.yaml'), 'utf8');
  assert.ok(compose.includes('motricseven7/snowluma:1.14.20'));
  assert.ok(compose.includes('SNOWLUMA_ACCEPT_EULA'));
  assert.ok(compose.includes('SNOWLUMA_ACCEPT_PRIVACY'));

  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.engines.node, '^22.13.0 || >=23.4.0');
});

test('runtime defaults use the canonical repository', () => {
  const source = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8');
  assert.equal(source.includes('ShiYuPIay/napcat-plugin-qq-guardian'), false);
  assert.ok(source.includes('qq-guardian/qq-guardian'));
});
