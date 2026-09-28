#!/usr/bin/env node
/**
 * Dependency-free code quality gate. TypeScript remains the type checker;
 * this script syntax-checks executable JavaScript, validates the JSON
 * manifests, and enforces the repository's small formatting contract.
 * TypeScript parsing and syntax validation are owned by `tsc --noEmit`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const formatOnly = process.argv.includes('--format-only');
const typeScriptFiles = [
  ...walk(join(ROOT, 'src')),
  ...walk(join(ROOT, 'test')),
]
  .filter((path) => path.endsWith('.ts'));
const scriptFiles = [
  ...walk(join(ROOT, 'scripts')).filter((path) => path.endsWith('.mjs')),
  ...walk(join(ROOT, 'webui')).filter((path) => path.endsWith('.js')),
];
const sourceFiles = [...typeScriptFiles, ...scriptFiles];
const formatFiles = [
  ...sourceFiles,
  ...walk(join(ROOT, 'contracts')).filter((path) => path.endsWith('.json') || path.endsWith('.md')),
  ...walk(join(ROOT, '.github')).filter((path) => /\.(?:yml|yaml)$/.test(path)),
  join(ROOT, 'package.json'),
  join(ROOT, 'plugin.json'),
].filter(existsSync);
const failures = [];

for (const path of formatFiles) checkFormat(path);

if (!formatOnly) {
  const jsonFiles = [
    join(ROOT, 'package.json'),
    join(ROOT, 'plugin.json'),
    ...walk(join(ROOT, 'contracts')).filter((path) => path.endsWith('.json')),
  ];
  for (const path of jsonFiles) checkJson(path);
  for (const path of scriptFiles) checkSyntax(path);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}

console.log(`✓ ${formatOnly ? 'format' : 'lint'} checks passed (${formatFiles.length} formatted files, ${formatOnly ? 0 : scriptFiles.length} parsed JavaScript files; TypeScript is checked by tsc)`);

/** @param {string} directory */
function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

/** @param {string} path */
function checkFormat(path) {
  const source = readFileSync(path, 'utf8');
  const displayPath = relative(ROOT, path);
  if (source.length > 0 && !source.endsWith('\n')) failures.push(`${displayPath}: missing terminal newline`);
  if (/[ \t]+(?:\r?\n|$)/.test(source)) failures.push(`${displayPath}: trailing whitespace`);
  // Both CRLF and LF are valid checkout conventions. Git and Windows editors
  // can legitimately produce a mixed working tree while a patch is applied,
  // so this quality gate intentionally checks whitespace rather than EOL style.
  if (/^(?:\t)+/m.test(source)) failures.push(`${displayPath}: tab indentation is not allowed`);
  if (/^(?:<{7}|={7}|>{7})/m.test(source)) failures.push(`${displayPath}: unresolved merge-conflict marker`);
}

/** @param {string} path */
function checkJson(path) {
  try {
    JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    failures.push(`${relative(ROOT, path)}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** @param {string} path */
function checkSyntax(path) {
  const result = spawnSync(process.execPath, ['--check', path], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    failures.push(`${relative(ROOT, path)}: syntax check failed${output ? `\n${output}` : ''}`);
  }
}
