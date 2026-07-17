// Cross-document tag normalization, used by both apps/worker (correlation
// during extraction) and apps/web (on-demand ISO verification) -- see
// apps/worker/src/correlate.ts and apps/web/src/lib/verifyIso.ts.

export function normalizeTagNumber(raw: string, stripPattern?: RegExp): string {
  const stripped = stripPattern ? raw.replace(stripPattern, "") : raw;
  return stripped.trim().toUpperCase();
}

// Default strip pattern: collapse hyphens/spaces so "L-1024" / "L 1024" /
// "L1024" normalize to the same key. Override per-organization later if a
// client's numbering convention needs something more specific.
export const DEFAULT_STRIP_PATTERN = /[-\s]/g;
