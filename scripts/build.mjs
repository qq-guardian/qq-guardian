#!/usr/bin/env node
/**
 * Dual-target build script.
 *
 * NapCat:   src/index.ts     -> dist/index.mjs
 * SnowLuma: src/snowluma.ts  -> dist-snowluma/index.mjs
 *
 * Both bundles are self-contained. SnowLuma's official SDK is bundled into
 * its standalone artifact; only Node.js built-ins remain external.
 *
 * Run: node scripts/build.mjs [--watch]
 */
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { buildProductionWebUi } from './lib/webui-build.mjs';

const watch = process.argv.includes('--watch');

const EXTERNAL = [
  'node:*',
  'crypto', 'fs', 'path', 'url', 'events', 'os', 'http', 'https',
  'stream', 'buffer', 'util', 'net', 'child_process', 'worker_threads',
  'assert', 'tls', 'zlib', 'perf_hooks',
];

const commonBuildOpts = {
  bundle: true,
  platform: 'node',
  target: ['node22'],
  format: 'esm',
  external: EXTERNAL,
  sourcemap: 'external',
  minify: false,
  tsconfig: 'tsconfig.json',
  logLevel: 'warning',
};

// SnowLuma bundles CommonJS dependencies such as ws into an ESM entry point.
// Give esbuild's CommonJS shim a native require for external Node.js built-ins
// while keeping the published runtime self-contained.
const SNOWLUMA_ESM_BANNER = [
  "import { createRequire as __qqGuardianCreateRequire } from 'node:module';",
  'const require = __qqGuardianCreateRequire(import.meta.url);',
].join('\n');

/** @type {esbuild.BuildOptions} */
const napcatBuildOpts = {
  ...commonBuildOpts,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.mjs',
};

/** @type {esbuild.BuildOptions} */
const snowlumaBuildOpts = {
  ...commonBuildOpts,
  entryPoints: ['src/snowluma.ts'],
  outfile: 'dist-snowluma/index.mjs',
  banner: { js: SNOWLUMA_ESM_BANNER },
};

function readMetadata() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
  const rootPlugin = JSON.parse(readFileSync('plugin.json', 'utf-8'));
  return { pkg, rootPlugin: { ...rootPlugin, version: pkg.version } };
}

function copyWebAssets(outDir) {
  const webuiDir = join(outDir, 'webui');
  mkdirSync(webuiDir, { recursive: true });
  rmSync(join(webuiDir, 'plugin-icon.png'), { force: true });
  if (existsSync(join('webui', 'index.html'))) {
    const source = readFileSync(join('webui', 'index.html'), 'utf8');
    const production = buildProductionWebUi(source);
    writeFileSync(join(webuiDir, 'index.html'), production.html, 'utf8');
    writeFileSync(join(webuiDir, 'app.js'), production.appScript, 'utf8');
    copyFileSync(join('webui', 'release-view.js'), join(webuiDir, 'release-view.js'));
    copyFileSync(join('webui', 'user-security.js'), join(webuiDir, 'user-security.js'));
  }
  if (existsSync('plugin-icon.png')) {
    copyFileSync('plugin-icon.png', join(outDir, 'plugin-icon.png'));
  }
}

function writeNapCatMetadata() {
  const { pkg, rootPlugin } = readMetadata();
  const distPkg = {
    name: pkg.name,
    plugin: rootPlugin.plugin,
    version: pkg.version,
    type: 'module',
    main: 'index.mjs',
    description: pkg.description,
    author: pkg.author,
    license: pkg.license,
    icon: 'plugin-icon.png',
    napcat: pkg.napcat,
    homepage: pkg.homepage,
  };
  writeFileSync(join('dist', 'package.json'), JSON.stringify(distPkg, null, 2) + '\n', 'utf-8');
  writeFileSync(
    join('dist', 'plugin.json'),
    JSON.stringify({ ...rootPlugin, version: pkg.version, main: 'index.mjs' }, null, 2) + '\n',
    'utf-8',
  );
}

function writeSnowLumaMetadata() {
  const { pkg } = readMetadata();
  const runtimePkg = {
    name: 'qq-guardian-snowluma-runtime',
    version: pkg.version,
    private: true,
    type: 'module',
    main: 'index.mjs',
    description: 'QQ Guardian standalone runtime for SnowLuma OneBot v11',
    author: pkg.author,
    license: pkg.license,
    engines: pkg.engines,
    homepage: pkg.homepage,
  };
  writeFileSync(join('dist-snowluma', 'package.json'), JSON.stringify(runtimePkg, null, 2) + '\n', 'utf-8');
}

function refreshAssetsAndMetadata() {
  copyWebAssets('dist');
  copyWebAssets('dist-snowluma');
  writeNapCatMetadata();
  writeSnowLumaMetadata();
}

async function buildOnce() {
  mkdirSync(join('dist', 'webui'), { recursive: true });
  mkdirSync(join('dist-snowluma', 'webui'), { recursive: true });

  const [napcat, snowluma] = await Promise.all([
    esbuild.build(napcatBuildOpts),
    esbuild.build(snowlumaBuildOpts),
  ]);
  const errors = [...napcat.errors, ...snowluma.errors];
  if (errors.length > 0) {
    console.error('✗ Build failed:', errors.map(e => e.text).join('\n'));
    process.exit(1);
  }

  refreshAssetsAndMetadata();

  const napcatSize = statSync('dist/index.mjs').size;
  const snowlumaSize = statSync('dist-snowluma/index.mjs').size;
  console.log(`✓ dist/index.mjs           ${(napcatSize / 1024).toFixed(0)} KB  (NapCat)`);
  console.log(`✓ dist-snowluma/index.mjs  ${(snowlumaSize / 1024).toFixed(0)} KB  (SnowLuma)`);
  console.log('✓ shared WebUI assets copied to both targets');
}

async function buildWatch() {
  refreshAssetsAndMetadata();
  const notify = (label) => ({
    name: `rebuild-notify-${label}`,
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length === 0) {
          refreshAssetsAndMetadata();
          console.log(`[${new Date().toLocaleTimeString()}] Rebuilt ${label}`);
        }
      });
    },
  });

  const napcatCtx = await esbuild.context({ ...napcatBuildOpts, plugins: [notify('NapCat')] });
  const snowlumaCtx = await esbuild.context({ ...snowlumaBuildOpts, plugins: [notify('SnowLuma')] });
  await Promise.all([napcatCtx.watch(), snowlumaCtx.watch()]);
  console.log('Watching NapCat + SnowLuma targets… (Ctrl+C to stop)');
}

watch ? buildWatch().catch(e => { console.error(e); process.exit(1); })
      : buildOnce().catch(e => { console.error(e); process.exit(1); });
