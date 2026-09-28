/**
 * Regex-safety helpers shared by every consumer of untrusted patterns
 * (admin-entered risk rules, network-fetched intel feeds). A catastrophic
 * pattern must degrade to "rejected", never to a frozen event loop.
 */
import { Worker } from 'worker_threads';

export const MAX_PATTERN_LENGTH = 512;
const PROBE_TIMEOUT_MS = 250;

/** Worst-case probe inputs: long uniform runs and repeated pairs are the
 *  classic triggers for exponential backtracking. Letter AND digit corpora —
 *  a pattern like (\d|\d)+$ blows up only on digit input, so an a/b-only
 *  corpus would cache it as safe. */
const PROBE_INPUTS = [
  'a'.repeat(60), 'a'.repeat(59) + '!', 'ab'.repeat(30), 'aa '.repeat(20) + 'b',
  '1'.repeat(60), '1'.repeat(59) + '!', '12'.repeat(30),
  // Exercise delayed ambiguity after a literal prefix without allowing an
  // unbounded feed to allocate arbitrarily large probe inputs.
  'a'.repeat(512), 'a'.repeat(511) + '!', 'ab'.repeat(256),
  '1'.repeat(512), '1'.repeat(511) + '!', '12'.repeat(256),
];

/** Structural heuristic: nested quantifiers on groups, e.g. (a+)+, (.*)* —
 *  the classic ReDoS shapes. Cheap first-line filter only; shapes like
 *  (a|a)+b slip past it, which is why the worker probe below exists. */
export function hasNestedQuantifier(pattern: string): boolean {
  return /\([^)]*[+*][^)]*\)[+*{]/.test(pattern);
}

function repetitionUpperBoundAt(pattern: string, offset: number): number | null {
  const marker = pattern[offset];
  if (marker === '*' || marker === '+') return Number.POSITIVE_INFINITY;
  if (marker !== '{') return null;
  const match = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(offset));
  if (!match) return null;
  if (match[2] === undefined) return Number(match[1]);
  return match[2] === '' ? Number.POSITIVE_INFINITY : Number(match[2]);
}

function alternativesAtTopLevel(groupSource: string): string[] {
  let source = groupSource;
  if (source.startsWith('?:') || source.startsWith('?=') || source.startsWith('?!')) source = source.slice(2);
  else if (source.startsWith('?<=') || source.startsWith('?<!')) source = source.slice(3);
  else if (source.startsWith('?<')) {
    const nameEnd = source.indexOf('>');
    if (nameEnd !== -1) source = source.slice(nameEnd + 1);
  }

  const alternatives: string[] = [];
  let start = 0;
  let depth = 0;
  let inCharacterClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') { index += 1; continue; }
    if (character === '[') { inCharacterClass = true; continue; }
    if (character === ']' && inCharacterClass) { inCharacterClass = false; continue; }
    if (inCharacterClass) continue;
    if (character === '(') { depth += 1; continue; }
    if (character === ')') { if (depth > 0) depth -= 1; continue; }
    if (character === '|' && depth === 0) {
      alternatives.push(source.slice(start, index));
      start = index + 1;
    }
  }
  alternatives.push(source.slice(start));
  return alternatives;
}

/**
 * Rejects a common ambiguity that a fixed test corpus can miss: repeated
 * alternatives where one branch starts with another, such as `(a|aa)+`.
 * The ambiguity remains exponential after any literal prefix (`a{100}`), so
 * accepting it based only on a short worker probe is unsafe. Small finite
 * repeats remain available to operators and still run through the worker
 * probe; large finite ambiguity is rejected once its worst-case combination
 * count is no longer safely bounded for a synchronous consumer.
 */
export function hasAmbiguousQuantifiedAlternation(pattern: string): boolean {
  const groups: number[] = [];
  let inCharacterClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') { index += 1; continue; }
    if (character === '[') { inCharacterClass = true; continue; }
    if (character === ']' && inCharacterClass) { inCharacterClass = false; continue; }
    if (inCharacterClass) continue;
    if (character === '(') { groups.push(index); continue; }
    if (character !== ')') continue;

    const start = groups.pop();
    const maximum = repetitionUpperBoundAt(pattern, index + 1);
    if (start === undefined || maximum === null || maximum <= 1) continue;
    const alternatives = alternativesAtTopLevel(pattern.slice(start + 1, index));
    if (alternatives.length < 2) continue;
    let hasAmbiguity = false;
    for (let left = 0; left < alternatives.length; left += 1) {
      for (let right = left + 1; right < alternatives.length; right += 1) {
        const a = alternatives[left];
        const b = alternatives[right];
        if (!a || !b || a.startsWith(b) || b.startsWith(a)) {
          hasAmbiguity = true;
          break;
        }
      }
      if (hasAmbiguity) break;
    }
    if (!hasAmbiguity) continue;

    // `a|aa` repeated twice is bounded and is a legitimate user rule. In
    // contrast, `(a|aa){20}` has over one million branch combinations before
    // considering each possible match offset, which is enough to stall the
    // live synchronous regex users even though the quantifier is finite.
    const boundedCombinations = Number.isFinite(maximum)
      ? Math.pow(alternatives.length, maximum)
      : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(maximum) || maximum > 8 || boundedCombinations > 1_024) return true;
  }
  return false;
}

/** Executes the untrusted pattern in a throwaway worker thread so a
 *  catastrophic regex can be killed instead of freezing the event loop —
 *  an in-process timing test itself hung the whole NapCat process on
 *  patterns like (a|a)+b, which the nested-quantifier heuristic misses. */
export function probePatternInWorker(pattern: string): Promise<boolean> {
  const src = `
    const { parentPort, workerData } = require('worker_threads');
    const re = new RegExp(workerData.pattern);
    for (const input of workerData.inputs) re.test(input);
    parentPort.postMessage(true);
  `;
  return new Promise((resolve) => {
    const worker = new Worker(src, { eval: true, workerData: { pattern, inputs: PROBE_INPUTS } });
    let killTimer: NodeJS.Timeout | null = null;
    const finish = (verdict: boolean) => {
      if (killTimer) clearTimeout(killTimer);
      clearTimeout(hardCap);
      void worker.terminate();
      resolve(verdict);
    };
    // The 250 ms budget measures REGEX time, not thread-spawn time — on a
    // loaded host worker startup alone can exceed it, which would reject
    // perfectly safe patterns. Arm the kill timer only once the worker is
    // actually running, with an outer hard cap in case it never comes up.
    const hardCap = setTimeout(() => finish(false), 5_000);
    worker.once('online', () => { killTimer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS); });
    worker.once('message', () => finish(true));
    worker.once('error', () => finish(false));
  });
}

/**
 * Probes each distinct persisted pattern without creating an unbounded number
 * of worker threads when an installation has many configured groups or rules.
 * Callers keep ownership of syntax/path-specific errors; this helper only
 * supplies the performance verdict for each exact source string.
 */
export async function probePatternsInWorkers(patterns: Iterable<string>): Promise<Map<string, boolean>> {
  const distinct = [...new Set(patterns)];
  const results = new Map<string, boolean>();
  const workerCount = Math.min(4, distinct.length);
  let next = 0;

  const probeNext = async (): Promise<void> => {
    while (next < distinct.length) {
      const pattern = distinct[next++];
      results.set(pattern, await probePatternInWorker(pattern));
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => probeNext()));
  return results;
}

/** Rejects patterns that are syntactically invalid or could cause
 *  catastrophic backtracking (ReDoS) under message-volume load. */
export async function validateRegexPattern(pattern: string): Promise<void> {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`Pattern too long (max ${MAX_PATTERN_LENGTH} characters)`);
  }
  if (hasNestedQuantifier(pattern)) {
    throw new Error('Pattern contains potentially catastrophic nested quantifier');
  }
  if (hasAmbiguousQuantifiedAlternation(pattern)) {
    throw new Error('Pattern contains an ambiguous quantified alternation');
  }
  try { new RegExp(pattern); }
  catch (e) { throw new Error(`Invalid regex: ${e instanceof Error ? e.message : e}`); }
  if (!(await probePatternInWorker(pattern))) {
    throw new Error('Pattern failed performance test (possible ReDoS)');
  }
}
