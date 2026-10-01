#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const required = [
  '.github/workflows/build.yml',
  '.github/workflows/test.yml',
  '.github/workflows/build-native.yml',
  '.github/workflows/package-windows.yml',
  '.github/workflows/package-linux.yml',
  '.github/workflows/docker-release.yml',
  '.github/workflows/github-release.yml',
];
const errors = [];
for (const path of required) {
  if (!existsSync(join(root, path))) errors.push(`missing required workflow: ${path}`);
}
for (const path of required) {
  if (!existsSync(join(root, path))) continue;
  const source = readFileSync(join(root, path), 'utf8');
  if (!source.includes('actions/checkout@v6')) errors.push(`${path}: must use actions/checkout@v6`);
  if (source.includes('pull_request') && !source.includes('permissions:')) errors.push(`${path}: explicit permissions are required`);
}
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const [name, command] of Object.entries({
  'package:production': 'node scripts/package-production.mjs',
  'release': 'pnpm run package:production',
  'verify:ci-governance': 'node scripts/verify-ci-governance.mjs',
})) {
  if (!String(pkg.scripts?.[name] ?? '').includes(command)) errors.push(`package.json: invalid ${name} script`);
}
if (errors.length) { for (const error of errors) console.error(`✗ ${error}`); process.exit(1); }
console.log('✓ production workflow governance verified');
