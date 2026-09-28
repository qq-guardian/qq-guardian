#!/usr/bin/env node
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ARTIFACT_OUTPUT_DIRECTORIES = Object.freeze(['dist', 'dist-snowluma', 'release']);

export function clearArtifactOutputs(root = ROOT) {
  const resolvedRoot = resolve(root);
  for (const directory of ARTIFACT_OUTPUT_DIRECTORIES) {
    const target = resolve(resolvedRoot, directory);
    if (dirname(target) !== resolvedRoot) throw new Error(`Refusing to remove artifact path outside ${resolvedRoot}`);
    rmSync(target, { recursive: true, force: true });
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entrypoint) {
  clearArtifactOutputs();
  console.log(`✓ cleared checkout outputs: ${ARTIFACT_OUTPUT_DIRECTORIES.join(', ')}`);
}
