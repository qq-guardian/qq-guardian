import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  downloadUpdate,
  normalizeGitHubRelease,
  normalizeReleaseVersion,
  validateDownloadUrl,
} from '../../src/modules/update/index.ts';

describe('release metadata trust boundary', () => {
  it('canonicalizes valid current and exact historical SemVer tags', () => {
    assert.equal(normalizeReleaseVersion('1.2.3'), '1.2.3');
    assert.equal(normalizeReleaseVersion('v1.2.3'), '1.2.3');
    assert.equal(normalizeReleaseVersion('2.0.0-rc.1+build.7'), '2.0.0-rc.1+build.7');
    assert.equal(normalizeReleaseVersion('napcat-plugin-qq-guardianv1.3.0'), '1.3.0');
  });

  it('rejects malformed, executable, encoded, and unbounded tags', () => {
    const rejected = [
      null,
      123,
      '',
      '1.2',
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '1.2.3-01',
      '1.2.3/../../plugin',
      'napcat-plugin-qq-guardian-1.2.3',
      'napcat-plugin-qq-guardianv1.2.3/../../plugin',
      'v1.2.3%22%20onmouseover%3Dalert(1)',
      '<img src=x onerror=alert(1)>',
      '1.2.3\n<script>alert(1)</script>',
      '9'.repeat(129),
    ];
    for (const value of rejected) assert.equal(normalizeReleaseVersion(value), null, String(value));
  });

  it('normalizes valid NapCat metadata and preserves release notes as inert data', () => {
    const release = normalizeGitHubRelease({
      tag_name: 'v1.4.0-rc.1',
      published_at: '2026-08-24T12:34:56Z',
      body: '<img src=x onerror=alert(1)>',
      html_url: 'https://github.com/owner/repo/releases/tag/v1.4.0-rc.1',
      prerelease: true,
      assets: [
        {
          name: 'qq-guardian-snowluma-v1.4.0-rc.1.zip',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v1.4.0-rc.1/qq-guardian-snowluma-v1.4.0-rc.1.zip',
        },
        {
          name: 'releaseDownload.zip',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v1.4.0-rc.1/releaseDownload.zip',
        },
        {
          name: 'napcat-plugin-qq-guardian.zip',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v1.4.0-rc.1/napcat-plugin-qq-guardian.zip',
        },
        {
          name: 'napcat-plugin-qq-guardian-v1.4.0-rc.1.zip',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v1.4.0-rc.1/napcat-plugin-qq-guardian-v1.4.0-rc.1.zip',
        },
        {
          name: 'napcat-plugin-qq-guardian-v1.4.0-rc.1.zip.sha256',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v1.4.0-rc.1/napcat-plugin-qq-guardian-v1.4.0-rc.1.zip.sha256',
        },
      ],
    }, 'owner/repo', 'napcat');

    assert.deepEqual(release, {
      version: '1.4.0-rc.1',
      tag: 'v1.4.0-rc.1',
      prerelease: true,
      publishedAt: '2026-08-24T12:34:56.000Z',
      downloadUrl: 'https://github.com/owner/repo/releases/download/v1.4.0-rc.1/napcat-plugin-qq-guardian-v1.4.0-rc.1.zip',
      checksumUrl: 'https://github.com/owner/repo/releases/download/v1.4.0-rc.1/napcat-plugin-qq-guardian-v1.4.0-rc.1.zip.sha256',
      releaseUrl: 'https://github.com/owner/repo/releases/tag/v1.4.0-rc.1',
      releaseNotes: '<img src=x onerror=alert(1)>',
    });
  });

  it('falls back only to the exact legacy NapCat alias', () => {
    const release = normalizeGitHubRelease({
      tag_name: 'v1.3.0',
      assets: [
        {
          name: 'qq-guardian-snowluma.zip',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v1.3.0/qq-guardian-snowluma.zip',
        },
        {
          name: 'napcat-plugin-qq-guardian.zip',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v1.3.0/napcat-plugin-qq-guardian.zip',
        },
        {
          name: 'napcat-plugin-qq-guardian.zip.sha256',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v1.3.0/napcat-plugin-qq-guardian.zip.sha256',
        },
      ],
    }, 'owner/repo', 'napcat');

    assert.equal(release?.downloadUrl, 'https://github.com/owner/repo/releases/download/v1.3.0/napcat-plugin-qq-guardian.zip');
    assert.equal(release?.checksumUrl, 'https://github.com/owner/repo/releases/download/v1.3.0/napcat-plugin-qq-guardian.zip.sha256');
  });

  it('selects the historical SnowLuma archive regardless of mixed asset ordering', () => {
    const tag = 'napcat-plugin-qq-guardianv1.3.0';
    const release = normalizeGitHubRelease({
      tag_name: tag,
      assets: [
        {
          name: 'napcat-plugin-qq-guardian.zip.sha256',
          browser_download_url: `https://github.com/owner/repo/releases/download/${tag}/napcat-plugin-qq-guardian.zip.sha256`,
        },
        {
          name: 'qq-guardian-snowluma.zip.sha256',
          browser_download_url: `https://github.com/owner/repo/releases/download/${tag}/qq-guardian-snowluma.zip.sha256`,
        },
        {
          name: 'qq-guardian-snowluma-v1.3.0.zip.exe',
          browser_download_url: `https://github.com/owner/repo/releases/download/${tag}/qq-guardian-snowluma-v1.3.0.zip.exe`,
        },
        {
          name: 'napcat-plugin-qq-guardian.zip',
          browser_download_url: `https://github.com/owner/repo/releases/download/${tag}/napcat-plugin-qq-guardian.zip`,
        },
        {
          name: 'qq-guardian-snowluma.zip',
          browser_download_url: `https://github.com/owner/repo/releases/download/${tag}/qq-guardian-snowluma.zip`,
        },
      ],
    }, 'owner/repo', 'snowluma');

    assert.equal(
      release?.downloadUrl,
      `https://github.com/owner/repo/releases/download/${tag}/qq-guardian-snowluma.zip`,
    );
    assert.equal(
      release?.checksumUrl,
      `https://github.com/owner/repo/releases/download/${tag}/qq-guardian-snowluma.zip.sha256`,
    );
  });

  it('fails closed on missing, duplicate, and mismatched provider asset pairs', () => {
    const missingChecksum = normalizeGitHubRelease({
      tag_name: 'v2.0.0',
      assets: [{
        name: 'qq-guardian-snowluma-v2.0.0.zip',
        browser_download_url: 'https://github.com/owner/repo/releases/download/v2.0.0/qq-guardian-snowluma-v2.0.0.zip',
      }],
    }, 'owner/repo', 'snowluma');
    assert.equal(missingChecksum?.downloadUrl, null);
    assert.equal(missingChecksum?.checksumUrl, null);

    const duplicateArchive = normalizeGitHubRelease({
      tag_name: 'v2.0.0',
      assets: [
        {
          name: 'napcat-plugin-qq-guardian-v2.0.0.zip',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v2.0.0/napcat-plugin-qq-guardian-v2.0.0.zip',
        },
        {
          name: 'napcat-plugin-qq-guardian-v2.0.0.zip',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v2.0.0/napcat-plugin-qq-guardian-v2.0.0.zip',
        },
        {
          name: 'napcat-plugin-qq-guardian-v2.0.0.zip.sha256',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v2.0.0/napcat-plugin-qq-guardian-v2.0.0.zip.sha256',
        },
      ],
    }, 'owner/repo', 'napcat');
    assert.equal(duplicateArchive?.downloadUrl, null);
    assert.equal(duplicateArchive?.checksumUrl, null);

    const duplicateChecksum = normalizeGitHubRelease({
      tag_name: 'v2.0.1',
      assets: [
        {
          name: 'qq-guardian-snowluma-v2.0.1.zip',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v2.0.1/qq-guardian-snowluma-v2.0.1.zip',
        },
        {
          name: 'qq-guardian-snowluma-v2.0.1.zip.sha256',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v2.0.1/qq-guardian-snowluma-v2.0.1.zip.sha256',
        },
        {
          name: 'qq-guardian-snowluma-v2.0.1.zip.sha256',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v2.0.1/qq-guardian-snowluma-v2.0.1.zip.sha256',
        },
      ],
    }, 'owner/repo', 'snowluma');
    assert.equal(duplicateChecksum?.downloadUrl, null);
    assert.equal(duplicateChecksum?.checksumUrl, null);

    const wrongRepository = normalizeGitHubRelease({
      tag_name: 'v2.1.0',
      assets: [
        {
          name: 'qq-guardian-snowluma-v2.1.0.zip',
          browser_download_url: 'https://github.com/other/repo/releases/download/v2.1.0/qq-guardian-snowluma-v2.1.0.zip',
        },
        {
          name: 'qq-guardian-snowluma-v2.1.0.zip.sha256',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v2.1.0/qq-guardian-snowluma-v2.1.0.zip.sha256',
        },
      ],
    }, 'owner/repo', 'snowluma');
    assert.equal(wrongRepository?.downloadUrl, null);
    assert.equal(wrongRepository?.checksumUrl, null);
  });

  it('keeps unknown compatible providers fail closed for automatic updates', () => {
    const release = normalizeGitHubRelease({
      tag_name: 'v2.1.0',
      assets: [
        {
          name: 'napcat-plugin-qq-guardian-v2.1.0.zip',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v2.1.0/napcat-plugin-qq-guardian-v2.1.0.zip',
        },
        {
          name: 'napcat-plugin-qq-guardian-v2.1.0.zip.sha256',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v2.1.0/napcat-plugin-qq-guardian-v2.1.0.zip.sha256',
        },
      ],
    }, 'owner/repo', 'unknown');
    assert.equal(release?.downloadUrl, null);
    assert.equal(release?.checksumUrl, null);
  });

  it('drops executable asset URLs and replaces an untrusted release-page URL', () => {
    const release = normalizeGitHubRelease({
      tag_name: 'v2.3.4',
      html_url: 'javascript:alert(document.domain)',
      assets: [
        { name: 'plugin.zip', browser_download_url: 'javascript:alert(1)' },
        { name: 'plugin.zip.sha256', browser_download_url: 'data:text/html,<script>alert(1)</script>' },
      ],
    }, 'owner/repo', 'napcat');

    assert.ok(release);
    assert.equal(release.downloadUrl, null);
    assert.equal(release.checksumUrl, null);
    assert.equal(release.releaseUrl, 'https://github.com/owner/repo/releases/tag/v2.3.4');
  });

  it('drops a release whose tag is not SemVer', () => {
    assert.equal(normalizeGitHubRelease({
      tag_name: 'v1.2.3\"><svg/onload=alert(1)>',
      html_url: 'https://github.com/owner/repo/releases/tag/anything',
    }, 'owner/repo', 'napcat'), null);
  });

  it('rejects custom ports and rejects a hostile version before touching the runtime', async () => {
    assert.throws(
      () => validateDownloadUrl('https://github.com:444/owner/repo/releases/download/v1.2.3/plugin.zip'),
      /credential-free HTTPS/,
    );
    await assert.rejects(downloadUpdate({
      version: '1.2.3\"><img src=x onerror=alert(1)>',
      publishedAt: '',
      downloadUrl: 'https://github.com/owner/repo/releases/download/v1.2.3/plugin.zip',
      checksumUrl: 'https://github.com/owner/repo/releases/download/v1.2.3/plugin.zip.sha256',
      releaseUrl: 'https://github.com/owner/repo/releases/tag/v1.2.3',
      releaseNotes: '',
    }), /semantic version/);
  });
});
