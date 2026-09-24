#!/usr/bin/env node
/** Select a previously successful immutable production deployment. */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeploymentRecord } from './lib/deployment-record.mjs';

const DIRECT = resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);
if (DIRECT) {
  try {
    const result = resolveRollbackTarget({
      directory: requiredOption('--directory'),
      target: option('--target') ?? 'previous',
      currentVersion: requiredOption('--current-version'),
      currentDigest: requiredOption('--current-digest'),
      limit: Number(option('--limit') ?? '10'),
    });
    const output = option('--output');
    if (output) writeFileSync(resolve(output), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`✓ selected ${result.selected.version} ${result.selected.image.digest} from ${result.history.length} production deployment(s)`);
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

/**
 * @param {{ directory: string, target?: string, currentVersion: string, currentDigest: string, limit?: number }} input
 */
export function resolveRollbackTarget(input) {
  const directory = resolve(input.directory);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`Rollback history directory is missing: ${directory}`);
  }
  assertVersion(input.currentVersion, 'current production version');
  assertDigest(input.currentDigest, 'current production digest');
  const limit = Number(input.limit ?? 10);
  if (!Number.isInteger(limit) || limit < 2 || limit > 100) {
    throw new Error('Rollback history limit must be an integer between 2 and 100');
  }

  const deployments = [];
  for (const path of walkJsonFiles(directory)) {
    // Release downloads may contain manifests and unrelated JSON assets.
    if (!basename(path).startsWith('deployment-production-')) continue;
    let value;
    try {
      value = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid rollback history JSON ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const errors = validateDeploymentRecord(value);
    if (errors.length > 0) throw new Error(`Invalid rollback history record ${path}:\n${errors.join('\n')}`);
    if (value.environment !== 'production' || value.result !== 'success' || value.smoke?.result !== 'success') continue;
    deployments.push(value);
  }

  deployments.sort((left, right) => {
    const byTime = Date.parse(right.finishedAt) - Date.parse(left.finishedAt);
    return byTime || right.deploymentId.localeCompare(left.deploymentId);
  });
  const history = [];
  const seen = new Set();
  for (const deployment of deployments) {
    const key = `${deployment.version}@${deployment.image.digest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    history.push(deployment);
    if (history.length >= limit) break;
  }
  if (history.length === 0) throw new Error('No successful production deployment records were found');

  const currentKey = `${input.currentVersion}@${input.currentDigest}`;
  const target = input.target ?? 'previous';
  let selected;
  if (target === 'previous') {
    selected = history.find((deployment) => `${deployment.version}@${deployment.image.digest}` !== currentKey);
  } else {
    assertVersion(target, 'rollback target version');
    selected = history.find((deployment) => deployment.version === target
      && `${deployment.version}@${deployment.image.digest}` !== currentKey);
  }
  if (!selected) {
    throw new Error(target === 'previous'
      ? 'No previous successful immutable production deployment is available'
      : `Rollback target ${target} is not present in the successful production history or is already active`);
  }
  return {
    schemaVersion: 1,
    current: { version: input.currentVersion, digest: input.currentDigest },
    selected,
    history: history.map((deployment) => ({
      version: deployment.version,
      digest: deployment.image.digest,
      finishedAt: deployment.finishedAt,
      deploymentId: deployment.deploymentId,
    })),
  };
}

function walkJsonFiles(directory) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...walkJsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.json')) paths.push(path);
  }
  return paths.sort();
}

function assertVersion(value, label) {
  if (typeof value !== 'string' || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${label} must be vX.Y.Z`);
  }
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase OCI SHA-256 digest`);
  }
}

function option(name) {
  return process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

function requiredOption(name) {
  const value = option(name);
  if (!value) throw new Error(`${name}=... is required`);
  return value;
}
