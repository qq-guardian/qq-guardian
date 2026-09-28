#!/usr/bin/env node
/** Prepare a guarded patch/minor/major version change for the version PR. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SCRIPT_PATH), '..');
const BUMPS = new Set(['patch', 'minor', 'major']);

if (resolve(process.argv[1] ?? '') === resolve(SCRIPT_PATH)) {
  main().catch((error) => {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const nonInteractive = args.includes('--non-interactive');
  const requested = option(args, '--bump') ?? args.find((argument) => BUMPS.has(argument));
  let bump = requested;
  if (!bump && nonInteractive) throw new Error('--non-interactive requires --bump=patch|minor|major');
  if (!bump) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('Interactive release selection requires a TTY; use --non-interactive --bump=<type>');
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      bump = (await prompt.question('Release type (patch/minor/major): ')).trim().toLowerCase();
    } finally {
      prompt.close();
    }
  }
  if (!BUMPS.has(bump)) throw new Error(`Invalid release type ${JSON.stringify(bump)}`);
  const dryRun = args.includes('--dry-run');
  if (args.includes('--prepare')) {
    const result = prepareRelease({
      root: ROOT,
      bump,
      dryRun,
      expectedSha: option(args, '--expected-sha'),
    });
    console.log(`${result.dryRun ? 'Would prepare' : 'Prepared'} v${result.currentVersion} → v${result.nextVersion}`);
    return;
  }

  const result = requestRelease({ root: ROOT, bump, dryRun });
  console.log(`${dryRun ? 'Would request' : 'Requested'} v${result.currentVersion} → v${result.nextVersion}`);
  if (!dryRun) {
    console.log('GitHub will create a focused version PR; required CI gates must pass before auto-merge and publication.');
  }
}

/**
 * Validate local release authority, reject a concurrent version request, then
 * ask GitHub Actions to create the version PR. The local checkout is never
 * modified and no repository token is read by this script; authentication is
 * delegated to the maintainer's existing GitHub CLI session.
 */
export function requestRelease({
  root,
  bump,
  dryRun = false,
  git = process.env['GIT_EXECUTABLE'] || 'git',
  listOpenRequests = () => listOpenVersionRequests(root),
  dispatch = (request) => dispatchReleaseWorkflow(root, request),
}) {
  const preflight = prepareRelease({ root, bump, dryRun: true, git });
  const openRequests = listOpenRequests();
  if (!Array.isArray(openRequests)) throw new Error('Open release request query returned an invalid result');
  if (openRequests.length > 0) {
    throw new Error(`An open release request already exists: ${openRequests.join(', ')}`);
  }
  if (!dryRun) {
    dispatch({
      bump,
      expectedSha: preflight.commitSha,
      nextVersion: preflight.nextVersion,
    });
  }
  return { ...preflight, dryRun };
}

export function prepareRelease({
  root,
  bump,
  dryRun = false,
  git = process.env['GIT_EXECUTABLE'] || 'git',
  expectedSha,
}) {
  if (!BUMPS.has(bump)) throw new Error(`Invalid release type ${JSON.stringify(bump)}`);
  assertCleanMain(root, git);
  refreshRemoteState(root, git);
  const localHead = runGit(root, git, ['rev-parse', 'HEAD']);
  const remoteHead = runGit(root, git, ['rev-parse', 'refs/remotes/origin/main']);
  if (localHead !== remoteHead) {
    throw new Error(`main is not synchronized with origin/main (${localHead.slice(0, 12)} != ${remoteHead.slice(0, 12)})`);
  }
  if (expectedSha && localHead !== expectedSha) {
    throw new Error(`Release request expected ${expectedSha}, but main is ${localHead}`);
  }

  const manifests = ['package.json', 'plugin.json', 'dist/package.json', 'dist/plugin.json']
    .map((name) => ({ name, path: join(root, name) }))
    .filter(({ path }) => existsSync(path))
    .map(({ name, path }) => ({ name, path, value: readJson(path) }));
  const rootPackage = manifests.find(({ name }) => name === 'package.json')?.value;
  const rootPlugin = manifests.find(({ name }) => name === 'plugin.json')?.value;
  if (!rootPackage || !rootPlugin) throw new Error('package.json and plugin.json are required');
  const currentVersion = rootPackage.version;
  parseVersion(currentVersion);
  for (const manifest of manifests) {
    if (manifest.value.version !== currentVersion) {
      throw new Error(`${manifest.name} version ${manifest.value.version} does not match package.json ${currentVersion}`);
    }
  }

  const nextVersion = bumpVersion(currentVersion, bump);
  const tag = `v${nextVersion}`;
  const conflict = runGit(root, git, ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], true);
  if (conflict.status === 0) throw new Error(`Tag ${tag} already exists`);
  if (conflict.status !== 1) throw new Error(`Could not verify whether ${tag} exists`);

  if (!dryRun) {
    for (const manifest of manifests) {
      manifest.value.version = nextVersion;
      writeFileSync(manifest.path, `${JSON.stringify(manifest.value, null, 2)}\n`, 'utf8');
    }
  }
  return { currentVersion, nextVersion, tag, commitSha: localHead, dryRun };
}

export function bumpVersion(version, bump) {
  const [major, minor, patch] = parseVersion(version);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Invalid release type ${JSON.stringify(bump)}`);
}

function assertCleanMain(root, git) {
  const branch = runGit(root, git, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch !== 'main') throw new Error(`Releases must be prepared from main, not ${branch || 'detached HEAD'}`);
  const dirty = runGit(root, git, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (dirty) throw new Error('Working tree is dirty; commit, stash, or remove all changes before releasing');
}

function refreshRemoteState(root, git) {
  const branchFetch = runGit(root, git, [
    'fetch', '--quiet', '--prune', 'origin', '+refs/heads/main:refs/remotes/origin/main',
  ], true);
  if (branchFetch.status !== 0) throw new Error('Could not refresh origin/main; refusing to release from unverified state');
  const tagFetch = runGit(root, git, ['fetch', '--quiet', '--prune', '--tags', 'origin'], true);
  if (tagFetch.status !== 0) throw new Error('Could not refresh origin tags; refusing to release from unverified state');
}

function runGit(root, executable, args, allowFailure = false) {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8' });
  if (allowFailure) return { status: result.status, stdout: result.stdout?.trim() ?? '', stderr: result.stderr?.trim() ?? '' };
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
  }
  return result.stdout.trim();
}

function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error(`Expected a stable SemVer version, got ${JSON.stringify(version)}`);
  return match.slice(1).map(Number);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function listOpenVersionRequests(root) {
  const result = runCommand(root, process.env['GH_EXECUTABLE'] || 'gh', [
    'pr', 'list', '--state', 'open', '--limit', '100', '--json', 'headRefName,url',
  ]);
  let requests;
  try {
    requests = JSON.parse(result);
  } catch {
    throw new Error('GitHub CLI returned invalid JSON while checking open release requests');
  }
  if (!Array.isArray(requests)) throw new Error('GitHub CLI returned an invalid release request list');
  return requests
    .filter((request) => typeof request?.headRefName === 'string'
      && request.headRefName.startsWith('release/version-'))
    .map((request) => typeof request.url === 'string' ? request.url : request.headRefName);
}

function dispatchReleaseWorkflow(root, request) {
  runCommand(root, process.env['GH_EXECUTABLE'] || 'gh', [
    'workflow', 'run', 'release-request.yml', '--ref', 'main',
    '--field', `bump=${request.bump}`,
    '--field', `expected_sha=${request.expectedSha}`,
  ]);
}

function runCommand(root, executable, args) {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') {
    throw new Error(`${executable} is required; install and authenticate GitHub CLI before requesting a release`);
  }
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(' ')} failed: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
  }
  return result.stdout.trim();
}

function option(args, name) {
  return args.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}
