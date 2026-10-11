import type { Buffer } from 'node:buffer';

export function writeDeterministicZip(options: {
  outputPath: string;
  entries: Array<{ name: string; data: Buffer; mode?: number }>;
}): void;
