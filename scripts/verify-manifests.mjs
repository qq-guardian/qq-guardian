#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    console.error(`✗ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${label}: ${JSON.stringify(actual)}`);
  }
}

const rootPkg = readJson('package.json');
const rootPlugin = readJson('plugin.json');
assertEqual(rootPlugin.version, rootPkg.version, 'plugin.json version matches package.json');
assertEqual(rootPlugin.name, rootPkg.name, 'plugin.json name matches package.json');
assertEqual(rootPlugin.main, 'dist/index.mjs', 'plugin.json canonical source-checkout entry');
assertEqual(rootPkg.main, 'dist/index.mjs', 'package.json canonical source-checkout entry');

for (const duplicate of ['index.mjs', 'index.mjs.map']) {
  if (existsSync(duplicate)) {
    console.error(`✗ duplicate root bundle must not exist: ${duplicate}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ duplicate root bundle absent: ${duplicate}`);
  }
}

if (existsSync('dist/package.json')) {
  const distPkg = readJson('dist/package.json');
  assertEqual(distPkg.version, rootPkg.version, 'dist/package.json version');
  assertEqual(distPkg.name, rootPkg.name, 'dist/package.json name');
  assertEqual(distPkg.main, 'index.mjs', 'dist/package.json entry');
}

if (existsSync('dist/plugin.json')) {
  const distPlugin = readJson('dist/plugin.json');
  assertEqual(distPlugin.version, rootPkg.version, 'dist/plugin.json version');
  assertEqual(distPlugin.name, rootPkg.name, 'dist/plugin.json name');
  assertEqual(distPlugin.main, 'index.mjs', 'dist/plugin.json entry');
}

if (existsSync('dist-snowluma/package.json')) {
  const snowPkg = readJson('dist-snowluma/package.json');
  assertEqual(snowPkg.version, rootPkg.version, 'SnowLuma runtime version');
  assertEqual(snowPkg.main, 'index.mjs', 'SnowLuma runtime entry');
}

if (process.exitCode) process.exit(process.exitCode);
console.log('✓ manifest consistency checks passed');
