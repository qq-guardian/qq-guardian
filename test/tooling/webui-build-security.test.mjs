import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildProductionWebUi } from '../../scripts/lib/webui-build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('production WebUI build policy', () => {
  it('extracts the application and emits an inline-script-free document', () => {
    const source = readFileSync(join(ROOT, 'webui/index.html'), 'utf8');
    const production = buildProductionWebUi(source);
    assert.match(production.html, /<script src="\.\.\/files\/static\/release-view\.js"><\/script>/);
    assert.match(production.html, /<script src="\.\.\/files\/static\/user-security\.js"><\/script>/);
    assert.match(production.html, /<script src="\.\.\/files\/static\/app\.js"><\/script>/);
    assert.doesNotMatch(production.html, /<script\b(?![^>]*\bsrc\s*=)[^>]*>/i);
    assert.match(production.html, /script-src 'self'/);
    assert.doesNotMatch(production.html, /script-src[^;\"]*'unsafe-inline'/);
    assert.match(production.appScript, /async function loadUpdate\(\)/);
  });

  it('fails closed if another inline script would survive extraction', () => {
    const source = [
      '<meta http-equiv="Content-Security-Policy" content="script-src \'self\' \'unsafe-inline\'">',
      '<script>',
      'console.log(1);',
      '</script>',
      '<script type="module">console.log(2);</script>',
    ].join('\n');
    assert.throws(() => buildProductionWebUi(source), /must not contain inline script/);
  });

  it('fails closed when the expected CSP contract is absent', () => {
    assert.throws(
      () => buildProductionWebUi('<script>\nconsole.log(1);\n</script>'),
      /development script policy/,
    );
  });
});
