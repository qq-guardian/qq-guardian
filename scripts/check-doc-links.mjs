#!/usr/bin/env node
/** Verify that repository-local Markdown links resolve to checked-in paths. */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  const errors = checkDocumentationLinks({ root: ROOT });
  if (errors.length > 0) {
    for (const error of errors) console.error(`✗ ${error}`);
    process.exit(1);
  }
  console.log(`✓ documentation links verified (${collectMarkdownFiles(ROOT).length} Markdown files)`);
}

/**
 * @param {{ root?: string }} [options]
 * @returns {string[]}
 */
export function checkDocumentationLinks({ root = ROOT } = {}) {
  const errors = [];
  for (const file of collectMarkdownFiles(root)) {
    const source = readFileSync(file, 'utf8');
    for (const link of extractLocalLinks(source)) {
      const target = resolveLinkTarget(file, link, root);
      if (target.error) {
        errors.push(`${displayPath(file, root)}: ${target.error} (${link})`);
        continue;
      }
      if (!target.path) continue;
      if (!existsSync(target.path)) {
        errors.push(`${displayPath(file, root)}: linked path does not exist (${link})`);
      }
    }
  }
  return errors;
}

function collectMarkdownFiles(root) {
  const files = [];
  walk(root, files, root);
  return files.sort();
}

function walk(directory, files, root) {
  const ignored = new Set(['.git', 'node_modules', 'coverage', 'release', 'dist', 'dist-snowluma']);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    if (entry.isDirectory()) {
      if (ignored.has(entry.name)) continue;
      walk(join(directory, entry.name), files, root);
      continue;
    }
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') files.push(join(directory, entry.name));
  }
}

function extractLocalLinks(source) {
  const links = [];
  let fenced = false;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;

    const inline = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g;
    for (const match of line.matchAll(inline)) links.push(match[1] ?? match[2]);

    const reference = /^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/;
    const match = reference.exec(line);
    if (match) links.push(match[1] ?? match[2]);
  }
  return links;
}

function resolveLinkTarget(file, rawLink, root) {
  let link = rawLink.trim();
  try { link = decodeURIComponent(link); } catch { /* Keep the original for a useful error. */ }
  if (!link || link.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link)) {
    return { path: null };
  }
  const pathPart = link.split('#', 1)[0].split('?', 1)[0];
  if (!pathPart) return { path: null };
  const path = pathPart.startsWith('/')
    ? resolve(root, `.${pathPart}`)
    : resolve(dirname(file), pathPart);
  const rootWithSeparator = root.endsWith(sep) ? root : `${root}${sep}`;
  if (path !== root && !path.startsWith(rootWithSeparator)) {
    return { path: null, error: 'linked path escapes the repository root' };
  }
  try {
    if (existsSync(path)) lstatSync(path);
  } catch (error) {
    return { path: null, error: `cannot inspect linked path: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { path };
}

function displayPath(file, root) {
  return relative(root, file).replaceAll(sep, '/');
}
