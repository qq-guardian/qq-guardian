#!/usr/bin/env node
/** Build source-complete, deployable QQ Guardian release archives. */
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectArchiveEntries,
  writeDeterministicTarGzip,
  writeDeterministicZip,
  writeSha256Sidecar,
} from './lib/deterministic-zip.mjs';
import {
  isNapCatRuntimeReleaseFile,
  isRepositoryReleaseFile,
  isProjectSourceReleaseFile,
  isSnowLumaDeploymentReleaseFile,
  isSnowLumaRuntimeReleaseFile,
} from './lib/release-entry-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArguments(process.argv.slice(2));
const pkg = readJson(join(ROOT, 'package.json'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  throw new Error(`Release archives require a stable SemVer package version, got ${JSON.stringify(pkg.version)}`);
}

const platform = options.platform ?? `${process.platform}-${process.arch}`;
if (!/^[a-z0-9][a-z0-9._-]*$/i.test(platform)) throw new Error(`Invalid platform name: ${platform}`);
const flavorSuffix = options.flavor === 'full' ? `full-${platform}` : 'lite';
const archiveBase = `qq-guardian-v${pkg.version}-${flavorSuffix}`;
const bundleRoot = `qq-guardian-v${pkg.version}`;
const outputDirectory = resolve(ROOT, options.outputDirectory);

const rootFiles = [
  '.dockerignore',
  '.gitignore',
  'LICENSE',
  'README.md',
  'package.json',
  'plugin-icon.png',
  'plugin.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
];
for (const name of rootFiles) requireFile(join(ROOT, name), name);
requireFile(join(ROOT, 'dist', 'index.mjs'), 'NapCat build output');
requireFile(join(ROOT, 'dist-snowluma', 'index.mjs'), 'SnowLuma build output');

const entries = collectArchiveEntries(options.flavor === 'full'
  ? [
    ...trackedRepositorySources(bundleRoot, outputDirectory),
    {
      directory: join(ROOT, 'dist-snowluma'),
      prefix: `${bundleRoot}/dist-snowluma`,
      include: (path) => isSnowLumaRuntimeReleaseFile(join(ROOT, 'dist-snowluma'), path),
    },
  ]
  : [
    ...trackedLiteSources(bundleRoot),
    // SnowLuma output is generated from reviewed source during the release
    // job and is intentionally not committed. Its explicit runtime allowlist
    // is the only untracked content accepted by either project bundle.
    {
      directory: join(ROOT, 'dist-snowluma'),
      prefix: `${bundleRoot}/dist-snowluma`,
      include: (path) => isSnowLumaRuntimeReleaseFile(join(ROOT, 'dist-snowluma'), path),
    },
  ]);

if (options.flavor === 'full') addNodeRuntime(entries, bundleRoot, platform, options);
entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

const zipPath = join(outputDirectory, `${archiveBase}.zip`);
const tarPath = join(outputDirectory, `${archiveBase}.tar.gz`);
writeDeterministicZip({ outputPath: zipPath, entries });
writeDeterministicTarGzip({ outputPath: tarPath, entries });
const zipChecksum = writeSha256Sidecar(zipPath);
const tarChecksum = writeSha256Sidecar(tarPath);

if (options.compatibilityAsset) {
  if (options.flavor !== 'full') throw new Error('--compatibility-asset requires --flavor=full');
  const compatibilityPath = join(outputDirectory, 'releaseDownload.zip');
  copyFileSync(zipPath, compatibilityPath);
  writeSha256Sidecar(compatibilityPath);
}

console.log(`✓ ${relative(ROOT, zipPath)}  ${(statSync(zipPath).size / 1024).toFixed(0)} KB  ${zipChecksum.digest}`);
console.log(`✓ ${relative(ROOT, tarPath)}  ${(statSync(tarPath).size / 1024).toFixed(0)} KB  ${tarChecksum.digest}`);
console.log(`✓ ${entries.length} reviewed files (${options.flavor}, ${platform})`);

function trackedRepositorySources(prefix, generatedOutputDirectory) {
  return trackedRepositoryFiles()
    .filter(({ path }) => isRepositoryReleaseFile(ROOT, path, generatedOutputDirectory))
    .map(({ name, path }) => ({ file: path, name, prefix }));
}

function trackedLiteSources(prefix) {
  const reviewedRoots = new Set(['src', 'webui', 'intel', 'scripts', 'docs']);
  const reviewedRootFiles = new Set(rootFiles);
  return trackedRepositoryFiles()
    .filter(({ name, path }) => {
      if (reviewedRootFiles.has(name)) return true;
      const [top] = name.split('/');
      if (reviewedRoots.has(top)) return isProjectSourceReleaseFile(join(ROOT, top), path);
      if (top === 'deploy') return isSnowLumaDeploymentReleaseFile(join(ROOT, 'deploy'), path);
      if (top === 'dist') return isNapCatRuntimeReleaseFile(join(ROOT, 'dist'), path);
      return false;
    })
    .map(({ name, path }) => ({ file: path, name, prefix }));
}

function trackedRepositoryFiles() {
  const git = process.env.GIT_EXECUTABLE || 'git';
  const result = spawnSync(git, [
    '-c', `safe.directory=${ROOT}`,
    'ls-files', '-z', '--cached',
  ], { cwd: ROOT, encoding: 'buffer' });
  if (result.status !== 0) {
    throw new Error(`Could not enumerate tracked release files: ${result.stderr?.toString('utf8').trim() || 'git failed'}`);
  }
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((name) => ({ name, path: join(ROOT, ...name.split('/')) }));
}

function addNodeRuntime(target, prefix, targetPlatform, parsedOptions) {
  const binaryPath = resolve(parsedOptions.nodeBinary ?? process.execPath);
  requireFile(binaryPath, 'Node.js runtime executable');
  const licensePath = parsedOptions.nodeLicense
    ? resolve(parsedOptions.nodeLicense)
    : findNodeLicense(binaryPath);
  requireFile(licensePath, 'Node.js runtime license');
  const windows = targetPlatform.startsWith('win32-') || targetPlatform.startsWith('windows-');
  target.push(
    {
      name: `${prefix}/runtime/node/${windows ? 'node.exe' : 'bin/node'}`,
      data: readFileSync(binaryPath),
      mode: windows ? 0o644 : 0o755,
    },
    {
      name: `${prefix}/runtime/node/LICENSE`,
      data: readFileSync(licensePath),
      mode: 0o644,
    },
    {
      name: `${prefix}/runtime/node/runtime.json`,
      data: Buffer.from(`${JSON.stringify({ node: process.version, platform: targetPlatform }, null, 2)}\n`),
      mode: 0o644,
    },
  );
}

function findNodeLicense(binaryPath) {
  const candidates = [
    join(dirname(binaryPath), 'LICENSE'),
    join(dirname(dirname(binaryPath)), 'LICENSE'),
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) {
    throw new Error('Could not locate the Node.js LICENSE beside the runtime; pass --node-license=<path>');
  }
  return match;
}

function parseArguments(args) {
  const value = (name) => args.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
  const flavor = value('--flavor') ?? 'lite';
  if (!['full', 'lite'].includes(flavor)) throw new Error('--flavor must be full or lite');
  return {
    flavor,
    platform: value('--platform'),
    nodeBinary: value('--node-binary'),
    nodeLicense: value('--node-license'),
    outputDirectory: value('--output-dir') ?? 'release',
    compatibilityAsset: args.includes('--compatibility-asset'),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is missing: ${path}`);
}
