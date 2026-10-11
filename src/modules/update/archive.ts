import { inflateRawSync } from 'node:zlib';

export const NAPCAT_UPDATE_FILES = [
  'index.mjs',
  'package.json',
  'plugin-icon.png',
  'plugin.json',
  'webui/app.js',
  'webui/index.html',
  'webui/release-view.js',
  'webui/user-security.js',
] as const;

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const UTF8_FLAG = 0x0800;
const MAX_ARCHIVE_OUTPUT_BYTES = 100 * 1024 * 1024;
const CRC32_POLYNOMIAL = 0xedb88320;
const CRC32_TABLE = createCrc32Table();

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/** Parse only the flat, deterministic NapCat ZIP produced by this repository. */
export function parseNapCatUpdateArchive(archive: Buffer): Map<string, Buffer> {
  if (archive.length < 22 || archive.length > MAX_ARCHIVE_OUTPUT_BYTES) {
    throw new Error('Update archive size is invalid');
  }
  const endOffset = findEndRecord(archive);
  const disk = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(endOffset + 8);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (
    disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount
    || entryCount !== NAPCAT_UPDATE_FILES.length
    || centralOffset + centralSize !== endOffset
  ) {
    throw new Error('Update archive has an unsupported ZIP layout');
  }

  const expectedNames = new Set<string>(NAPCAT_UPDATE_FILES);
  const entries: ZipEntry[] = [];
  const seenNames = new Set<string>();
  let offset = centralOffset;
  let totalOutputBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    requireRange(archive, offset, 46, 'ZIP central directory');
    if (archive.readUInt32LE(offset) !== ZIP_CENTRAL_HEADER) throw new Error('Update archive has an invalid ZIP central directory');
    const versionMadeBy = archive.readUInt16LE(offset + 4);
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const startDisk = archive.readUInt16LE(offset + 34);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    requireRange(archive, offset, recordLength, 'ZIP central-directory entry');

    const nameBytes = archive.subarray(offset + 46, offset + 46 + nameLength);
    const name = decodeUtf8(nameBytes, 'ZIP entry name');
    const unixMode = externalAttributes >>> 16;
    if (
      !expectedNames.has(name) || seenNames.has(name)
      || flags !== UTF8_FLAG || (method !== 0 && method !== 8)
      || startDisk !== 0 || (versionMadeBy >>> 8) !== 3
      || (unixMode & 0o170000) !== 0o100000
      || compressedSize > MAX_ARCHIVE_OUTPUT_BYTES
      || uncompressedSize > MAX_ARCHIVE_OUTPUT_BYTES
    ) {
      throw new Error(`Update archive contains an unsupported or unsafe entry: ${name || '(empty)'}`);
    }
    totalOutputBytes += uncompressedSize;
    if (totalOutputBytes > MAX_ARCHIVE_OUTPUT_BYTES) throw new Error('Update archive expands beyond the size limit');
    seenNames.add(name);
    entries.push({ name, method, flags, crc32: crc, compressedSize, uncompressedSize, localOffset });
    offset += recordLength;
  }
  if (offset !== endOffset || seenNames.size !== expectedNames.size) {
    throw new Error('Update archive is incomplete or contains unexpected entries');
  }

  const localRanges: Array<{ start: number; end: number }> = [];
  const output = new Map<string, Buffer>();
  for (const entry of entries) {
    requireRange(archive, entry.localOffset, 30, `ZIP local header for ${entry.name}`);
    const local = entry.localOffset;
    if (
      archive.readUInt32LE(local) !== ZIP_LOCAL_HEADER
      || archive.readUInt16LE(local + 6) !== entry.flags
      || archive.readUInt16LE(local + 8) !== entry.method
      || archive.readUInt32LE(local + 14) !== entry.crc32
      || archive.readUInt32LE(local + 18) !== entry.compressedSize
      || archive.readUInt32LE(local + 22) !== entry.uncompressedSize
    ) {
      throw new Error(`Update archive local header does not match its directory entry: ${entry.name}`);
    }
    const nameLength = archive.readUInt16LE(local + 26);
    const extraLength = archive.readUInt16LE(local + 28);
    requireRange(archive, local + 30, nameLength + extraLength + entry.compressedSize, `ZIP payload for ${entry.name}`);
    const localName = decodeUtf8(archive.subarray(local + 30, local + 30 + nameLength), 'ZIP local entry name');
    if (localName !== entry.name) throw new Error(`Update archive has mismatched entry names: ${entry.name}`);
    const dataStart = local + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > centralOffset) throw new Error(`Update archive payload overlaps the central directory: ${entry.name}`);
    localRanges.push({ start: local, end: dataEnd });

    const compressed = archive.subarray(dataStart, dataEnd);
    let data: Buffer;
    try {
      data = entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: MAX_ARCHIVE_OUTPUT_BYTES });
    } catch {
      throw new Error(`Update archive entry cannot be decompressed: ${entry.name}`);
    }
    if (data.length !== entry.uncompressedSize || crc32(data) !== entry.crc32) {
      throw new Error(`Update archive entry failed integrity checks: ${entry.name}`);
    }
    output.set(entry.name, data);
  }

  localRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index - 1]!.end > localRanges[index]!.start) {
      throw new Error('Update archive contains overlapping ZIP entries');
    }
  }
  return output;
}

function findEndRecord(archive: Buffer): number {
  const minimumOffset = Math.max(0, archive.length - 0xffff - 22);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) !== ZIP_EOCD) continue;
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) return offset;
  }
  throw new Error('Update archive is not a valid ZIP file');
}

function requireRange(buffer: Buffer, offset: number, length: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`Update archive has a truncated ${label}`);
  }
}

function decodeUtf8(value: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new Error(`Update archive has an invalid UTF-8 ${label}`);
  }
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value += 1) {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) current = current & 1 ? CRC32_POLYNOMIAL ^ (current >>> 1) : current >>> 1;
    table[value] = current >>> 0;
  }
  return table;
}
