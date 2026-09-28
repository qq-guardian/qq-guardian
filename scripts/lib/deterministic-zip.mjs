import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { deflateRawSync, gunzipSync, gzipSync } from 'node:zlib';

const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CRC32_POLYNOMIAL = 0xedb88320;
const CRC32_TABLE = createCrc32Table();

/**
 * Collect regular files from one or more directories into deterministic archive
 * entries. Archive paths always use POSIX separators, independently of the
 * host operating system.
 *
 * @param {({ directory: string, prefix?: string, include?: (absolutePath: string) => boolean } | { file: string, name: string, prefix?: string })[]} sources
 */
export function collectArchiveEntries(sources) {
  const entries = [];

  for (const source of sources) {
    const { prefix = '' } = source;
    if ('file' in source) {
      const { file, name } = source;
      if (!existsSync(file)) throw new Error(`Archive source file does not exist: ${file}`);
      const info = lstatSync(file);
      if (info.isSymbolicLink()) throw new Error(`Refusing to package symbolic link: ${file}`);
      if (!info.isFile()) throw new Error(`Archive source is not a regular file: ${file}`);
      const archiveName = [prefix.replaceAll('\\', '/').replace(/^\/+|\/+$/g, ''), name]
        .filter(Boolean)
        .join('/');
      assertSafeArchivePath(archiveName);
      entries.push({
        name: archiveName,
        data: readFileSync(file),
        mode: normalizedMode(file),
      });
      continue;
    }

    const { directory, include = () => true } = source;
    if (!existsSync(directory)) {
      throw new Error(`Archive source directory does not exist: ${directory}`);
    }

    for (const absolutePath of walkFiles(directory, include)) {
      if (!include(absolutePath)) continue;

      const relativePath = relative(directory, absolutePath).split(sep).join('/');
      const name = [prefix.replaceAll('\\', '/').replace(/^\/+|\/+$/g, ''), relativePath]
        .filter(Boolean)
        .join('/');
      assertSafeArchivePath(name);

      entries.push({
        name,
        data: readFileSync(absolutePath),
        // Source checkout modes differ across Windows and Unix. Normalize them
        // so archives built from the same commit are byte-for-byte identical.
        mode: normalizedMode(absolutePath),
      });
    }
  }

  entries.sort((left, right) => compareNames(left.name, right.name));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].name === entries[index].name) {
      throw new Error(`Duplicate archive entry: ${entries[index].name}`);
    }
  }
  return entries;
}

/**
 * Write a reproducible ZIP archive without a runtime packaging dependency.
 * @param {{ outputPath: string, entries: { name: string, data: Buffer, mode?: number }[] }} options
 */
export function writeDeterministicZip({ outputPath, entries }) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    assertSafeArchivePath(entry.name);
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const useDeflate = compressed.length < entry.data.length;
    const payload = useDeflate ? compressed : entry.data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_LOCAL_FILE_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_HEADER, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((((0o100000 | (entry.mode ?? 0o644)) << 16) >>> 0), 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, nameBuffer, payload);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(entries.length, 8);
  endOfCentralDirectory.writeUInt16LE(entries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(offset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]));
}

/**
 * Write a reproducible POSIX ustar archive compressed with a normalized gzip
 * header. The gzip OS byte is intentionally set to "unknown" so Windows,
 * macOS, and Linux produce the same bytes for identical inputs.
 * @param {{ outputPath: string, entries: { name: string, data: Buffer, mode?: number }[] }} options
 */
export function writeDeterministicTarGzip({ outputPath, entries }) {
  const parts = [];
  for (const entry of entries) {
    assertSafeArchivePath(entry.name);
    const { name, prefix } = splitTarPath(entry.name);
    const header = Buffer.alloc(512, 0);
    writeTarText(header, 0, 100, name);
    writeTarOctal(header, 100, 8, entry.mode ?? 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.data.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    writeTarText(header, 257, 6, 'ustar');
    writeTarText(header, 263, 2, '00');
    writeTarText(header, 345, 155, prefix);
    writeTarOctal(header, 148, 8, header.reduce((sum, byte) => sum + byte, 0));
    parts.push(header, entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  const compressed = gzipSync(Buffer.concat(parts), { level: 9, mtime: 0 });
  compressed[9] = 0xff;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, compressed);
}

/** @param {string} archivePath */
export function writeSha256Sidecar(archivePath) {
  const digest = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  const sidecarPath = `${archivePath}.sha256`;
  writeFileSync(sidecarPath, `${digest}  ${basename(archivePath)}\n`, 'utf8');
  return { digest, sidecarPath };
}

/** @param {string} archivePath */
export function readZipEntryNames(archivePath) {
  const archive = readFileSync(archivePath);
  const endOffset = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  let offset = archive.readUInt32LE(endOffset + 16);
  const names = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      throw new Error(`Invalid ZIP central-directory entry at offset ${offset}`);
    }
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    names.push(archive.subarray(nameStart, nameStart + nameLength).toString('utf8'));
    offset = nameStart + nameLength + extraLength + commentLength;
  }

  return names;
}

/** @param {string} archivePath */
export function readTarGzipEntryNames(archivePath) {
  const archive = gunzipSync(readFileSync(archivePath));
  const names = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarText(header, 0, 100);
    const prefix = readTarText(header, 345, 155);
    const sizeText = readTarText(header, 124, 12).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid TAR entry size');
    names.push(prefix ? `${prefix}/${name}` : name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

/** @param {string} directory */
function walkFiles(directory, include = () => true) {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const absolutePath = join(directory, name);
    const info = lstatSync(absolutePath);
    if (info.isSymbolicLink()) {
      // Excluded dependency trees are commonly represented by pnpm symlinks.
      // Let the source policy skip them, but never follow or package a link.
      if (!include(absolutePath)) continue;
      throw new Error(`Refusing to package symbolic link: ${absolutePath}`);
    }
    if (info.isDirectory()) files.push(...walkFiles(absolutePath, include));
    else if (info.isFile()) files.push(absolutePath);
  }
  return files;
}

/** @param {Buffer} archive */
function findEndOfCentralDirectory(archive) {
  const minimumOffset = Math.max(0, archive.length - 0xffff - 22);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error('Invalid ZIP: end-of-central-directory record not found');
}

/** @param {string} path */
function assertSafeArchivePath(path) {
  if (
    !path
    || path.includes('\\')
    || path.startsWith('/')
    || path.split('/').some((segment) => segment === '..' || segment === '.')
  ) {
    throw new Error(`Unsafe archive path: ${path}`);
  }
}

/** @param {string} path */
function normalizedMode(path) {
  return path.endsWith('.sh') ? 0o755 : 0o644;
}

/** @param {string} left @param {string} right */
function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {string} path */
function splitTarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let index = path.lastIndexOf('/'); index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`TAR path is too long: ${path}`);
}

/** @param {Buffer} target @param {number} offset @param {number} length @param {string} value */
function writeTarText(target, offset, length, value) {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.length > length) throw new Error(`TAR field is too long: ${value}`);
  encoded.copy(target, offset);
}

/** @param {Buffer} target @param {number} offset @param {number} length @param {number} value */
function writeTarOctal(target, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length > length - 1) throw new Error(`TAR numeric field overflow: ${value}`);
  target.write(encoded, offset, length - 1, 'ascii');
  target[offset + length - 1] = 0;
}

/** @param {Buffer} source @param {number} offset @param {number} length */
function readTarText(source, offset, length) {
  const field = source.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

/** @returns {Uint32Array} */
function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (-(value & 1) & CRC32_POLYNOMIAL);
    }
    table[index] = value >>> 0;
  }
  return table;
}

/** @param {Buffer} data */
function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
