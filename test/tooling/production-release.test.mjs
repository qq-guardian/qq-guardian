import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

const root = join(process.cwd());
const script = join(root, 'scripts');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const output = mkdtempSync(join(tmpdir(), 'qq-guardian-release-'));
after(() => rmSync(output, { recursive: true, force: true }));

function run(name, args) {
  const result = spawnSync(process.execPath, [join(script, name), ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${name} failed:\n${result.stdout}\n${result.stderr}`);
}

describe('production release packaging', () => {
  it('builds and verifies a complete Linux production archive', () => {
    run('build.mjs', []);
    run('package-production.mjs', [`--platform=linux-x64`, `--runtime=${process.execPath}`, `--output-dir=${output}`]);
    run('verify-production-package.mjs', [`--directory=${output}`]);
    const archive = join(output, `qq-guardian-v${version}-linux-x64.tar.gz`);
    const checksum = `${archive}.sha256`;
    assert.equal(existsSync(archive), true);
    assert.equal(existsSync(checksum), true);
    const checksumText = readFileSync(checksum, 'utf8');
    assert.match(checksumText, /^[a-f0-9]{64}  /);
    assert.equal(checksumText.split('  ')[1], 'qq-guardian-v' + version + '-linux-x64.tar.gz\n');

    const extraction = mkdtempSync(join(tmpdir(), 'qq-guardian-release-extract-'));
    const prefix = mkdtempSync(join(tmpdir(), 'qq-guardian-install-prefix-'));
    try {
      const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
      assert.equal(listing.status, 0, listing.stderr);
      const packageName = listing.stdout.trim().split('\n')[0]?.split('/')[0];
      assert.ok(packageName, 'archive must have a single package root');
      const unpack = spawnSync('tar', ['-xzf', archive, '-C', extraction], { encoding: 'utf8' });
      assert.equal(unpack.status, 0, unpack.stderr);
      const packageRoot = join(extraction, packageName);
      const installer = join(packageRoot, 'install.sh');
      const install = spawnSync('sh', [installer, '--yes'], {
        cwd: root,
        env: { ...process.env, PREFIX: prefix },
        encoding: 'utf8',
      });
      assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
      assert.equal(readlinkSync(join(prefix, 'current')), join(prefix, 'releases', `v${version}`));

      const releaseTarget = join(prefix, 'releases', 'v0.1.0');
      mkdirSync(releaseTarget, { recursive: true });
      writeFileSync(join(releaseTarget, 'sentinel'), 'keep', 'utf8');
      rmSync(join(prefix, 'current'));
      symlinkSync(releaseTarget, join(prefix, 'current'));

      const manifestPath = join(packageRoot, 'RELEASE-MANIFEST.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '../../outside' }), 'utf8');
      const hostilePrefix = join(extraction, 'hostile-install');
      const hostileInstall = spawnSync('sh', [installer, '--yes'], {
        cwd: root,
        env: { ...process.env, PREFIX: hostilePrefix },
        encoding: 'utf8',
      });
      assert.notEqual(hostileInstall.status, 0, 'installer must reject path-like release versions');
      assert.equal(existsSync(hostilePrefix), false, 'version validation must happen before filesystem writes');

      const hostileArchive = join(extraction, 'hostile.tar.gz');
      const repack = spawnSync('tar', ['-czf', hostileArchive, packageName], {
        cwd: extraction,
        encoding: 'utf8',
      });
      assert.equal(repack.status, 0, repack.stderr);
      const updater = join(packageRoot, 'updater', 'update.sh');
      assert.equal(existsSync(updater), true, 'archive must include its generated updater');
      const hostileUpdate = spawnSync('sh', [updater, hostileArchive], {
        cwd: root,
        env: { ...process.env, QQ_GUARDIAN_PREFIX: prefix },
        encoding: 'utf8',
      });
      assert.notEqual(hostileUpdate.status, 0, 'updater must reject path-like release versions');
      assert.equal(readlinkSync(join(prefix, 'current')), releaseTarget);
      assert.equal(readFileSync(join(releaseTarget, 'sentinel'), 'utf8'), 'keep');
    } finally {
      rmSync(extraction, { recursive: true, force: true });
      rmSync(prefix, { recursive: true, force: true });
    }
  });

  it('keeps deployment entry points canonical', () => {
    for (const path of ['Dockerfile','docker-compose.yml','entrypoint.sh','healthcheck.sh','install.sh','update.sh','uninstall.sh','verify.sh']) {
      assert.equal(existsSync(join(root, path)), true, path);
    }
    assert.equal(existsSync(join(root, 'deploy', 'Dockerfile')), false);
    assert.equal(existsSync(join(root, 'deploy', 'compose.yaml')), false);
    assert.equal(existsSync(join(root, 'deploy', 'compose.https.yaml')), true);
    const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
    const httpsOverlay = readFileSync(join(root, 'deploy', 'compose.https.yaml'), 'utf8');
    const caddyfile = readFileSync(join(root, 'deploy', 'Caddyfile'), 'utf8');
    assert.match(compose, /^  qq-guardian:/m);
    assert.match(httpsOverlay, /depends_on:\s*\n\s+qq-guardian:/);
    assert.match(caddyfile, /reverse_proxy qq-guardian:6099/);
    const production = readFileSync(join(root, 'scripts', 'package-production.mjs'), 'utf8');
    assert.match(production, /QQ_GUARDIAN_NON_INTERACTIVE=1/);
    assert.equal(production.indexOf('TARGET="$PREFIX/releases/$VERSION"') >= 0, true);
    assert.equal(production.includes('sort -Vr'), true);
    assert.equal(production.includes("source: 'provided-runtime'"), true);
    const releaseWorkflow = readFileSync(join(root, '.github/workflows/github-release.yml'), 'utf8');
    assert.equal(releaseWorkflow.includes('release/*.sha256'), true);
    assert.equal(production.includes('linux-arm64'), true);
    assert.equal(production.includes('Register-ScheduledTask'), true);
    assert.equal(production.includes('Sort-Object { [version]$_.Name.TrimStart(\'v\') }'), true);
    const install = readFileSync(join(root, 'install.sh'), 'utf8');
    const update = readFileSync(join(root, 'update.sh'), 'utf8');
    assert.equal(install.includes('PLATFORM=linux-arm64'), true);
    assert.equal(update.includes('PLATFORM=linux-arm64'), true);
  });
});
