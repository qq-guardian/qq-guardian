import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { bus } from '../../core/events/index.ts';
import { configManager } from '../../core/config/index.ts';
import { getRuntimeHost } from '../../runtime/host.ts';
import type { RuntimeKind } from '../../ports/runtime.ts';
import { getLogger } from '../../core/logger/index.ts';
import { withLock, locks } from '../../core/locks.ts';
import { fetchRemote, readResponseBytes, readResponseJson, releaseRemoteResponse, writeResponseToFile } from '../../runtime/safe-fetch.ts';

const ALLOWED_DOWNLOAD_ORIGINS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);
const GITHUB_API_ORIGINS = new Set(['api.github.com']);
const MAX_RELEASE_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_UPDATE_BYTES = 100 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 16 * 1024;
const MAX_RELEASE_VERSION_LENGTH = 128;
const LEGACY_RELEASE_TAG_PREFIX = 'napcat-plugin-qq-guardianv';
const SEMVER_TAG = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Synchronous syntax/host check for API input. `fetchRemote` repeats the
 * policy after DNS resolution and at every redirect hop. */
export function validateDownloadUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid download URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('Downloads must use credential-free HTTPS URLs without custom ports');
  }
  if (!ALLOWED_DOWNLOAD_ORIGINS.has(url.hostname.toLowerCase())) {
    throw new Error('Downloads from this host are not permitted');
  }
}

/** Accept only a bounded SemVer release tag. The returned value is canonical
 *  (without a leading `v`) and safe for logs, filenames, API responses, and
 *  version comparison. The exact pre-v1.4 historical project-tag prefix is
 *  retained solely so published legacy releases remain readable. */
export function normalizeReleaseVersion(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RELEASE_VERSION_LENGTH) return null;
  const candidate = value.startsWith(LEGACY_RELEASE_TAG_PREFIX)
    ? `v${value.slice(LEGACY_RELEASE_TAG_PREFIX.length)}`
    : value;
  const match = SEMVER_TAG.exec(candidate);
  if (!match) return null;
  const core = match.slice(1, 4).map(Number);
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  const prerelease = match[4];
  if (prerelease?.split('.').some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) {
    return null;
  }
  return `${match[1]}.${match[2]}.${match[3]}${prerelease ? `-${prerelease}` : ''}${match[5] ? `+${match[5]}` : ''}`;
}

export interface ReleaseInfo {
  version: string;
  publishedAt: string;
  /** Null when the release cannot be automatically verified. */
  downloadUrl: string | null;
  /** SHA-256 sidecar for downloadUrl. */
  checksumUrl: string | null;
  releaseUrl: string;
  releaseNotes: string;
}

export interface ReleaseListItem extends ReleaseInfo {
  tag: string;
  prerelease: boolean;
}

export type ReleaseRuntimeKind = RuntimeKind | 'generic-onebot-v11' | 'unknown';

let currentVersion = '1.0.0';

export function setCurrentVersion(version: string): void {
  currentVersion = version;
}

export function getCurrentVersion(): string {
  return currentVersion;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeDownloadUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    validateDownloadUrl(value);
    return new URL(value).href;
  } catch {
    return null;
  }
}

function releasePageUrl(value: unknown, repo: string, tag: string): string {
  const [owner, name] = repo.split('/');
  const fallback = `https://github.com/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}/releases/tag/${encodeURIComponent(tag)}`;
  if (typeof value !== 'string' || value.length > 2048) return fallback;
  try {
    const url = new URL(value);
    const expectedPrefix = `/${owner}/${name}/releases/`;
    if (
      url.origin !== 'https://github.com'
      || url.username
      || url.password
      || !url.pathname.startsWith(expectedPrefix)
    ) return fallback;
    return url.href;
  } catch {
    return fallback;
  }
}

function releaseAssetUrl(value: unknown, repo: string, tag: string, assetName: string): string | null {
  const safe = safeDownloadUrl(value);
  if (!safe) return null;
  const [owner, name, extra] = repo.split('/');
  if (!owner || !name || extra !== undefined) return null;
  try {
    const url = new URL(safe);
    if (url.origin !== 'https://github.com') return null;
    const segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (
      segments.length !== 6
      || segments[0] !== owner
      || segments[1] !== name
      || segments[2] !== 'releases'
      || segments[3] !== 'download'
      || segments[4] !== tag
      || segments[5] !== assetName
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

function selectReleaseAssetPair(
  assets: Record<string, unknown>[],
  runtimeKind: ReleaseRuntimeKind,
  version: string,
  repo: string,
  tag: string,
): { downloadUrl: string | null; checksumUrl: string | null } {
  const acceptedArchiveNames = runtimeKind === 'napcat'
    ? [`napcat-plugin-qq-guardian-v${version}.zip`, 'napcat-plugin-qq-guardian.zip']
    : runtimeKind === 'snowluma'
      ? [`qq-guardian-snowluma-v${version}.zip`, 'qq-guardian-snowluma.zip']
      : [];

  for (const archiveName of acceptedArchiveNames) {
    const archiveMatches = assets.filter((asset) => asset['name'] === archiveName);
    if (archiveMatches.length === 0) continue;
    if (archiveMatches.length !== 1) return { downloadUrl: null, checksumUrl: null };

    const checksumName = `${archiveName}.sha256`;
    const checksumMatches = assets.filter((asset) => asset['name'] === checksumName);
    if (checksumMatches.length !== 1) return { downloadUrl: null, checksumUrl: null };

    const downloadUrl = releaseAssetUrl(archiveMatches[0]?.['browser_download_url'], repo, tag, archiveName);
    const checksumUrl = releaseAssetUrl(checksumMatches[0]?.['browser_download_url'], repo, tag, checksumName);
    return downloadUrl && checksumUrl
      ? { downloadUrl, checksumUrl }
      : { downloadUrl: null, checksumUrl: null };
  }

  return { downloadUrl: null, checksumUrl: null };
}

/** Convert untrusted GitHub API release metadata into the only shape exposed
 *  to the management UI. Asset selection is provider-specific and fail-closed:
 *  only the exact versioned name (or its explicit historical alias) plus one
 *  matching SHA-256 sidecar can become an automatic download. */
export function normalizeGitHubRelease(
  release: unknown,
  repo: string,
  runtimeKind: ReleaseRuntimeKind = 'napcat',
): ReleaseListItem | null {
  if (!isRecord(release)) return null;
  const tag = typeof release['tag_name'] === 'string' ? release['tag_name'] : '';
  const version = normalizeReleaseVersion(tag);
  if (!version) return null;
  const assets = Array.isArray(release['assets']) ? release['assets'].filter(isRecord) : [];
  const { downloadUrl, checksumUrl } = selectReleaseAssetPair(assets, runtimeKind, version, repo, tag);
  const rawPublishedAt = release['published_at'];
  const published = typeof rawPublishedAt === 'string' && rawPublishedAt.length <= 128
    ? Date.parse(rawPublishedAt)
    : Number.NaN;
  return {
    version,
    tag,
    prerelease: release['prerelease'] === true,
    publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : '',
    downloadUrl,
    checksumUrl,
    releaseUrl: releasePageUrl(release['html_url'], repo, tag),
    releaseNotes: typeof release['body'] === 'string' ? release['body'].slice(0, 100_000) : '',
  };
}

async function fetchGitHubJson(path: string): Promise<unknown> {
  const response = await fetchRemote(`https://api.github.com${path}`, {
    headers: { Accept: 'application/vnd.github+json' },
  }, {
    allowedHosts: GITHUB_API_ORIGINS,
    timeoutMs: 10_000,
  });
  if (!response.ok) {
    await releaseRemoteResponse(response);
    throw new Error(`GitHub API returned HTTP ${response.status}`);
  }
  return readResponseJson(response, MAX_RELEASE_METADATA_BYTES);
}

export async function checkForUpdate(): Promise<ReleaseInfo | null> {
  const repo = configManager.get().update.githubRepo;
  const log = getLogger().child({ module: 'update' });
  try {
    const release = await fetchGitHubJson(`/repos/${repo}/releases/latest`);
    const info = normalizeGitHubRelease(release, repo, getRuntimeHost().kind);
    if (!info?.version) {
      log.warn({ repo }, 'Update check found no usable release');
      return null;
    }
    if (!isNewerVersion(info.version, currentVersion)) {
      log.info({ latest: info.version, current: currentVersion }, 'Update check: already up to date');
      return null;
    }
    log.info({ latest: info.version, current: currentVersion, autoDownload: Boolean(info.downloadUrl) }, 'Update available');
    return info;
  } catch (error) {
    log.warn(error, 'Update check skipped');
    return null;
  }
}

export async function fetchReleases(): Promise<ReleaseListItem[]> {
  const repo = configManager.get().update.githubRepo;
  const log = getLogger().child({ module: 'update' });
  try {
    const releases = await fetchGitHubJson(`/repos/${repo}/releases?per_page=100`);
    if (!Array.isArray(releases)) return [];
    const runtimeKind = getRuntimeHost().kind;
    return releases.flatMap((release) => {
      const info = normalizeGitHubRelease(release, repo, runtimeKind);
      return info ? [info] : [];
    });
  } catch (error) {
    log.warn(error, 'Fetch releases skipped');
    return [];
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * QG-002: Independently verify a release artifact using GitHub's attestation API.
 *
 * The release workflow publishes Sigstore-anchored SLSA provenance attestations
 * via `actions/attest-build-provenance`.  These are stored outside the release
 * page, in GitHub's Sigstore instance, keyed by the artifact's digest — so a
 * tampered release would need to subvert the Sigstore transparency log to forge
 * a matching attestation, not just replace two files in the same release.
 *
 * This function checks that at minimum one attestation exists for the artifact
 * digest AND that it claims the correct repository origin.  It does not perform
 * full Rekor-log verification (which requires the Sigstore SDK); operators who
 * need fully offline or air-gapped verification should use `gh attestation verify`.
 *
 * Behaviour:
 *  - Returns 'verified' if at least one valid attestation matches the expected repo.
 *  - Returns 'none'     if the API returns 0 attestations (new/unreleased version).
 *  - Returns 'mismatch' if attestations exist but none match the expected repo.
 *  - Throws             if the API call itself fails (network error, auth error, etc.).
 */
async function verifyGitHubAttestation(
  repo: string,
  artifactDigest: string,
): Promise<'verified' | 'none' | 'mismatch'> {
  const apiPath = `/repos/${repo}/attestations/sha256:${artifactDigest}`;
  let response: unknown;
  try {
    response = await fetchGitHubJson(apiPath);
  } catch (error) {
    throw new Error(`Attestation API request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response || typeof response !== 'object' || !('attestations' in response)) {
    throw new Error('Attestation API returned an unexpected payload shape');
  }

  const attestations = (response as Record<string, unknown>)['attestations'];
  if (!Array.isArray(attestations)) throw new Error('Attestation API response.attestations is not an array');
  if (attestations.length === 0) return 'none';

  const [owner, name] = repo.split('/');
  const expectedRepoUri = `https://github.com/${owner}/${name}`;

  for (const entry of attestations) {
    if (!entry || typeof entry !== 'object') continue;
    const bundle = (entry as Record<string, unknown>)['bundle'];
    if (!bundle || typeof bundle !== 'object') continue;

    // Navigate: bundle.dsseEnvelope.payload (base64) → decoded JSON → predicate
    const envelope = (bundle as Record<string, unknown>)['dsseEnvelope'];
    if (!envelope || typeof envelope !== 'object') continue;
    const payloadB64 = (envelope as Record<string, unknown>)['payload'];
    if (typeof payloadB64 !== 'string') continue;

    let statement: unknown;
    try {
      statement = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    } catch { continue; }
    if (!statement || typeof statement !== 'object') continue;

    const predicate = (statement as Record<string, unknown>)['predicate'];
    if (!predicate || typeof predicate !== 'object') continue;

    // SLSA provenance v1: predicate.buildDefinition.externalParameters.workflow.repository
    const buildDef = (predicate as Record<string, unknown>)['buildDefinition'];
    if (buildDef && typeof buildDef === 'object') {
      const extParams = (buildDef as Record<string, unknown>)['externalParameters'];
      if (extParams && typeof extParams === 'object') {
        const workflow = (extParams as Record<string, unknown>)['workflow'];
        if (workflow && typeof workflow === 'object') {
          const repoUri = (workflow as Record<string, unknown>)['repository'];
          if (typeof repoUri === 'string' && repoUri.startsWith(expectedRepoUri)) {
            return 'verified';
          }
        }
      }
    }
  }

  return 'mismatch';
}

/**
 * Download a verified release archive only. Extraction/restart remain an
 * explicit operator action, keeping live installs recoverable on every host.
 */
export async function downloadUpdate(info: ReleaseInfo): Promise<void> {
  const normalizedVersion = normalizeReleaseVersion(info.version);
  if (!normalizedVersion) throw new Error('Update version must be a valid semantic version');
  const downloadUrl = info.downloadUrl;
  const checksumUrl = info.checksumUrl;
  if (!downloadUrl || !checksumUrl) {
    throw new Error('This release has no SHA-256 archive pair; download it manually from the release page');
  }
  validateDownloadUrl(downloadUrl);
  validateDownloadUrl(checksumUrl);

  await withLock(locks.update(), async () => {
    const log = getLogger().child({ module: 'update' });
    const backupDir = join(getRuntimeHost().paths.dataPath, 'backups');
    mkdirSync(backupDir, { recursive: true });
    const safeVersion = normalizedVersion.replace(/\+/g, '_');
    const finalPath = join(backupDir, `update-${safeVersion}.zip`);
    const unverifiedPath = `${finalPath}.unverified`;
    if (existsSync(finalPath) || existsSync(unverifiedPath)) {
      throw new Error('Update artifact already exists; remove it explicitly before downloading again');
    }

    log.info({ version: info.version }, 'Downloading verified update');
    const archive = await fetchRemote(downloadUrl, {}, {
      allowedHosts: ALLOWED_DOWNLOAD_ORIGINS,
      timeoutMs: 120_000,
    });
    if (!archive.ok) {
      await releaseRemoteResponse(archive);
      throw new Error(`Update download failed: HTTP ${archive.status}`);
    }
    const totalBytes = await writeResponseToFile(archive, unverifiedPath, MAX_UPDATE_BYTES);

    try {
      const checksum = await fetchRemote(checksumUrl, {}, {
        allowedHosts: ALLOWED_DOWNLOAD_ORIGINS,
        timeoutMs: 15_000,
      });
      if (!checksum.ok) {
        await releaseRemoteResponse(checksum);
        throw new Error(`Checksum download failed: HTTP ${checksum.status}`);
      }
      const rawChecksum = (await readResponseBytes(checksum, MAX_CHECKSUM_BYTES)).toString('utf8').trim();
      const expected = rawChecksum.match(/^([a-fA-F0-9]{64})(?:\s|$)/)?.[1]?.toLowerCase();
      if (!expected) throw new Error('Release checksum file is malformed');

      const actualDigest = await sha256File(unverifiedPath);
      if (actualDigest !== expected) {
        throw new Error('Release checksum does not match the downloaded archive');
      }

      // QG-002: Independent provenance check via GitHub's Sigstore attestation API.
      // The attestation is stored outside the release page (in GitHub's Sigstore
      // instance keyed by digest) so it cannot be forged merely by replacing
      // release assets.  Fail closed on a wrong-repo attestation; warn (do not
      // fail) when no attestation is present yet — newer releases will have it
      // but rare edge cases (manual uploads, very fast release publication) may
      // not.  Log the outcome either way so operators can audit it.
      const repo = configManager.get().update.githubRepo;
      try {
        const attestationResult = await verifyGitHubAttestation(repo, actualDigest);
        if (attestationResult === 'verified') {
          log.info({ version: info.version }, 'Release artifact attestation verified against expected repository');
        } else if (attestationResult === 'none') {
          log.warn(
            { version: info.version },
            'No Sigstore attestation found for this release artifact; checksum-only verification used. '
            + 'Run `gh attestation verify` out-of-band if independent provenance verification is required.',
          );
        } else {
          // 'mismatch': attestations exist but none match the expected repo —
          // this is the supply-chain tamper signal.  Fail hard.
          throw new Error(
            'Release artifact attestation FAILED: attestations exist but none reference the expected '
            + `repository ${repo}. This may indicate a supply-chain attack. Do not use this artifact.`,
          );
        }
      } catch (attestErr) {
        if (attestErr instanceof Error && attestErr.message.startsWith('Release artifact attestation FAILED')) {
          throw attestErr;
        }
        // Attestation API unreachable (network, rate limit, GitHub outage).
        // Do not block the update — we already verified the SHA-256; log clearly.
        log.warn(
          { version: info.version, error: attestErr instanceof Error ? attestErr.message : String(attestErr) },
          'Could not contact GitHub attestation API; proceeding with checksum-only verification. '
          + 'Run `gh attestation verify` out-of-band when possible.',
        );
      }

      renameSync(unverifiedPath, finalPath);
    } catch (error) {
      try { unlinkSync(unverifiedPath); } catch { /* best effort */ }
      throw error;
    }

    log.info({ version: info.version, path: finalPath, bytes: totalBytes }, 'Verified update downloaded; extract it and restart Guardian to apply');
    bus.emit('AuditCreated', {
      action: 'plugin.update_downloaded',
      actorId: null,
      targetType: 'plugin',
      targetId: 'qq-guardian',
      details: { fromVersion: currentVersion, toVersion: info.version, downloadPath: finalPath },
      timestamp: Date.now(),
    });
  });
}

export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (value: string): [number, number, number] => {
    const parts = value.split('.').map((part) => Math.max(0, Number.parseInt(part, 10) || 0));
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };
  const [latestMajor, latestMinor, latestPatch] = parse(latest);
  const [currentMajor, currentMinor, currentPatch] = parse(current);
  if (latestMajor !== currentMajor) return latestMajor > currentMajor;
  if (latestMinor !== currentMinor) return latestMinor > currentMinor;
  return latestPatch > currentPatch;
}
