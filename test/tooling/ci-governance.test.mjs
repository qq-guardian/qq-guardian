import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = process.cwd();
const workflows = [
  '.github/workflows/build.yml',
  '.github/workflows/test.yml',
  '.github/workflows/build-native.yml',
  '.github/workflows/package-windows.yml',
  '.github/workflows/package-linux.yml',
  '.github/workflows/docker-release.yml',
  '.github/workflows/github-release.yml',
];

describe('production workflow governance', () => {
  it('keeps exactly the seven production workflows', () => {
    for (const path of workflows) assert.equal(existsSync(join(root, path)), true, path);
    for (const path of [
      '.github/workflows/ci.yml',
      '.github/workflows/release.yml',
      '.github/workflows/release-request.yml',
      '.github/workflows/deploy.yml',
      '.github/workflows/deploy-release.yml',
      '.github/workflows/rollback.yml',
    ]) assert.equal(existsSync(join(root, path)), false, path);
  });

  it('uses explicit read-only permissions for validation workflows', () => {
    for (const path of workflows.slice(0, 3)) {
      const source = readFileSync(join(root, path), 'utf8');
      assert.match(source, /permissions:\n  contents: read/);
      assert.match(source, /actions\/checkout@v6/);
    }
  });

  it('keeps packaging reusable and release publication separate', () => {
    const windows = readFileSync(join(root, '.github/workflows/package-windows.yml'), 'utf8');
    const linux = readFileSync(join(root, '.github/workflows/package-linux.yml'), 'utf8');
    const release = readFileSync(join(root, '.github/workflows/github-release.yml'), 'utf8');
    assert.match(windows, /workflow_call:/);
    assert.match(linux, /workflow_call:/);
    assert.match(release, /uses: \.\/\.github\/workflows\/package-windows\.yml/);
    assert.match(release, /uses: \.\/\.github\/workflows\/package-linux\.yml/);
    assert.match(release, /actions\/attest@v4/);
  });

  it('keeps Docker publication independent and multi-architecture', () => {
    const source = readFileSync(join(root, '.github/workflows/docker-release.yml'), 'utf8');
    assert.match(source, /platforms: linux\/amd64,linux\/arm64/);
    assert.match(source, /packages: write/);
    assert.match(source, /actions\/attest@v4/);
  });
});
