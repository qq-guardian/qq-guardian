#!/usr/bin/env node
import {
  desiredRepositoryBranchProtection,
  evaluateRepositoryBranchProtection,
} from './lib/repository-branch-protection.mjs';
import {
  createGitHubRequester,
  prepareBranchProtectionPayload,
  readBranchProtectionState,
} from './lib/github-governance-api.mjs';

const [mode, ...rawArguments] = process.argv.slice(2);
if (!['verify', 'apply'].includes(mode)) usage();
const options = parseArguments(rawArguments);
const repository = options.repo ?? process.env.GITHUB_REPOSITORY ?? 'ShiYuPIay/qq-guardian';
const branch = options.branch ?? 'main';
const singleMaintainer = options['single-maintainer'] === true;
const policyLabel = singleMaintainer ? 'single-maintainer' : 'multi-maintainer';
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('--repo must use owner/repository format');
if (!/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error('--branch contains unsupported characters');
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required; the token value is never logged');
if (mode === 'apply' && options['confirm-after-main-green'] !== true) {
  throw new Error('Refusing to apply policy before --confirm-after-main-green is supplied');
}

const base = `https://api.github.com/repos/${repository}/branches/${encodeURIComponent(branch)}/protection`;
const request = createGitHubRequester({ token });
const policyOptions = { singleMaintainer };
let state = await readBranchProtectionState(base, request);
let errors = evaluateRepositoryBranchProtection(state.protection, state.signatures, policyOptions);

if (mode === 'verify') {
  report(errors);
} else if (errors.length === 0) {
  console.log(`✓ ${repository}:${branch} already matches the reviewed ${policyLabel} branch-protection policy`);
} else {
  console.log(`Applying reviewed ${policyLabel} branch protection to ${repository}:${branch}; detected ${errors.length} policy difference(s)`);
  const payload = prepareBranchProtectionPayload(desiredRepositoryBranchProtection(policyOptions));
  await request(base, { method: 'PUT', body: JSON.stringify(payload) });
  await request(`${base}/required_signatures`, { method: 'POST' });
  state = await readBranchProtectionState(base, request);
  errors = evaluateRepositoryBranchProtection(state.protection, state.signatures, policyOptions);
  report(errors);
}

function report(differences) {
  if (differences.length > 0) {
    differences.forEach((difference) => console.error(`✗ ${difference}`));
    process.exitCode = 1;
  } else {
    console.log(`✓ ${repository}:${branch} matches the reviewed ${policyLabel} branch-protection policy`);
  }
}

function parseArguments(arguments_) {
  const parsed = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--confirm-after-main-green' || argument === '--single-maintainer') {
      parsed[argument.slice(2)] = true;
      continue;
    }
    if (!['--repo', '--branch'].includes(argument) || !arguments_[index + 1]) usage();
    parsed[argument.slice(2)] = arguments_[index + 1];
    index += 1;
  }
  return parsed;
}

function usage() {
  console.error('Usage: node scripts/github-governance.mjs <verify|apply> [--repo owner/repository] [--branch main] [--single-maintainer] [--confirm-after-main-green]');
  process.exit(2);
}
