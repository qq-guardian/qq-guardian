const VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const OCI_DIGEST = /^sha256:[a-f0-9]{64}$/;
const IMAGE = /^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._/-]+$/;
const ENVIRONMENTS = new Set(['staging', 'production']);
const RESULTS = new Set(['success', 'failure']);

export function createImageManifest(input) {
  const manifest = {
    schemaVersion: 1,
    version: input.version,
    sourceSha: input.sourceSha,
    artifact: {
      name: input.artifactName ?? 'releaseDownload.zip',
      sha256: input.artifactSha256,
    },
    image: {
      reference: input.imageReference,
      digest: input.imageDigest,
    },
    createdAt: input.createdAt,
  };
  const errors = validateImageManifest(manifest);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return manifest;
}

export function validateImageManifest(value) {
  const errors = [];
  if (!plainObject(value) || value.schemaVersion !== 1) return ['image manifest schemaVersion must be 1'];
  exactKeys(value, ['schemaVersion', 'version', 'sourceSha', 'artifact', 'image', 'createdAt'], '$', errors);
  if (!VERSION.test(value.version)) errors.push('image manifest version must be vX.Y.Z');
  if (!SHA.test(value.sourceSha)) errors.push('image manifest sourceSha must be a lowercase 40-character SHA');
  validateArtifact(value.artifact, 'image manifest artifact', errors);
  validateImage(value.image, 'image manifest image', errors);
  validateTimestamp(value.createdAt, 'image manifest createdAt', errors);
  return errors;
}

export function createDeploymentRecord(input) {
  const record = {
    schemaVersion: 1,
    kind: input.kind,
    deploymentId: String(input.deploymentId),
    version: input.version,
    sourceSha: input.sourceSha,
    artifact: {
      name: input.artifactName ?? 'releaseDownload.zip',
      sha256: input.artifactSha256,
    },
    image: {
      reference: input.imageReference,
      digest: input.imageDigest,
    },
    environment: input.environment,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    result: input.result,
    previous: {
      version: input.previousVersion || null,
      digest: input.previousDigest || null,
    },
    smoke: {
      result: input.smokeResult,
      checks: [...input.smokeChecks],
    },
    rollback: {
      requested: input.kind === 'rollback',
      result: input.rollbackResult ?? (input.kind === 'rollback' ? input.result : 'not-requested'),
      targetVersion: input.kind === 'rollback' ? input.version : null,
    },
  };
  const errors = validateDeploymentRecord(record);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return record;
}

export function validateDeploymentRecord(value) {
  const errors = [];
  if (!plainObject(value) || value.schemaVersion !== 1) return ['deployment record schemaVersion must be 1'];
  exactKeys(value, [
    'schemaVersion', 'kind', 'deploymentId', 'version', 'sourceSha', 'artifact', 'image',
    'environment', 'startedAt', 'finishedAt', 'result', 'previous', 'smoke', 'rollback',
  ], '$', errors);
  if (!['promotion', 'rollback'].includes(value.kind)) errors.push('deployment kind must be promotion or rollback');
  if (typeof value.deploymentId !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(value.deploymentId)) {
    errors.push('deploymentId contains unsupported characters');
  }
  if (!VERSION.test(value.version)) errors.push('deployment version must be vX.Y.Z');
  if (!SHA.test(value.sourceSha)) errors.push('deployment sourceSha must be a lowercase 40-character SHA');
  validateArtifact(value.artifact, 'deployment artifact', errors);
  validateImage(value.image, 'deployment image', errors);
  if (!ENVIRONMENTS.has(value.environment)) errors.push('deployment environment must be staging or production');
  validateTimestamp(value.startedAt, 'deployment startedAt', errors);
  validateTimestamp(value.finishedAt, 'deployment finishedAt', errors);
  if (validTimestamp(value.startedAt) && validTimestamp(value.finishedAt)
    && Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
    errors.push('deployment finishedAt precedes startedAt');
  }
  if (!RESULTS.has(value.result)) errors.push('deployment result must be success or failure');
  validatePrevious(value.previous, errors);
  validateSmoke(value.smoke, errors);
  validateRollback(value.rollback, value.kind, value.version, errors);
  return errors;
}

/** Production may consume only the exact successful staging input. */
export function assertPromotionInvariant(staging, imageManifest) {
  const errors = [
    ...validateDeploymentRecord(staging),
    ...validateImageManifest(imageManifest),
  ];
  if (staging?.kind !== 'promotion' || staging?.environment !== 'staging') {
    errors.push('production requires a staging promotion record');
  }
  if (staging?.result !== 'success' || staging?.smoke?.result !== 'success') {
    errors.push('production requires successful staging smoke');
  }
  errors.push(...deploymentManifestMismatches(staging, imageManifest));
  if (errors.length > 0) throw new Error(errors.join('\n'));
}

/** Assert that a deployment record names the exact immutable image manifest. */
export function assertDeploymentMatchesManifest(deployment, imageManifest) {
  const errors = [
    ...validateDeploymentRecord(deployment),
    ...validateImageManifest(imageManifest),
    ...deploymentManifestMismatches(deployment, imageManifest),
  ];
  if (errors.length > 0) throw new Error(errors.join('\n'));
}

function deploymentManifestMismatches(deployment, imageManifest) {
  const errors = [];
  for (const [label, left, right] of [
    ['version', deployment?.version, imageManifest?.version],
    ['source SHA', deployment?.sourceSha, imageManifest?.sourceSha],
    ['artifact checksum', deployment?.artifact?.sha256, imageManifest?.artifact?.sha256],
    ['image reference', deployment?.image?.reference, imageManifest?.image?.reference],
    ['image digest', deployment?.image?.digest, imageManifest?.image?.digest],
  ]) {
    if (left !== right) errors.push(`deployment ${label} does not match the immutable image manifest`);
  }
  return errors;
}

function validateArtifact(value, label, errors) {
  if (!plainObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  exactKeys(value, ['name', 'sha256'], label, errors);
  if (value.name !== 'releaseDownload.zip') errors.push(`${label} name must be releaseDownload.zip`);
  if (!SHA256.test(value.sha256)) errors.push(`${label} sha256 must be 64 lowercase hexadecimal characters`);
}

function validateImage(value, label, errors) {
  if (!plainObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  exactKeys(value, ['reference', 'digest'], label, errors);
  if (!IMAGE.test(value.reference)) errors.push(`${label} reference must be a lowercase ghcr.io image path`);
  if (!OCI_DIGEST.test(value.digest)) errors.push(`${label} digest must be sha256:<64 lowercase hexadecimal>`);
}

function validatePrevious(value, errors) {
  if (!plainObject(value)) {
    errors.push('deployment previous must be an object');
    return;
  }
  exactKeys(value, ['version', 'digest'], 'deployment previous', errors);
  if (value.version !== null && !VERSION.test(value.version)) errors.push('previous version must be null or vX.Y.Z');
  if (value.digest !== null && !OCI_DIGEST.test(value.digest)) errors.push('previous digest must be null or an OCI SHA-256 digest');
  if ((value.version === null) !== (value.digest === null)) errors.push('previous version and digest must both be set or both be null');
}

function validateSmoke(value, errors) {
  if (!plainObject(value)) {
    errors.push('deployment smoke must be an object');
    return;
  }
  exactKeys(value, ['result', 'checks'], 'deployment smoke', errors);
  if (!RESULTS.has(value.result)) errors.push('smoke result must be success or failure');
  if (!Array.isArray(value.checks) || value.checks.length === 0
    || value.checks.some((check) => typeof check !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(check))) {
    errors.push('smoke checks must be a non-empty list of stable check identifiers');
  }
}

function validateRollback(value, kind, version, errors) {
  if (!plainObject(value)) {
    errors.push('deployment rollback must be an object');
    return;
  }
  exactKeys(value, ['requested', 'result', 'targetVersion'], 'deployment rollback', errors);
  if (typeof value.requested !== 'boolean') errors.push('rollback requested must be boolean');
  if (!['not-requested', 'success', 'failure'].includes(value.result)) errors.push('rollback result is invalid');
  if (kind === 'rollback') {
    if (value.requested !== true || value.targetVersion !== version || !RESULTS.has(value.result)) {
      errors.push('rollback records must identify their target and success/failure result');
    }
  } else if (value.requested !== false || value.result !== 'not-requested' || value.targetVersion !== null) {
    errors.push('promotion records must mark rollback as not requested');
  }
}

function validateTimestamp(value, label, errors) {
  if (!validTimestamp(value)) errors.push(`${label} must be an ISO-8601 UTC timestamp`);
}

function validTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function exactKeys(value, expected, label, errors) {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) errors.push(`${label} contains unexpected property ${key}`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) errors.push(`${label} is missing property ${key}`);
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
