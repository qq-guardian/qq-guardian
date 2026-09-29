#!/usr/bin/env node
/** Verify or apply the GitHub deployment environments used by immutable CD. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CONFIG = JSON.parse(readFileSync(resolve(ROOT, 'config/ci-environments.json'), 'utf8'));
const API_VERSION = '2022-11-28';

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export async function main() {
  const command = process.argv[2];
  if (!['verify', 'apply'].includes(command)) usage();
  const repository = option('--repo') ?? process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) throw new Error('--repo=OWNER/REPOSITORY or GITHUB_REPOSITORY is required');
  if (!token) throw new Error('GH_TOKEN is required');
  const client = createClient(repository, token);
  if (command === 'apply') {
    if (!process.argv.includes('--confirm')) throw new Error('Applying environment policy requires --confirm');
    const gatedEnvironments = Object.entries(CONFIG.environments).filter(([, policy]) => policy.requiredReviewers);
    const reviewers = gatedEnvironments.length > 0 ? parseReviewers(process.env.PRODUCTION_REVIEWER_IDS) : [];
    if (gatedEnvironments.length > 0 && reviewers.length === 0) {
      throw new Error('PRODUCTION_REVIEWER_IDS must be a JSON array of GitHub reviewer objects, for example [{"type":"User","id":123}]');
    }
    for (const [name, policy] of Object.entries(CONFIG.environments)) {
      await applyEnvironment(client, name, policy, policy.requiredReviewers ? reviewers : []);
    }
  }
  const states = {};
  for (const [name, policy] of Object.entries(CONFIG.environments)) {
    states[name] = await client.request(`/environments/${encodeURIComponent(name)}`);
    assertEnvironment(name, states[name], policy);
  }
  console.log(`✓ GitHub deployment environments verified for ${repository}: ${Object.keys(states).join(', ')}`);
  return states;
}

async function applyEnvironment(client, name, policy, reviewers) {
  await client.request(`/environments/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: {
      wait_timer: policy.waitTimer,
      prevent_self_review: policy.preventSelfReview,
      reviewers,
      deployment_branch_policy: {
        protected_branches: policy.protectedBranches,
        custom_branch_policies: false,
      },
    },
  });
  console.log(`✓ applied ${name} environment policy`);
}

export function assertEnvironment(name, value, policy) {
  if (!value || value.deployment_branch_policy?.protected_branches !== policy.protectedBranches) {
    throw new Error(`${name} must restrict deployments to protected branches`);
  }
  const rules = Array.isArray(value.protection_rules) ? value.protection_rules : [];
  const waitTimer = rules.find((rule) => rule.type === 'wait_timer');
  const required = rules.find((rule) => rule.type === 'required_reviewers');
  const actualWaitTimer = Number.isInteger(waitTimer?.wait_timer) ? waitTimer.wait_timer : 0;
  if (actualWaitTimer !== policy.waitTimer) {
    throw new Error(`${name} wait timer drift: expected ${policy.waitTimer}, got ${actualWaitTimer}`);
  }

  const reviewerCount = Array.isArray(required?.reviewers) ? required.reviewers.length : 0;
  if (policy.requiredReviewers) {
    if (reviewerCount === 0) {
      throw new Error(`${name} must have at least one required environment reviewer`);
    }
    if (required.prevent_self_review !== policy.preventSelfReview) {
      throw new Error(`${name} prevent-self-review drift: expected ${policy.preventSelfReview}, got ${required.prevent_self_review}`);
    }
  } else if (required) {
    throw new Error(`${name} must not have required environment reviewers`);
  }
}

function createClient(repository, token) {
  const base = `https://api.github.com/repos/${repository}`;
  return {
    async request(path, options = {}) {
      const response = await fetch(`${base}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': API_VERSION,
          'content-type': 'application/json',
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await response.text();
      let value;
      try { value = text ? JSON.parse(text) : null; } catch { value = text; }
      if (!response.ok) throw new Error(`GitHub API ${options.method ?? 'GET'} ${path} failed (${response.status}): ${JSON.stringify(value)}`);
      return value;
    },
  };
}

function parseReviewers(value) {
  if (!value) return [];
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error('PRODUCTION_REVIEWER_IDS must be valid JSON'); }
  if (!Array.isArray(parsed) || parsed.some((reviewer) => !reviewer || !['User', 'Team'].includes(reviewer.type) || !Number.isInteger(reviewer.id))) {
    throw new Error('PRODUCTION_REVIEWER_IDS must contain {type: User|Team, id: integer} objects');
  }
  return parsed;
}

function option(name) {
  return process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

function usage() {
  throw new Error('Usage: node scripts/github-environments.mjs <verify|apply> --repo=OWNER/REPOSITORY [--confirm]');
}
