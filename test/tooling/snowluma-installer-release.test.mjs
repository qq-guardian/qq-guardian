import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// Keep this contract test intentionally close to the release workflow and upstream manifest
const ROOT=join(import.meta.dirname,'../..');
const release=readFileSync(join(ROOT,'.github/workflows/release.yml'),'utf8');
const manifest=JSON.parse(readFileSync(join(ROOT,'UPSTREAM-SNOWLUMA.json'),'utf8'));
for(const p of ['win-x64','linux-x64','linux-arm64']){assert.ok(manifest.platforms[p].full.file);assert.ok(Number.isInteger(manifest.platforms[p].full.size));assert.match(manifest.platforms[p].full.sha256,/^[a-f0-9]{64}$/);assert.match(release,new RegExp('platform: '+p));}
assert.match(release,/package-snowluma-installer\.mjs/);assert.match(release,/verify-snowluma-installer\.mjs/);assert.doesNotMatch(release,/package-snowluma\.mjs/);
for(const f of ['scripts/package-snowluma-installer.mjs','scripts/verify-snowluma-installer.mjs','deploy/native/snowluma-install.ps1','deploy/native/snowluma-install.sh','deploy/native/start-snowluma-guardian.ps1','deploy/native/start-snowluma-guardian.sh','deploy/native/unattended-docker.sh'])assert.equal(existsSync(join(ROOT,f)),true,f);
assert.equal(manifest.nativeBinariesRedistributed,false);
assert.equal(manifest.distributionBoundary,'official-release-input-only');
