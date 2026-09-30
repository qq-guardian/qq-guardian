#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { readTarGzipEntryNames, readZipEntryNames } from './lib/deterministic-zip.mjs';

const archiveOption = option('--archive');
const directoryOption = option('--directory');
if (Boolean(archiveOption) === Boolean(directoryOption)) throw new Error('Pass exactly one of --archive=<path> or --directory=<path>');

const archives = archiveOption
  ? [resolve(archiveOption)]
  : readdirSync(resolve(directoryOption))
      .filter((name) => /^qq-guardian-snowluma-v\d+\.\d+\.\d+-(?:win-x64|linux-x64|linux-arm64)(?:-lite)?\.(?:zip|tar\.gz)$/i.test(name))
      .map((name) => resolve(directoryOption, name))
      .sort();

if (archives.length === 0) throw new Error('No SnowLuma provider archives found');
for (const archive of archives) verifyArchive(archive);
console.log('✓ verified ' + archives.length + ' SnowLuma provider archive(s)');

function verifyArchive(archivePath) {
  if (!existsSync(archivePath) || !statSync(archivePath).isFile()) throw new Error('Missing archive: ' + archivePath);

  const name = basename(archivePath);
  const windows = /-win-x64(?:-lite)?\.zip$/i.test(name);
  const linux = /-linux-(?:x64|arm64)(?:-lite)?\.tar\.gz$/i.test(name);
  if (!windows && !linux) throw new Error('Invalid provider archive name: ' + name);

  const entries = name.endsWith('.tar.gz') ? readTarGzipEntryNames(archivePath) : readZipEntryNames(archivePath);
  if (entries.length === 0) throw new Error(name + ' is empty');

  const roots = new Set(entries.map((entry) => entry.split('/')[0]));
  if (roots.size !== 1) throw new Error(name + ' must have exactly one root directory');
  const root = [...roots][0];
  if (!/^qq-guardian-snowluma-v\d+\.\d+\.\d+$/.test(root)) throw new Error(name + ' has invalid root directory ' + root);

  const relative = entries.map((entry) => {
    if (!entry.startsWith(root + '/')) throw new Error(name + ' contains an entry outside ' + root);
    return entry.slice(root.length + 1);
  });
  const set = new Set(relative);
  const lite = /-lite\.(?:zip|tar\.gz)$/i.test(name);

  const required = [
    'dist-snowluma/index.mjs',
    'dist-snowluma/package.json',
    windows ? 'launcher.bat' : 'launcher.sh',
    'check-node-version.cjs',
    'UPSTREAM-SNOWLUMA.json',
    'README.md',
    'docs/deployment/snowluma.md',
    'docs/deployment/snowluma-upstream.md',
    'deploy/Dockerfile',
    'deploy/compose.yaml',
  ];
  for (const item of required) if (!set.has(item)) throw new Error(name + ' is missing ' + item);

  if (windows) {
    if (relative.includes('launcher.sh') || relative.includes('deploy/native/unattended-start.sh')) throw new Error(name + ' contains Linux-only launcher assets');
    if (!set.has('deploy/native/unattended-start.ps1')) throw new Error(name + ' is missing Windows unattended launcher');
  } else {
    if (relative.includes('launcher.bat') || relative.includes('deploy/native/unattended-start.ps1')) throw new Error(name + ' contains Windows-only launcher assets');
    if (!set.has('deploy/native/unattended-start.sh')) throw new Error(name + ' is missing Linux unattended launcher');
  }

  const bundledNode = windows ? set.has('node.exe') : set.has('node');
  if (lite && bundledNode) throw new Error(name + ' lite archive unexpectedly contains bundled Node.js');
  if (!lite && !bundledNode) throw new Error(name + ' full archive is missing bundled Node.js');

  for (const entry of relative) {
    if (entry.includes('node_modules/') || entry.startsWith('.git/')) throw new Error(name + ' contains development-only content: ' + entry);
    if (/\/snowluma-[^/]+\.(?:node|dll|so)$/i.test('/' + entry)) throw new Error(name + ' must not redistribute SnowLuma proprietary native binary: ' + entry);
    if (entry.startsWith('dist-snowluma/native/')) throw new Error(name + ' contains unexpected native runtime directory: ' + entry);
  }
}

function option(name) {
  return process.argv.find((argument) => argument.startsWith(name + '='))?.slice(name.length + 1);
}
