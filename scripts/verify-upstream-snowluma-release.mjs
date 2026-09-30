#!/usr/bin/env node
/**
 * Compare UPSTREAM-SNOWLUMA.json with the live SnowLuma GitHub Release.
 * This checks upstream metadata only; it does not download or redistribute assets.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manifest = JSON.parse(readFileSync(resolve('UPSTREAM-SNOWLUMA.json'), 'utf8'));
const tag = manifest.officialRelease.tag;
const raw = execFileSync('gh', [
  'api',
  `repos/SnowLuma/SnowLuma/releases/tags/${tag}`,
], { encoding: 'utf8' });
const release = JSON.parse(raw);

assert.equal(release.tag_name, tag, 'upstream release tag mismatch');

for (const [platform, descriptor] of Object.entries(manifest.platforms)) {
  const expected = descriptor.full;
  const asset = release.assets.find((candidate) => candidate.name === expected.file);
  assert.ok(asset, `official release is missing ${expected.file}`);
  assert.equal(asset.size, expected.size, `${expected.file} size differs from manifest`);

  if (typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')) {
    assert.equal(
      asset.digest.slice('sha256:'.length),
      expected.sha256,
      `${expected.file} GitHub asset digest differs from manifest`,
    );
  }
  console.log(`✓ ${platform}: ${expected.file} ${expected.size} bytes`);
}

console.log(`✓ UPSTREAM-SNOWLUMA.json matches the live SnowLuma ${tag} release metadata`);
