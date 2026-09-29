import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('SnowLuma deployment guide tracks current official documentation routes', () => {
  const guide = readFileSync(join(ROOT, 'docs', 'deployment', 'snowluma.md'), 'utf8');

  for (const url of [
    'https://snowluma.github.io/en/docs/guide/deploy/docker',
    'https://snowluma.github.io/en/docs/guide/deploy/windows',
    'https://snowluma.github.io/en/docs/guide/deploy/windows-docker',
    'https://snowluma.github.io/en/docs/guide/deploy/wsl2',
    'https://snowluma.github.io/en/docs/guide/deploy/mobile',
    'https://snowluma.github.io/en/docs/guide/deploy/linux-manual',
    'https://snowluma.github.io/en/docs/guide/quickstart',
    'https://snowluma.github.io/en/docs/guide/configuration',
    'https://snowluma.github.io/en/docs/sdk',
  ]) {
    assert.ok(guide.includes(url), `missing current SnowLuma documentation URL: ${url}`);
  }

  assert.equal(guide.includes('https://snowluma.github.io/en/guide/deploy/docker.html'), false);
  assert.equal(guide.includes('https://snowluma.github.io/en/guide/deploy/windows.html'), false);
  assert.equal(guide.includes('https://snowluma.github.io/en/guide/deploy/windows-docker.html'), false);
  assert.equal(guide.includes('https://snowluma.github.io/en/guide/deploy/wsl2.html'), false);
  assert.equal(guide.includes('https://snowluma.github.io/en/guide/deploy/mobile.html'), false);
  assert.equal(guide.includes('https://snowluma.github.io/en/guide/deploy/linux-manual.html'), false);
  assert.equal(guide.includes('https://snowluma.github.io/en/guide/quickstart.html'), false);
  assert.equal(guide.includes('https://snowluma.github.io/en/guide/configuration.html'), false);
  assert.equal(guide.includes('https://snowluma.github.io/sdk/index.html'), false);
  assert.match(guide, /Node\.js \*\*22\.13\+\*\*/);
});
