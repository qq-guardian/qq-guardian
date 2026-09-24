/**
 * Integration tests — verify the build output is structurally sound.
 *
 * Run with:  pnpm run test:integration
 * Requires:  dist/index.mjs to exist (run `pnpm run build` first)
 *            Node >= 22.6.0  (--experimental-strip-types)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// __dirname shim for ESM + --experimental-strip-types environment
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT = join(__dirname, '../..');

describe('dist/ integrity', () => {
  it('dist/index.mjs exists', () => {
    assert.ok(existsSync(join(ROOT, 'dist/index.mjs')),
      'dist/index.mjs not found — run `pnpm run build` first');
  });

  it('dist/index.mjs is non-empty (> 50 KB)', () => {
    const size = statSync(join(ROOT, 'dist/index.mjs')).size;
    assert.ok(size > 50_000, `dist/index.mjs is only ${size} bytes — build may have failed`);
  });

  it('dist/package.json has required fields', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'dist/package.json'), 'utf-8'));
    assert.ok(pkg.name,        'dist/package.json missing name');
    assert.ok(pkg.version,     'dist/package.json missing version');
    assert.ok(pkg.main,        'dist/package.json missing main');
    assert.ok(pkg.napcat?.tags?.length, 'dist/package.json missing napcat.tags');
  });

  it('dist/package.json does NOT contain jwtSecret in plain text', () => {
    const raw = readFileSync(join(ROOT, 'dist/package.json'), 'utf-8');
    assert.ok(!raw.includes('jwtSecret'), 'jwtSecret found in dist/package.json — config leak!');
  });

  it('dist/webui/index.html exists', () => {
    assert.ok(existsSync(join(ROOT, 'dist/webui/index.html')));
  });

  it('keeps the plugin icon at the package root, not under webui', () => {
    assert.ok(existsSync(join(ROOT, 'dist/plugin-icon.png')));
    assert.equal(existsSync(join(ROOT, 'dist/webui/plugin-icon.png')), false);
    assert.equal(existsSync(join(ROOT, 'dist-snowluma/webui/plugin-icon.png')), false);
  });

  it('plugin.json has valid JSON and required fields', () => {
    const plugin = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf-8'));
    assert.ok(plugin.name,    'plugin.json missing name');
    assert.ok(plugin.version, 'plugin.json missing version');
    assert.ok(plugin.icon,    'plugin.json missing icon');
    assert.equal(plugin.main, 'dist/index.mjs');
  });

  it('uses dist/index.mjs as the only source-checkout NapCat bundle', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    assert.equal(pkg.main, 'dist/index.mjs');
    assert.equal(existsSync(join(ROOT, 'index.mjs')), false);
    assert.equal(existsSync(join(ROOT, 'index.mjs.map')), false);
  });

  it('dist/index.mjs exports plugin lifecycle hooks', () => {
    const src = readFileSync(join(ROOT, 'dist/index.mjs'), 'utf-8');
    assert.ok(src.includes('plugin_init'),    'plugin_init not found in bundle');
    assert.ok(src.includes('plugin_cleanup'), 'plugin_cleanup not found in bundle');
    assert.ok(src.includes('plugin_onevent'), 'plugin_onevent not found in bundle');
  });

  it('loads the standalone SnowLuma ESM bundle through bundled CommonJS dependencies', () => {
    const result = spawnSync(process.execPath, [join(ROOT, 'dist-snowluma/index.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, SNOWLUMA_TRANSPORT: 'build-smoke-invalid' },
      timeout: 10_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.error, undefined, output);
    assert.equal(result.status, 1, output);
    assert.match(output, /SNOWLUMA_TRANSPORT must be/, output);
    assert.doesNotMatch(output, /Dynamic require of/, output);
  });

  it('dist/index.mjs does not contain /update/apply (should be /update/download)', () => {
    const src = readFileSync(join(ROOT, 'dist/index.mjs'), 'utf-8');
    assert.ok(!src.includes("'/update/apply'"),
      'Found deprecated /update/apply route in bundle — should be /update/download');
  });

  it('webui/index.html does not reference /update/apply', () => {
    const src = readFileSync(join(ROOT, 'dist/webui/app.js'), 'utf-8');
    assert.ok(!src.includes('/update/apply'),
      'WebUI still references deprecated /update/apply — update the fetch call');
  });

  it('ships external WebUI scripts under a CSP that blocks inline JavaScript', () => {
    for (const output of ['dist', 'dist-snowluma']) {
      const htmlPath = join(ROOT, output, 'webui/index.html');
      const html = readFileSync(htmlPath, 'utf-8');
      assert.ok(existsSync(join(ROOT, output, 'webui/app.js')), `${output} is missing webui/app.js`);
      assert.ok(existsSync(join(ROOT, output, 'webui/release-view.js')), `${output} is missing webui/release-view.js`);
      assert.match(html, /<script src="\.\.\/files\/static\/release-view\.js"><\/script>/);
      assert.match(html, /<script src="\.\.\/files\/static\/app\.js"><\/script>/);
      assert.doesNotMatch(html, /<script\s*>/i, `${output} contains an inline script block`);
      assert.match(html, /script-src 'self'/);
      assert.doesNotMatch(html, /script-src[^;]*'unsafe-inline'/);
    }
  });
});

describe('source integrity', () => {
  it('has no unresolved merge-conflict markers', () => {
    const offenders = listSourceFiles(join(ROOT, 'src'))
      .filter((file) => /^(?:<{7}|={7}|>{7})/m.test(readFileSync(file, 'utf-8')))
      .map((file) => file.slice(ROOT.length + 1));
    assert.deepEqual(offenders, []);
  });
});

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? listSourceFiles(path) : [path];
  });
}
