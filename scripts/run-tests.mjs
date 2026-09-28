#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [scope = 'unit', ...argumentsAfterScope] = process.argv.slice(2);
const testDirectories = {
  unit: ['test/unit'],
  integration: ['test/integration'],
  tooling: ['test/tooling'],
  all: ['test'],
};

const directories = testDirectories[scope];
if (!directories) {
  console.error(`Unknown test scope ${JSON.stringify(scope)}. Expected one of: ${Object.keys(testDirectories).join(', ')}`);
  process.exit(2);
}

const files = directories
  .flatMap((directory) => findTestFiles(join(ROOT, directory)))
  .sort((left, right) => left.localeCompare(right));

if (files.length === 0) {
  console.error(`No test files found for ${scope}.`);
  process.exit(1);
}

const nodeArguments = ['--experimental-strip-types', '--test'];
const reporter = argumentsAfterScope.find((argument) => argument.startsWith('--reporter='));
if (reporter) nodeArguments.push(`--test-reporter=${reporter.slice('--reporter='.length)}`);
nodeArguments.push(...argumentsAfterScope.filter((argument) => argument !== reporter));
nodeArguments.push(...files.map((file) => relative(ROOT, file)));

const result = spawnSync(process.execPath, nodeArguments, {
  cwd: ROOT,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);

/** @param {string} directory */
function findTestFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...findTestFiles(path));
    else if (/\.test\.(?:ts|mjs)$/.test(name)) files.push(path);
  }
  return files;
}
