import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { assertEnvironment } from '../../scripts/github-environments.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const deploy = readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8');
const deployRelease = readFileSync(join(root, '.github/workflows/deploy-release.yml'), 'utf8');
const rollback = readFileSync(join(root, '.github/workflows/rollback.yml'), 'utf8');
const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');

describe('immutable deployment control plane', () => {
  it('builds at most one tagged OCI image and promotes only its immutable digest', () => {
    assert.equal((deploy.match(/docker\/build-push-action@/g) ?? []).length, 1);
    assert.match(deploy, /Build and push the immutable image once/);
    assert.match(deploy, /if: steps\.existing\.outputs\.reuse != 'true'/);
    assert.match(deploy, /tags: \$\{\{ needs\.metadata\.outputs\.image \}\}:\$\{\{ needs\.metadata\.outputs\.tag \}\}/);
    assert.match(deploy, /imagetools create --tag "\$IMAGE:staging" "\$IMAGE@\$DIGEST"/);
    assert.match(deploy, /imagetools create --tag "\$IMAGE:production" "\$IMAGE@\$DIGEST"/);
    assert.match(deploy, /assert-promotion/);
    assert.match(deploy, /environment: staging/);
    assert.match(deploy, /environment: production/);
    assert.match(deploy, /group: production-deployment/);
    assert.match(deploy, /External user-owned NapCat\/SnowLuma hosts: `not executed`/);
  });

  it('binds every deployment entry point to the published gated release identity', () => {
    assert.match(deployRelease, /^\s*release:\s*$/m);
    assert.match(deployRelease, /types:\s*\n\s*- published/);
    assert.match(deployRelease, /github\.event\.release\.draft/);
    assert.match(deployRelease, /github\.event\.release\.prerelease/);
    assert.match(deployRelease, /commits\/\$tag|commits\/\$TAG/);
    assert.match(deployRelease, /uses: \.\/\.github\/workflows\/deploy\.yml/);
    assert.match(deployRelease, /secrets: inherit/);

    assert.match(deploy, /Resolve and authenticate published release identity/);
    assert.match(deploy, /releases\/tags\/\$tag/);
    assert.match(deploy, /\.draft/);
    assert.match(deploy, /\.prerelease/);
    assert.match(deploy, /published_at/);
    assert.match(deploy, /commits\/\$tag/);
    assert.match(deploy, /release\/version-\$\{tag#v\}/);
    assert.match(deploy, /commits\/\$source_sha\/pulls/);
    assert.match(deploy, /\.base\.ref == \\"main\\"/);
    assert.match(deploy, /\.merged_at != null/);
    assert.match(release, /startsWith\(github\.event\.pull_request\.head\.ref, 'release\/version-'\)/);
  });

  it('resumes only an exact already-published immutable image and manifest', () => {
    assert.match(deploy, /Resolve resumable versioned image state/);
    assert.match(deploy, /org\.opencontainers\.image\.revision/);
    assert.match(deploy, /org\.opencontainers\.image\.version/);
    assert.match(deploy, /Reusing immutable versioned image/);
    assert.match(deploy, /Unable to distinguish a missing image from a registry failure; refusing to overwrite/);
    assert.match(deploy, /Reconcile immutable image manifest/);
    assert.match(deploy, /verify-image/);
    assert.match(deploy, /Existing deployment manifest does not match the immutable release identity/);
    assert.match(deploy, /gh release upload "\$TAG" "guardian-image-\$TAG\.json" --clobber/);
    assert.match(deploy, /guardian-image-\$\{\{ needs\.metadata\.outputs\.tag \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  });

  it('keeps rollback one-click, bounded, auditable, and build-free', () => {
    assert.match(rollback, /default: previous/);
    assert.match(rollback, /history_depth/);
    assert.match(rollback, /resolve-rollback-target\.mjs/);
    assert.match(rollback, /Smoke the exact target digest before promotion/);
    assert.match(rollback, /deployment-record\.mjs record/);
    assert.match(rollback, /deployment-rollback-/);
    assert.doesNotMatch(rollback, /docker\/build-push-action/);
    assert.doesNotMatch(rollback, /docker build(?!x)/);
    assert.doesNotMatch(rollback, /pnpm (?:install|build)/);
    assert.match(rollback, /imagetools create --tag "\$IMAGE:production" "\$IMAGE@\$TARGET_DIGEST"/);
    assert.match(rollback, /imagetools create --tag "\$IMAGE:production" "\$IMAGE@\$PREVIOUS_DIGEST"/);
  });

  it('requires protected branches and an explicit production reviewer policy', () => {
    assert.doesNotThrow(() => assertEnvironment('staging', {
      deployment_branch_policy: { protected_branches: true },
      protection_rules: [],
    }, { protectedBranches: true }));
    assert.doesNotThrow(() => assertEnvironment('production', {
      deployment_branch_policy: { protected_branches: true },
      protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', id: 123 }] }],
    }, { protectedBranches: true }));
    assert.throws(() => assertEnvironment('production', {
      deployment_branch_policy: { protected_branches: true },
      protection_rules: [],
    }, { protectedBranches: true }), /required environment reviewer/);
  });

  it('pins every third-party action in release deployment workflows', () => {
    for (const workflow of [deploy, deployRelease, rollback]) {
      for (const action of [...workflow.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)].map((match) => match[1])) {
        if (action.startsWith('./')) continue;
        assert.match(action, /@[a-f0-9]{40}$/, `action must be commit-pinned: ${action}`);
      }
    }
  });
});
