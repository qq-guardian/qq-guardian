export function createGitHubRequester({ token, fetchImplementation = globalThis.fetch }) {
  if (!token) throw new Error('A GitHub token is required');
  if (typeof fetchImplementation !== 'function') throw new Error('A fetch implementation is required');

  return async function request(url, options = {}, behavior = {}) {
    const response = await fetchImplementation(url, {
      ...options,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (response.status === 404 && behavior.allowNotFound === true) return {};
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`GitHub API ${options.method ?? 'GET'} ${response.status}: ${detail}`);
    }
    return response.status === 204 ? {} : await response.json();
  };
}

export function prepareBranchProtectionPayload(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new TypeError('Branch protection policy must be an object');
  }

  const reviews = policy.required_pull_request_reviews;
  if (!reviews || typeof reviews !== 'object' || Array.isArray(reviews)) return { ...policy };

  // GitHub rejects user/team bypass fields on personal repositories even when
  // the arrays are empty. Omitting the bypass object preserves the reviewed
  // no-bypass policy and works for both personal and organization repositories.
  const { bypass_pull_request_allowances: _ignored, ...portableReviews } = reviews;
  return {
    ...policy,
    required_pull_request_reviews: portableReviews,
  };
}

export function normalizeBranchProtectionForEvaluation(protection) {
  const normalized = protection && typeof protection === 'object' && !Array.isArray(protection)
    ? { ...protection }
    : {};

  // Preserve the explicit "resource absent" shape returned by allowNotFound.
  // Missing branch protection must remain detectable as drift by the evaluator.
  if (Object.keys(normalized).length === 0) return normalized;

  // Access restrictions only exist for organization-owned repositories. GitHub
  // may omit this property or return an empty metadata object for personal repos.
  // Treat both shapes as the reviewed "no push restriction" policy while keeping
  // any real user/team/app restriction visible to the evaluator.
  if (hasNoConfiguredRestrictions(normalized.restrictions)) {
    normalized.restrictions = null;
  }

  // allow_fork_syncing is only meaningful for a locked/read-only branch. When
  // lock_branch is disabled GitHub may normalize the flag to false or omit it.
  // Represent that inapplicable state as semantically compliant for evaluation.
  if (normalized.lock_branch?.enabled !== true) {
    normalized.allow_fork_syncing = {
      ...(normalized.allow_fork_syncing ?? {}),
      enabled: true,
    };
  }

  return normalized;
}

function hasNoConfiguredRestrictions(restrictions) {
  if (restrictions == null) return true;
  if (typeof restrictions !== 'object' || Array.isArray(restrictions)) return false;
  return ['users', 'teams', 'apps'].every((kind) => {
    const entries = restrictions[kind];
    return entries == null || (Array.isArray(entries) && entries.length === 0);
  });
}

export async function readBranchProtectionState(base, request) {
  const protection = await request(base, {}, { allowNotFound: true });
  return {
    protection: normalizeBranchProtectionForEvaluation(protection),
    signatures: await request(`${base}/required_signatures`, {}, { allowNotFound: true }),
  };
}
