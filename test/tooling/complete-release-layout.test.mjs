import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';

const ROOT = join(import.meta.dirname, '../..');
const directory = mkdtempSync(join(tmpdir(), 'qq-guardian-release-contract-'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;

before(() => run('scripts/build.mjs'));
after(() => rmSync(directory, { recursive: true, force: true }));

describe('release archive contract', () => {
  it('packages deterministic NapCat archives', () => {
    run('scripts/package-provider-release.mjs', '--output-dir=' + directory);
    const zip = join(directory, 'napcat-plugin-qq-guardian-v' + version + '.zip');
    const tar = join(directory, 'napcat-plugin-qq-guardian-v' + version + '.tar.gz');
    assert.ok(existsSync(zip));
    assert.ok(existsSync(tar));
    assert.ok(statSync(zip).size > 0);
    assert.ok(statSync(tar).size > 0);
    assertSidecar(zip);
    assertSidecar(tar);
  });

  it('packages both SnowLuma flavors with deterministic platform assets', () => {
    for (const flavor of ['lite', 'full']) {
      run(
        'scripts/package-snowluma.mjs',
        '--output-dir=' + directory,
        '--platform=linux-x64',
        '--flavor=' + flavor,
        ...(flavor === 'full'
          ? (() => {
              const candidates = [join(process.execPath, '..', 'LICENSE'), join(process.execPath, '..', '..', 'LICENSE')];
              const license = candidates.find((path) => existsSync(path));
              return ['--node-binary=' + process.execPath, '--node-license=' + (license ?? (() => { throw new Error('Node.js LICENSE not found'); })())];
            })()
          : []),
      );
    }

    const lite = join(directory, 'qq-guardian-snowluma-v' + version + '-linux-x64-lite.tar.gz');
    const full = join(directory, 'qq-guardian-snowluma-v' + version + '-linux-x64.tar.gz');
    assert.ok(existsSync(lite));
    assert.ok(existsSync(full));
    assert.ok(statSync(full).size > statSync(lite).size);
    assertSidecar(lite);
    assertSidecar(full);

    run('scripts/verify-snowluma-provider-layout.mjs', '--directory=' + directory);
  });

  it('does not package an untracked secret into provider archives', () => {
    const secret = join(ROOT, 'src', '_release-private-config-fixture.json');
    writeFileSync(secret, '{"token":"must never enter a release archive"}\n');
    try {
      run(
        'scripts/package-snowluma.mjs',
        '--output-dir=' + directory,
        '--platform=linux-x64',
        '--flavor=lite',
      );
    } finally {
      rmSync(secret, { force: true });
    }

    const manifest = readFileSync(join(directory, 'qq-guardian-snowluma-v' + version + '-linux-x64-lite.tar.gz'));
    assert.equal(manifest.includes('must never enter a release archive'), false);
  });
});

function assertSidecar(archive) {
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  assert.equal(readFileSync(archive + '.sha256', 'utf8'), digest + '  ' + archive.split('/').at(-1) + '\n');
}

function run(script, ...args) {
  const result = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, script + ' failed:\n' + result.stdout + '\n' + result.stderr);
}
