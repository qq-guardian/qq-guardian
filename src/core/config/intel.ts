/** Canonicalize configured feed URLs for stable cache ownership comparisons. */
export function normalizeIntelFeedUrls(values: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    try {
      const url = new URL(value.trim());
      url.hash = '';
      const canonical = url.toString();
      if (!seen.has(canonical)) {
        seen.add(canonical);
        normalized.push(canonical);
      }
    } catch {
      // Canonical config validation rejects invalid URLs. Ignore an invalid
      // runtime value defensively so it can never own cached enforcement data.
    }
  }
  return normalized;
}
