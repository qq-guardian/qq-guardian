import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  assertPromotionInvariant,
  assertDeploymentMatchesManifest,
  createDeploymentRecord,
  createImageManifest,
  validateDeploymentRecord,
  validateImageManifest,
} from '../../scripts/lib/deployment-record.mjs';
import { resolveRollbackTarget } from '../../scripts/resolve-rollback-target.mjs';
import { writeDeterministicZip } from '../../scripts/lib/deterministic-zip.mjs';
import { verifyDeploymentRelease } from '../../scripts/verify-deployment-release.mjs';
import {
  buildDeploymentContainerArgs,
  decodeClientFrames,
  encodeServerTextFrame,
  mergeProcessOutput,
} from '../../scripts/smoke-deployment-image.mjs';

const temporary = mkdtempSync(join(tmpdir(), 'qq-guardian-deployment-'));
after(() => rmSync(temporary, { recursive: true, force: true }));

const base = {
  kind: 'promotion',
  deploymentId: '12345.1',
  version: 'v1.3.1',
  sourceSha: '1'.repeat(40),
  artifactSha256: '2'.repeat(64),
  imageReference: 'ghcr.io/shiyup1ay/napcat-plugin-qq-guardian',
  imageDigest: `sha256:${'3'.repeat(64)}`,
  environment: 'staging',
  startedAt: '2026-08-26T01:00:00.000Z',
  finishedAt: '2026-08-26T01:01:00.000Z',
  result: 'success',
  smokeResult: 'success',
  smokeChecks: ['config-migration', 'provider-http-ws', 'container-startup'],
};

describe('immutable deployment records', () => {
  it('allows production only for the exact successful staging input', () => {
    const staging = createDeploymentRecord(base);
    const image = createImageManifest({
      version: base.version,
      sourceSha: base.sourceSha,
      artifactSha256: base.artifactSha256,
      imageReference: base.imageReference,
      imageDigest: base.imageDigest,
      createdAt: base.finishedAt,
    });
    assert.deepEqual(validateDeploymentRecord(staging), []);
    assert.deepEqual(validateImageManifest(image), []);
    assert.doesNotThrow(() => assertPromotionInvariant(staging, image));
    assert.doesNotThrow(() => assertDeploymentMatchesManifest(staging, image));

    const failed = createDeploymentRecord({ ...base, result: 'failure', smokeResult: 'failure' });
    assert.throws(() => assertPromotionInvariant(failed, image), /successful staging smoke/);
    assert.throws(
      () => assertPromotionInvariant(staging, { ...image, artifact: { ...image.artifact, sha256: '4'.repeat(64) } }),
      /artifact checksum does not match/,
    );
  });

  it('selects the most recent distinct immutable production target within the bounded history', () => {
    const records = [
      createDeploymentRecord({ ...base, environment: 'production', deploymentId: '300.1', finishedAt: '2026-08-26T03:00:00.000Z' }),
      createDeploymentRecord({ ...base, environment: 'production', deploymentId: '200.1', version: 'v1.3.2', sourceSha: '4'.repeat(40), imageDigest: `sha256:${'5'.repeat(64)}`, finishedAt: '2026-08-26T02:00:00.000Z' }),
      createDeploymentRecord({ ...base, environment: 'production', deploymentId: '100.1', version: 'v1.3.3', sourceSha: '6'.repeat(40), imageDigest: `sha256:${'7'.repeat(64)}`, finishedAt: '2026-08-26T01:00:00.000Z' }),
    ];
    for (const [index, value] of records.entries()) {
      const historyDirectory = join(temporary, `history-${index}`);
      mkdirSync(historyDirectory, { recursive: true });
      writeFileSync(join(historyDirectory, `deployment-production-${index}.json`), JSON.stringify(value));
    }
    const result = resolveRollbackTarget({
      directory: temporary,
      currentVersion: 'v1.3.1',
      currentDigest: `sha256:${'3'.repeat(64)}`,
      target: 'previous',
      limit: 3,
    });
    assert.equal(result.selected.version, 'v1.3.2');
    assert.equal(result.history.length, 3);
    assert.throws(() => resolveRollbackTarget({
      directory: temporary,
      currentVersion: 'v1.3.1',
      currentDigest: `sha256:${'3'.repeat(64)}`,
      target: 'v1.3.1',
      limit: 3,
    }), /already active/);
  });

  it('records rollback success/failure without accepting partial previous state', () => {
    for (const result of ['success', 'failure']) {
      const rollback = createDeploymentRecord({
        ...base,
        kind: 'rollback',
        environment: 'production',
        result,
        smokeResult: result,
        rollbackResult: result,
        previousVersion: 'v1.3.2',
        previousDigest: `sha256:${'5'.repeat(64)}`,
      });
      assert.deepEqual(validateDeploymentRecord(rollback), []);
      assert.equal(rollback.rollback.targetVersion, 'v1.3.1');
    }
    assert.throws(
      () => createDeploymentRecord({ ...base, previousDigest: `sha256:${'5'.repeat(64)}` }),
      /previous version and digest must both be set/,
    );
  });

  it('rejects malformed digests, timestamps, environments, and unexpected fields', () => {
    const record = createDeploymentRecord(base);
    const invalid = {
      ...record,
      environment: 'prod',
      finishedAt: 'not-a-time',
      image: { ...record.image, digest: 'latest' },
      secret: 'must-not-be-recorded',
    };
    const errors = validateDeploymentRecord(invalid).join('\n');
    assert.match(errors, /unexpected property secret/);
    assert.match(errors, /environment must be staging or production/);
    assert.match(errors, /finishedAt must be/);
    assert.match(errors, /sha256:<64 lowercase hexadecimal>/);
  });
});

describe('deployment release and protocol smoke primitives', () => {
  it('authenticates the complete releaseDownload.zip layout and checksum', () => {
    const directory = join(temporary, 'release-valid');
    const archive = join(directory, 'releaseDownload.zip');
    const prefix = 'qq-guardian-v1.3.1/';
    const required = [
      'package.json', 'pnpm-lock.yaml', 'dist/index.mjs', 'dist/plugin.json',
      'dist-snowluma/index.mjs', 'deploy/.env.example', 'deploy/Dockerfile',
      'deploy/compose.yaml', 'deploy/native/guardian.env.example', 'runtime/node/LICENSE',
      'runtime/node/runtime.json', 'runtime/node/bin/node', 'src/index.ts', 'src/snowluma.ts',
      '.github/workflows/ci.yml', '.github/workflows/release.yml', '.github/workflows/deploy.yml',
      '.github/workflows/rollback.yml', 'test/tooling/deployment-control-plane.test.mjs',
      'config/ci-environments.json',
    ];
    writeDeterministicZip({
      outputPath: archive,
      entries: required.map((name) => ({ name: `${prefix}${name}`, data: Buffer.from(`${name}\n`) })),
    });
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
    writeFileSync(`${archive}.sha256`, `${digest}  releaseDownload.zip\n`);
    writeFileSync(join(directory, 'SHA256SUMS'), `${digest}  releaseDownload.zip\n`);
    const verified = verifyDeploymentRelease({ directory, tag: 'v1.3.1' });
    assert.equal(verified.artifact.sha256, digest);
    assert.equal(verified.bundleRoot, 'qq-guardian-v1.3.1');

    writeFileSync(`${archive}.sha256`, `${'0'.repeat(64)}  releaseDownload.zip\n`);
    assert.throws(() => verifyDeploymentRelease({ directory, tag: 'v1.3.1' }), /sidecar does not match/);
    assert.throws(() => verifyDeploymentRelease({ directory: join(temporary, 'missing'), tag: 'v1.3.1' }), /missing/);
  });

  it('encodes server frames and incrementally decodes masked client frames', () => {
    const server = encodeServerTextFrame('ok');
    assert.deepEqual([...server], [0x81, 0x02, 0x6F, 0x6B]);
    const client = maskedTextFrame('{"action":"get_status"}');
    const partial = decodeClientFrames(client.subarray(0, 5));
    assert.equal(partial.frames.length, 0);
    const decoded = decodeClientFrames(Buffer.concat([partial.remainder, client.subarray(5), client]));
    assert.equal(decoded.frames.length, 2);
    assert.equal(decoded.frames[0].payload.toString('utf8'), '{"action":"get_status"}');
    assert.equal(decoded.remainder.length, 0);
  });

  it('keeps the image root read-only while mounting private writable Guardian state', () => {
    const args = buildDeploymentContainerArgs({
      accessToken: 'smoke-token',
      containerName: 'guardian-smoke',
      httpPort: 6099,
      image: `ghcr.io/example/guardian@sha256:${'a'.repeat(64)}`,
      oneBotPort: 3001,
    });
    assert.equal(args.includes('--read-only'), true);
    assert.deepEqual(optionValues(args, '--tmpfs'), [
      '/tmp',
      '/guardian/data:rw,nosuid,nodev,noexec,uid=1000,gid=1000,mode=0700',
      '/guardian/config:rw,nosuid,nodev,noexec,uid=1000,gid=1000,mode=0700',
    ]);
  });

  it('preserves container stderr diagnostics when stdout is also present', () => {
    assert.equal(
      mergeProcessOutput('provider ready\n', 'startup failed: EROFS\n'),
      'provider ready\nstartup failed: EROFS',
    );
    assert.equal(mergeProcessOutput('', 'stderr only\n'), 'stderr only');
  });
});

function maskedTextFrame(value) {
  const payload = Buffer.from(value);
  const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const header = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.from([0x81, 0xFE, payload.length >> 8, payload.length & 0xFF]);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function optionValues(args, option) {
  return args.flatMap((argument, index) => argument === option ? [args[index + 1]] : []);
}
