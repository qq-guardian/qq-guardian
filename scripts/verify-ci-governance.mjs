#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCiGovernance } from './lib/ci-governance.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = verifyCiGovernance({
  workflow: readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
  dependabot: readFileSync(join(root, '.github', 'dependabot.yml'), 'utf8'),
  packageJson: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
});

if (errors.length > 0) {
  errors.forEach((error) => console.error(`✗ ${error}`));
  process.exit(1);
}
console.log('✓ CI gates, action pins, security checks, and dependency governance match policy');
