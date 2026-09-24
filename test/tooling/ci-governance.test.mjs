import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { clearArtifactOutputs } from '../../scripts/prepare-artifact-validation.mjs';
import {
  desiredBranchProtection,
  evaluateBranchProtection,
  REQUIRED_GATES,
  verifyCiGovernance,
} from '../../scripts/lib/ci-governance.mjs';
import { createGitHubRequester, readBranchProtectionState } from '../../scripts/lib/github-governance-api.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const dependabot = readFileSync(join(root, '.github', 'dependabot.yml'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('CI and repository governance', () => {
  it('keeps all required gates, reviewed action pins, and security controls', () => {
    assert.deepEqual(verifyCiGovernance({ workflow, dependabot, packageJson }), []);
  });

  it('rejects mutable action tags and a removed security scanner', () => {
    const mutable = workflow
      .replace('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/checkout@v7')
      .replace('gitleaks/gitleaks-action@', 'removed/gitleaks-action@');
    const errors = verifyCiGovernance({ workflow: mutable, dependabot, packageJson });
    assert.match(errors.join('\n'), /immutable 40-character commit SHA/);
    assert.match(errors.join('\n'), /missing required action gitleaks\/gitleaks-action/);
  });

  it('does not accept a required action that survives only in a YAML comment', () => {
    const commented = workflow.replace(
      '        uses: gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e # v3.0.0',
      '        # uses: gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e',
    );
    const errors = verifyCiGovernance({ workflow: commented, dependabot, packageJson }).join('\n');
    assert.match(errors, /missing required action gitleaks\/gitleaks-action/);
    assert.match(errors, /security: missing gitleaks\/gitleaks-action@/);
  });

  it('does not accept required shell commands that are only printed', () => {
    const weakened = workflow.replace(
      '        run: pnpm audit --prod --audit-level=high',
      "        run: echo 'pnpm audit --prod --audit-level=high'",
    );
    const errors = verifyCiGovernance({ workflow: weakened, dependabot, packageJson }).join('\n');
    assert.match(errors, /security: missing executable command pnpm audit --prod --audit-level=high/);
  });

  it('rejects a non-frozen install, persisted checkout token, and incomplete artifact', () => {
    const weakened = workflow
      .replace('pnpm install --frozen-lockfile', 'pnpm install')
      .replace('persist-credentials: false', 'persist-credentials: true')
      .replace('            release/', '            dist-only/');
    const errors = verifyCiGovernance({ workflow: weakened, dependabot, packageJson }).join('\n');
    assert.match(errors, /every CI install must enforce/);
    assert.match(errors, /every checkout step must set its own with\.persist-credentials to false/);
    assert.match(errors, /release\//);
  });

  it('rejects write authority outside the explicit per-job permission allowlist', () => {
    const weakened = workflow
      .replace(
        '  quality:\n    name: quality\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    permissions:\n      contents: read',
        '  quality:\n    name: quality\n    runs-on: ubuntu-latest\n    timeout-minutes: 10\n    permissions:\n      contents: write',
      )
      .replace('      security-events: write', '      issues: write');
    const errors = verifyCiGovernance({ workflow: weakened, dependabot, packageJson }).join('\n');
    assert.match(errors, /quality: unreviewed permission contents: write/);
    assert.match(errors, /security: unreviewed permission issues: write/);
    assert.match(errors, /security: permission security-events must be write/);
  });

  it('checks persist-credentials on each checkout step instead of accepting an unrelated count', () => {
    const weakened = workflow
      .replace('          persist-credentials: false', '          persist-credentials: true')
      .replace(
        '      - uses: pnpm/action-setup@',
        '      - name: Misleading unrelated value\n        env:\n          persist-credentials: false\n      - uses: pnpm/action-setup@',
      );
    const errors = verifyCiGovernance({ workflow: weakened, dependabot, packageJson }).join('\n');
    assert.match(errors, /every checkout step must set its own with\.persist-credentials to false/);
  });

  it('validates target branch and cadence inside each required Dependabot ecosystem entry', () => {
    const weakened = dependabot
      .replace(/(package-ecosystem:\s*npm[\s\S]*?target-branch:)\s*main/, '$1 develop')
      + '\n  - package-ecosystem: docker\n    directory: /\n    target-branch: main\n    schedule:\n      interval: weekly\n';
    const errors = verifyCiGovernance({ workflow, dependabot: weakened, packageJson }).join('\n');
    assert.match(errors, /Dependabot npm entry 1 must target main/);
  });

  it('builds an idempotent policy for the eight stable status contexts', () => {
    const desired = desiredBranchProtection();
    assert.deepEqual(desired.required_status_checks.contexts, REQUIRED_GATES);
    assert.equal(desired.required_pull_request_reviews.required_approving_review_count, 1);
    assert.deepEqual(desired.required_pull_request_reviews.bypass_pull_request_allowances, {
      users: [], teams: [], apps: [],
    });
    assert.equal(desired.enforce_admins, true);
    assert.equal(desired.allow_force_pushes, false);
  });

  it('reports branch-protection drift without mutating external state', () => {
    const desired = desiredBranchProtection();
    const compliant = {
      required_status_checks: { strict: true, contexts: desired.required_status_checks.contexts },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: {
        required_approving_review_count: 1,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        require_last_push_approval: true,
      },
      required_linear_history: { enabled: true },
      required_conversation_resolution: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      block_creations: { enabled: false },
      lock_branch: { enabled: false },
      allow_fork_syncing: { enabled: true },
      restrictions: null,
    };
    assert.deepEqual(evaluateBranchProtection(compliant, { enabled: true }), []);
    compliant.required_status_checks.contexts = ['quality'];
    assert.match(evaluateBranchProtection(compliant, { enabled: false }).join('\n'), /contract-snowluma/);
    assert.match(evaluateBranchProtection(compliant, { enabled: false }).join('\n'), /signed commits/);
  });

  it('reports unexpected required contexts as policy drift', () => {
    const desired = desiredBranchProtection();
    const protection = {
      required_status_checks: { strict: true, contexts: [...desired.required_status_checks.contexts, 'retired-gate'] },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: {
        required_approving_review_count: 1,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        require_last_push_approval: true,
      },
      required_linear_history: { enabled: true },
      required_conversation_resolution: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      block_creations: { enabled: false },
      lock_branch: { enabled: false },
      allow_fork_syncing: { enabled: true },
      restrictions: null,
    };
    assert.match(evaluateBranchProtection(protection, { enabled: true }).join('\n'), /unexpected required status check retired-gate/);
  });

  it('reports every configured pull-request review bypass as policy drift', () => {
    const desired = desiredBranchProtection();
    const protection = {
      required_status_checks: { strict: true, contexts: desired.required_status_checks.contexts },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: {
        required_approving_review_count: 1,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        require_last_push_approval: true,
        bypass_pull_request_allowances: { users: [{ login: 'bypass-user' }], teams: [], apps: [] },
      },
      required_linear_history: { enabled: true },
      required_conversation_resolution: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      block_creations: { enabled: false },
      lock_branch: { enabled: false },
      allow_fork_syncing: { enabled: true },
      restrictions: null,
    };
    assert.match(evaluateBranchProtection(protection, { enabled: true }).join('\n'), /review bypass.*users/);
  });

  it('reports an enabled branch lock, excessive approvals, and push restrictions as drift', () => {
    const desired = desiredBranchProtection();
    const protection = {
      required_status_checks: { strict: true, contexts: desired.required_status_checks.contexts },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: {
        required_approving_review_count: 2,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        require_last_push_approval: true,
      },
      required_linear_history: { enabled: true },
      required_conversation_resolution: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      block_creations: { enabled: false },
      lock_branch: { enabled: true },
      allow_fork_syncing: { enabled: true },
      restrictions: { users: [{ login: 'restricted-user' }], teams: [], apps: [] },
    };
    const errors = evaluateBranchProtection(protection, { enabled: true }).join('\n');
    assert.match(errors, /exactly one approving review/);
    assert.match(errors, /branch lock must be disabled/);
    assert.match(errors, /push restrictions differ from the reviewed setting/);
  });

  it('treats absent branch-protection resources as drift while preserving write failures', async () => {
    const calls = [];
    const request = createGitHubRequester({
      token: 'test-token',
      fetchImplementation: async (url, options) => {
        calls.push({ url, method: options.method ?? 'GET' });
        return { ok: false, status: 404, text: async () => 'Not Found' };
      },
    });
    const base = 'https://api.github.test/repos/owner/repository/branches/main/protection';
    const state = await readBranchProtectionState(base, request);
    assert.deepEqual(state, { protection: {}, signatures: {} });
    assert.equal(calls.length, 2);
    assert.match(evaluateBranchProtection(state.protection, state.signatures).join('\n'), /required status checks must be strict/);
    await assert.rejects(() => request(base, { method: 'PUT' }), /GitHub API PUT 404/);
  });

  it('clears checkout outputs and requires direct runtime manifests before artifact validation', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'guardian-artifact-validation-'));
    try {
      for (const directory of ['dist', 'dist-snowluma', 'release']) {
        mkdirSync(join(temporaryRoot, directory), { recursive: true });
        writeFileSync(join(temporaryRoot, directory, 'stale.txt'), 'stale');
      }
      writeFileSync(join(temporaryRoot, 'keep.txt'), 'keep');
      clearArtifactOutputs(temporaryRoot);
      assert.equal(existsSync(join(temporaryRoot, 'dist')), false);
      assert.equal(existsSync(join(temporaryRoot, 'dist-snowluma')), false);
      assert.equal(existsSync(join(temporaryRoot, 'release')), false);
      assert.equal(readFileSync(join(temporaryRoot, 'keep.txt'), 'utf8'), 'keep');
      assert.ok(workflow.indexOf('node scripts/prepare-artifact-validation.mjs') < workflow.indexOf('name: Download exact production outputs'));
      for (const required of [
        'test -f dist/index.mjs',
        'test -f dist/package.json',
        'test -f dist/plugin.json',
        'test -f dist-snowluma/index.mjs',
        'test -f dist-snowluma/package.json',
      ]) {
        assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
    } finally {
      const resolvedRoot = resolve(temporaryRoot);
      assert.equal(dirname(resolvedRoot), resolve(tmpdir()));
      rmSync(resolvedRoot, { recursive: true, force: true });
    }
  });
});
