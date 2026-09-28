import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeGitHubRelease } from '../../src/modules/update/index.ts';

describe('provider-specific release routing', () => {
  it('selects the exact versioned SnowLuma archive and checksum', () => {
    const release = normalizeGitHubRelease({
      tag_name: 'v1.4.0',
      assets: [
        {
          name: 'napcat-plugin-qq-guardian-v1.4.0.zip',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v1.4.0/napcat-plugin-qq-guardian-v1.4.0.zip',
        },
        {
          name: 'napcat-plugin-qq-guardian-v1.4.0.zip.sha256',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v1.4.0/napcat-plugin-qq-guardian-v1.4.0.zip.sha256',
        },
        {
          name: 'qq-guardian-snowluma-v1.4.0.zip.sha256',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v1.4.0/qq-guardian-snowluma-v1.4.0.zip.sha256',
        },
        {
          name: 'qq-guardian-snowluma-v1.4.0.zip',
          browser_download_url: 'https://github.com/owner/repo/releases/download/v1.4.0/qq-guardian-snowluma-v1.4.0.zip',
        },
      ],
    }, 'owner/repo', 'snowluma');

    assert.equal(
      release?.downloadUrl,
      'https://github.com/owner/repo/releases/download/v1.4.0/qq-guardian-snowluma-v1.4.0.zip',
    );
    assert.equal(
      release?.checksumUrl,
      'https://github.com/owner/repo/releases/download/v1.4.0/qq-guardian-snowluma-v1.4.0.zip.sha256',
    );
  });
});
