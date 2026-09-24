import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { readTarGzipEntryNames, readZipEntryNames } from '../../scripts/lib/deterministic-zip.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = mkdtempSync(join(tmpdir(), 'qq-guardian-complete-release-'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const prefix = `qq-guardian-v${pkg.version}`;
before(() => runScript('scripts/build.mjs'));
after(() => rmSync(directory, { recursive: true, force: true }));

describe('complete release archive contract', () => {
  it('packages deterministic source-complete lite ZIP and TAR.GZ archives', () => {
    const untrackedSecret = join(ROOT, 'src', '_release-private-config-fixture.json');
    writeFileSync(untrackedSecret, '{"token":"must never enter a release archive"}\n');
    try {
      packageProject('--flavor=lite');
    } finally {
      rmSync(untrackedSecret, { force: true });
    }
    const zip = join(directory, `qq-guardian-v${pkg.version}-lite.zip`);
    const tar = join(directory, `qq-guardian-v${pkg.version}-lite.tar.gz`);
    const firstZip = readFileSync(zip);
    const firstTar = readFileSync(tar);
    packageProject('--flavor=lite');
    assert.deepEqual(readFileSync(zip), firstZip);
    assert.deepEqual(readFileSync(tar), firstTar);
    assert.deepEqual(readZipEntryNames(zip), readTarGzipEntryNames(tar));

    const relativeNames = readZipEntryNames(zip).map((name) => name.slice(prefix.length + 1));
    assert.equal(relativeNames.includes('src/_release-private-config-fixture.json'), false);
    for (const required of [
      'src/index.ts',
      'src/snowluma.ts',
      'dist/index.mjs',
      'dist/plugin.json',
      'dist-snowluma/index.mjs',
      'deploy/.env.example',
      'deploy/compose.yaml',
      'deploy/native/guardian.env.example',
      'docs/deployment/snowluma.md',
      'scripts/build.mjs',
      'package.json',
      'pnpm-lock.yaml',
    ]) assert.ok(relativeNames.includes(required), `missing ${required}`);
    assert.equal(relativeNames.some(isForbidden), false);
    runScript('scripts/verify-release-layout.mjs', `--archive=${zip}`);
    runScript('scripts/verify-release-layout.mjs', `--archive=${tar}`);

    runScript('scripts/package-provider-release.mjs', `--output-dir=${directory}`);
    for (const provider of [
      {
        archive: `napcat-plugin-qq-guardian-v${pkg.version}`,
        compatibility: 'napcat-plugin-qq-guardian',
        required: ['index.mjs', 'package.json', 'plugin.json'],
      },
      {
        archive: `qq-guardian-snowluma-v${pkg.version}`,
        compatibility: 'qq-guardian-snowluma',
        required: [
          'dist-snowluma/index.mjs',
          'deploy/Dockerfile',
          'deploy/compose.yaml',
          '.dockerignore',
          'docs/deployment/snowluma.md',
          'docs/security/super-admin-recovery.md',
        ],
      },
    ]) {
      const providerZip = join(directory, `${provider.archive}.zip`);
      const providerTar = join(directory, `${provider.archive}.tar.gz`);
      const compatibilityZip = join(directory, `${provider.compatibility}.zip`);
      const compatibilityTar = join(directory, `${provider.compatibility}.tar.gz`);
      assert.deepEqual(readZipEntryNames(providerZip), readTarGzipEntryNames(providerTar));
      assert.deepEqual(readFileSync(compatibilityZip), readFileSync(providerZip));
      assert.deepEqual(readFileSync(compatibilityTar), readFileSync(providerTar));
      assertSidecar(providerZip);
      assertSidecar(providerTar);
      assertSidecar(compatibilityZip);
      assertSidecar(compatibilityTar);
      const names = new Set(readZipEntryNames(providerZip));
      for (const required of provider.required) {
        assert.ok(names.has(required), `${provider.archive} is missing ${required}`);
      }
    }
  });

  it('packages a full runtime and makes releaseDownload.zip mirror it exactly', () => {
    const binary = join(directory, 'fixture-node');
    const license = join(directory, 'fixture-node-license');
    writeFileSync(binary, 'fixture runtime\n');
    writeFileSync(license, 'fixture license\n');
    const untrackedSecret = join(ROOT, '_release-secret-fixture.txt');
    writeFileSync(untrackedSecret, 'must never enter a release archive\n');
    try {
      packageProject(
        '--flavor=full',
        '--platform=fixture-x64',
        `--node-binary=${binary}`,
        `--node-license=${license}`,
        '--compatibility-asset',
      );
    } finally {
      rmSync(untrackedSecret, { force: true });
    }
    const versioned = join(directory, `qq-guardian-v${pkg.version}-full-fixture-x64.zip`);
    const compatibility = join(directory, 'releaseDownload.zip');
    assert.deepEqual(readFileSync(compatibility), readFileSync(versioned));
    const names = new Set(readZipEntryNames(versioned));
    assert.ok(names.has(`${prefix}/runtime/node/bin/node`));
    assert.ok(names.has(`${prefix}/runtime/node/LICENSE`));
    assert.ok(names.has(`${prefix}/runtime/node/runtime.json`));
    assert.ok(names.has(`${prefix}/.github/workflows/release.yml`));
    assert.ok(names.has(`${prefix}/.github/workflows/ci.yml`));
    assert.ok(names.has(`${prefix}/test/tooling/complete-release-layout.test.mjs`));
    assert.equal([...names].some((name) => name.includes('/.git/') || name.includes('/node_modules/')), false);
    assert.equal(names.has(`${prefix}/_release-secret-fixture.txt`), false);
    assert.equal([...names].some((name) => /(?:^|\/)\.env(?:$|\.)/.test(name) && !name.endsWith('.example')), false);
    runScript('scripts/verify-release-layout.mjs', `--archive=${versioned}`);
    runScript('scripts/verify-release-layout.mjs', `--archive=${compatibility}`);

    runScript('scripts/write-checksums.mjs', directory);
    runScript('scripts/verify-release-assets.mjs', directory);
  });
});

function packageProject(...args) {
  runScript('scripts/package-project.mjs', ...args, `--output-dir=${directory}`);
}

function assertSidecar(archive) {
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  assert.equal(readFileSync(`${archive}.sha256`, 'utf8'), `${digest}  ${basename(archive)}\n`);
}

function runScript(script, ...args) {
  const result = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${script} failed:\n${result.stdout}\n${result.stderr}`);
}

function isForbidden(name) {
  return name.startsWith('.git/')
    || name.startsWith('.github/')
    || name.startsWith('test/')
    || name.startsWith('node_modules/')
    || name.startsWith('release/')
    || name.includes('/node_modules/')
    || /(?:^|\/)\.env$/.test(name)
    || /\.(?:db|db-shm|db-wal|log|map)$/.test(name);
}
