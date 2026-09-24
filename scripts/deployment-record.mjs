#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertDeploymentMatchesManifest,
  assertPromotionInvariant,
  createDeploymentRecord,
  createImageManifest,
  validateDeploymentRecord,
  validateImageManifest,
} from './lib/deployment-record.mjs';

const [command] = process.argv.slice(2);
if (!['image-manifest', 'record', 'verify-image', 'verify-record', 'assert-promotion', 'assert-deployment'].includes(command)) usage();

if (command === 'image-manifest') {
  writeJson(requiredOption('--output'), createImageManifest({
    version: requiredEnv('DEPLOYMENT_VERSION'),
    sourceSha: requiredEnv('DEPLOYMENT_SOURCE_SHA'),
    artifactSha256: requiredEnv('DEPLOYMENT_ARTIFACT_SHA256'),
    imageReference: requiredEnv('DEPLOYMENT_IMAGE_REFERENCE'),
    imageDigest: requiredEnv('DEPLOYMENT_IMAGE_DIGEST'),
    createdAt: requiredEnv('DEPLOYMENT_FINISHED_AT'),
  }));
} else if (command === 'record') {
  writeJson(requiredOption('--output'), createDeploymentRecord({
    kind: requiredEnv('DEPLOYMENT_KIND'),
    deploymentId: requiredEnv('DEPLOYMENT_ID'),
    version: requiredEnv('DEPLOYMENT_VERSION'),
    sourceSha: requiredEnv('DEPLOYMENT_SOURCE_SHA'),
    artifactSha256: requiredEnv('DEPLOYMENT_ARTIFACT_SHA256'),
    imageReference: requiredEnv('DEPLOYMENT_IMAGE_REFERENCE'),
    imageDigest: requiredEnv('DEPLOYMENT_IMAGE_DIGEST'),
    environment: requiredEnv('DEPLOYMENT_ENVIRONMENT'),
    startedAt: requiredEnv('DEPLOYMENT_STARTED_AT'),
    finishedAt: requiredEnv('DEPLOYMENT_FINISHED_AT'),
    result: requiredEnv('DEPLOYMENT_RESULT'),
    previousVersion: process.env['DEPLOYMENT_PREVIOUS_VERSION'] ?? '',
    previousDigest: process.env['DEPLOYMENT_PREVIOUS_DIGEST'] ?? '',
    smokeResult: requiredEnv('DEPLOYMENT_SMOKE_RESULT'),
    smokeChecks: requiredEnv('DEPLOYMENT_SMOKE_CHECKS').split(',').filter(Boolean),
    rollbackResult: process.env['DEPLOYMENT_ROLLBACK_RESULT'],
  }));
} else if (command === 'verify-image') {
  verify(requiredOption('--path'), validateImageManifest, 'image manifest');
} else if (command === 'verify-record') {
  verify(requiredOption('--path'), validateDeploymentRecord, 'deployment record');
} else if (command === 'assert-promotion') {
  const staging = readJson(requiredOption('--staging'));
  const image = readJson(requiredOption('--image'));
  assertPromotionInvariant(staging, image);
  console.log('✓ production input exactly matches successful staging');
} else {
  const deployment = readJson(requiredOption('--record'));
  const image = readJson(requiredOption('--image'));
  assertDeploymentMatchesManifest(deployment, image);
  console.log('✓ deployment record exactly matches immutable image manifest');
}

function verify(path, validator, label) {
  const errors = validator(readJson(path));
  if (errors.length > 0) throw new Error(errors.join('\n'));
  console.log(`✓ ${label} is valid`);
}

function writeJson(path, value) {
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  console.log(`✓ wrote ${resolve(path)}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredOption(name) {
  const value = process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value) usage();
  return value;
}

function usage() {
  console.error('Usage: node scripts/deployment-record.mjs <image-manifest|record|verify-image|verify-record|assert-promotion|assert-deployment> [options]');
  process.exit(2);
}
