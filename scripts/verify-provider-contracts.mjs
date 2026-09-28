#!/usr/bin/env node
import { PROVIDERS, validateProviderContract } from './lib/provider-contracts.mjs';

const provider = process.argv[2];
if (!PROVIDERS.includes(provider)) {
  console.error(`Usage: node scripts/verify-provider-contracts.mjs <${PROVIDERS.join('|')}>`);
  process.exit(2);
}

const result = validateProviderContract(provider);
if (!result.valid) {
  result.errors.forEach((error) => console.error(`✗ ${error}`));
  process.exit(1);
}
console.log(`✓ ${provider} provider payloads satisfy the reviewed JSON Schema contracts`);
