#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? 'release');
const assets = readdirSync(directory)
  .filter((name) => name.endsWith('.zip') || name.endsWith('.tar.gz'))
  .sort();
if (assets.length === 0) throw new Error(`No release archives found in ${directory}`);
const lines = assets.map((name) => {
  const digest = createHash('sha256').update(readFileSync(resolve(directory, name))).digest('hex');
  return `${digest}  ${basename(name)}`;
});
writeFileSync(resolve(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8');
console.log(`✓ SHA256SUMS covers ${assets.length} release archives`);
