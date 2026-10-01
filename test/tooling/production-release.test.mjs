import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const root = join(process.cwd());
const script = join(root, 'scripts');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const output = mkdtempSync(join(tmpdir(), 'qq-guardian-release-'));

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
    assert.match(readFileSync(checksum, 'utf8'), new RegExp(`^[a-f0-9]{64}  qq-guardian-v${version.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\    assert.match(readFileSync(checksum, 'utf8'), /^[a-f0-9]{64}  qq-guardian-v1\.4\.9-linux-x64\.tar\.gz\n$/);')}-linux-x64\\\\.tar\\\\.gz\\\\nimport assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const root = join(process.cwd());
const script = join(root, 'scripts');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const output = mkdtempSync(join(tmpdir(), 'qq-guardian-release-'));

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
));
  });

  it('keeps deployment entry points canonical', () => {
    for (const path of ['Dockerfile','docker-compose.yml','entrypoint.sh','healthcheck.sh','install.sh','update.sh','uninstall.sh','verify.sh']) {
      assert.equal(existsSync(join(root, path)), true, path);
    }
    assert.equal(existsSync(join(root, 'deploy', 'Dockerfile')), false);
    assert.equal(existsSync(join(root, 'deploy', 'compose.yaml')), false);
    const installer = readFileSync(join(root, 'scripts', 'package-production.mjs'), 'utf8');
    assert.match(installer, /Non-interactive install requires --yes or QQ_GUARDIAN_NON_INTERACTIVE=1/);
    assert.match(installer, /TARGET="\\$PREFIX\\/releases\\/\\$VERSION"/);
  });
});
