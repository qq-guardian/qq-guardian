import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const upstream = JSON.parse(readFileSync(join(ROOT, 'UPSTREAM-SNOWLUMA.json'), 'utf8'));
const linuxInstaller = readFileSync(join(ROOT, 'deploy', 'native', 'snowluma-install.sh'), 'utf8');
const windowsInstaller = readFileSync(join(ROOT, 'deploy', 'native', 'snowluma-install.ps1'), 'utf8');
const linuxStarter = readFileSync(join(ROOT, 'deploy', 'native', 'start-snowluma-guardian.sh'), 'utf8');
const windowsStarter = readFileSync(join(ROOT, 'deploy', 'native', 'start-snowluma-guardian.ps1'), 'utf8');
const systemd = readFileSync(join(ROOT, 'deploy', 'native', 'qq-guardian-snowluma.service'), 'utf8');
const packager = readFileSync(join(ROOT, 'scripts', 'package-snowluma-installer.mjs'), 'utf8');
const verifier = readFileSync(join(ROOT, 'scripts', 'verify-snowluma-installer.mjs'), 'utf8');

test('SnowLuma contract records the exact current official full assets', () => {
  assert.equal(upstream.officialRelease.tag, 'v1.14.20');
  assert.equal(upstream.platforms['win-x64'].full.size, 37841306);
  assert.equal(upstream.platforms['linux-x64'].full.size, 46367860);
  assert.equal(upstream.platforms['linux-arm64'].full.size, 45811604);
  for (const platform of ['win-x64', 'linux-x64', 'linux-arm64']) {
    assert.match(upstream.platforms[platform].full.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(upstream.nativeBinariesRedistributed, false);
  assert.equal(upstream.integrationPolicy.officialArchiveMustBeOperatorSupplied, true);
  assert.equal(upstream.verification.officialReleaseIsNeverRepublishedByQQGuardian, true);
});

test('integration installer never packages or extracts SnowLuma proprietary native binaries', () => {
  assert.match(packager, /native.*not.*copied/i);
  assert.match(verifier, /must not redistribute SnowLuma native binaries/);
  assert.match(linuxInstaller, /will not extract or copy it/);
  assert.match(windowsInstaller, /will not extract or copy it/);
  assert.doesNotMatch(linuxInstaller, /tar -xzf/);
  assert.doesNotMatch(windowsInstaller, /Expand-Archive/);
  assert.match(linuxInstaller, /--snowluma-root PATH/);
  assert.match(windowsInstaller, /SnowLumaRoot/);
});

test('Linux unattended mode installs a persistent supervisor', () => {
  assert.match(linuxInstaller, /systemctl enable --now qq-guardian-snowluma\.service/);
  assert.match(systemd, /Restart=always/);
  assert.match(linuxStarter, /SnowLuma or Guardian exited/);
  assert.match(linuxStarter, /"$SNOWLUMA_ROOT\/node" "$GUARDIAN_ROOT\/dist-snowluma\/index\.mjs"/);
});

test('Windows unattended mode registers and starts a persistent task', () => {
  assert.match(windowsInstaller, /Register-ScheduledTask/);
  assert.match(windowsInstaller, /Start-ScheduledTask/);
  assert.match(windowsStarter, /Start-Process/);
  assert.match(windowsStarter, /SnowLuma exited first/);
});
