import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeBranchProtectionForEvaluation,
  prepareBranchProtectionPayload,
} from '../../scripts/lib/github-governance-api.mjs';
import {
  desiredRepositoryBranchProtection,
  evaluateRepositoryBranchProtection,
} from '../../scripts/lib/repository-branch-protection.mjs';

const singleMaintainerOptions = { singleMaintainer: true };

describe('GitHub governance branch-protection payload', () => {
  it('omits user/team bypass fields that GitHub rejects on personal repositories', () => {
    const policy = desiredRepositoryBranchProtection(singleMaintainerOptions);
    const payload = prepareBranchProtectionPayload(policy);

    assert.equal('bypass_pull_request_allowances' in payload.required_pull_request_reviews, false);
    assert.deepEqual(policy.required_pull_request_reviews.bypass_pull_request_allowances, {
      users: [],
      teams: [],
      apps: [],
    });
    assert.equal(payload.restrictions, null);
    assert.deepEqual(payload.required_status_checks, policy.required_status_checks);
  });

  it('retains the multi-maintainer review policy unless single-maintainer mode is explicit', () => {
    const policy = desiredRepositoryBranchProtection();
    const reviews = policy.required_pull_request_reviews;

    assert.equal(reviews.required_approving_review_count, 1);
    assert.equal(reviews.require_last_push_approval, true);
  });

  it('uses a pull-request gate without second-person approval in explicit single-maintainer mode', () => {
    const policy = desiredRepositoryBranchProtection(singleMaintainerOptions);
    const reviews = policy.required_pull_request_reviews;

    assert.equal(reviews.dismiss_stale_reviews, true);
    assert.equal(reviews.require_code_owner_reviews, false);
    assert.equal(reviews.required_approving_review_count, 0);
    assert.equal(reviews.require_last_push_approval, false);
  });

  it('normalizes personal-repository read-back without hiding real restrictions', () => {
    const policy = desiredRepositoryBranchProtection(singleMaintainerOptions);
    const protection = {
      required_status_checks: { strict: true, contexts: policy.required_status_checks.contexts },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: {
        required_approving_review_count: 0,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        require_last_push_approval: false,
      },
      required_linear_history: { enabled: true },
      required_conversation_resolution: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
      block_creations: { enabled: false },
      lock_branch: { enabled: false },
      allow_fork_syncing: { enabled: false },
      restrictions: { users: [], teams: [], apps: [] },
    };

    const normalized = normalizeBranchProtectionForEvaluation(protection);
    assert.equal(normalized.allow_fork_syncing.enabled, true);
    assert.equal(normalized.restrictions, null);
    assert.deepEqual(
      evaluateRepositoryBranchProtection(normalized, { enabled: true }, singleMaintainerOptions),
      [],
    );

    const genericErrors = evaluateRepositoryBranchProtection(normalized, { enabled: true }).join('\n');
    assert.match(genericErrors, /exactly one approving review is required/);
    assert.match(genericErrors, /last push must be approved by another reviewer/);

    protection.restrictions = { users: [{ login: 'restricted-user' }], teams: [], apps: [] };
    const restricted = normalizeBranchProtectionForEvaluation(protection);
    assert.notEqual(restricted.restrictions, null);
    assert.match(
      evaluateRepositoryBranchProtection(restricted, { enabled: true }, singleMaintainerOptions).join('\n'),
      /push restrictions/,
    );
  });

  it('rejects second-person review requirements in explicit single-maintainer mode', () => {
    const policy = desiredRepositoryBranchProtection(singleMaintainerOptions);
    const protection = {
      required_status_checks: { strict: true, contexts: policy.required_status_checks.contexts },
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

    const errors = evaluateRepositoryBranchProtection(
      protection,
      { enabled: true },
      singleMaintainerOptions,
    ).join('\n');
    assert.match(errors, /approving reviews must not be required/);
    assert.match(errors, /last-push approval must be disabled/);
  });
});
