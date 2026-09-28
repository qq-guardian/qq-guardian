import { desiredBranchProtection, evaluateBranchProtection } from './ci-governance.mjs';

const SINGLE_MAINTAINER_REVIEW_ERRORS = new Set([
  'exactly one approving review is required',
  'the last push must be approved by another reviewer',
]);

export function desiredRepositoryBranchProtection({ singleMaintainer = false } = {}) {
  const policy = desiredBranchProtection();
  if (!singleMaintainer) return policy;

  return {
    ...policy,
    required_pull_request_reviews: {
      ...policy.required_pull_request_reviews,
      // Single-maintainer mode is an explicit operator choice. GitHub still
      // requires every change to go through a pull request, but a second-person
      // approval would permanently deadlock a repository maintained by one person.
      required_approving_review_count: 0,
      require_last_push_approval: false,
    },
  };
}

export function evaluateRepositoryBranchProtection(
  protection,
  signatures,
  { singleMaintainer = false } = {},
) {
  if (!singleMaintainer) return evaluateBranchProtection(protection, signatures);

  const errors = evaluateBranchProtection(protection, signatures)
    .filter((error) => !SINGLE_MAINTAINER_REVIEW_ERRORS.has(error));
  const reviews = protection?.required_pull_request_reviews;

  // GitHub documents 0 as "do not require reviewers". The property can also be
  // absent in normalized responses, so treat absence as the documented zero.
  if ((reviews?.required_approving_review_count ?? 0) !== 0) {
    errors.push('approving reviews must not be required in single-maintainer mode');
  }

  // GitHub documents false as the default. Requiring someone other than the
  // last pusher would make a single-maintainer repository impossible to merge.
  if ((reviews?.require_last_push_approval ?? false) !== false) {
    errors.push('last-push approval must be disabled in single-maintainer mode');
  }

  return errors;
}
