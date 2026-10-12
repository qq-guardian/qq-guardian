import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { verifyActionPins } from '../../scripts/lib/ci-governance.mjs';

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

  it('pins every external workflow Action to a reviewed immutable commit', () => {
    for (const path of workflows) {
      const source = readFileSync(join(root, path), 'utf8');
      assert.deepEqual(verifyActionPins(source), [], path);
    }
  });

  it('rejects mutable tags and unreviewed commit SHAs', () => {
    const mutable = verifyActionPins('steps:\n  - uses: actions/checkout@v6');
    assert.match(mutable[0] ?? '', /immutable 40-character commit SHA/);

    const unreviewed = verifyActionPins(`steps:\n  - uses: example/action@${'a'.repeat(40)}`);
    assert.match(unreviewed[0] ?? '', /not in the reviewed pin allowlist/);
  });

  it('uses explicit read-only permissions for validation workflows', () => {
    for (const path of workflows.slice(0, 3)) {
      const source = readFileSync(join(root, path), 'utf8');
      assert.match(source, /permissions:\n  contents: read/);
      assert.match(source, /actions\/checkout@[0-9a-f]{40} # v6/);
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
    assert.match(release, /actions\/attest@[0-9a-f]{40} # v4/);
  });

  it('keeps Docker publication independent and multi-architecture', () => {
    const source = readFileSync(join(root, '.github/workflows/docker-release.yml'), 'utf8');
    assert.match(source, /platforms: linux\/amd64,linux\/arm64/);
    assert.match(source, /packages: write/);
    assert.match(source, /actions\/attest@[0-9a-f]{40} # v4/);
  });

  it('runs browser smoke tests against an automatically started deterministic WebUI fixture', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.scripts['test:webui'], 'playwright test --config=playwright.config.ts');
    const config = readFileSync(join(root, 'playwright.config.ts'), 'utf8');
    assert.match(config, /scripts\/webui-smoke-server\.mjs/);
    assert.match(config, /webServer:/);
    const workflow = readFileSync(join(root, '.github/workflows/test.yml'), 'utf8');
    assert.match(workflow, /pnpm exec playwright install --with-deps chromium/);
    assert.match(workflow, /pnpm run test:webui/);
  });
});
