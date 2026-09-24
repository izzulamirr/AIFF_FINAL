// NPS (nominal pipe size) string parsing, used by both apps/worker (branch
// table -> fittings size-range resolution during extraction) and apps/web
// (spec cross-check, display sort) -- see apps/worker/src/extraction/specSheet.ts
// and apps/web/src/lib/verifySpecCrossCheck.ts.
//
// Ported from the sibling AIFF_LATEST project, unchanged.

// Parses an NPS size string into decimal inches -- plain "36", decimal
// "1.5", the branch-table's dot-fraction "1.1/2", or a catalogue export's
// space-fraction "1 1/2"" -- all four notations have shown up in real
// documents in this project.
export function parseNpsInches(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/"/g, "").trim();
  if (!s) return null;
  const dotMixed = s.match(/^(\d+)\.(\d+)\/(\d+)$/);
  if (dotMixed) return Number(dotMixed[1]) + Number(dotMixed[2]) / Number(dotMixed[3]);
  const spaceMixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (spaceMixed) return Number(spaceMixed[1]) + Number(spaceMixed[2]) / Number(spaceMixed[3]);
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const num = Number(s);
  return Number.isFinite(num) ? num : null;
}

// Recovers a size_min/size_max pair that a dash-punctuated mixed fraction
// (e.g. "1-1/2", meant as one-and-a-half inches) got mis-split into (e.g.
// size_min="1", size_max="1/2") -- confirmed on a real document (BC70N)
// where the model wrote this size as "1-1/2" for its Fittings/Flanges bands
// but correctly used the space form ("1 1/2") for the exact same size on
// that page's own Pipe bands, so the inconsistency is in what gets typed,
// not a fixed rule this can be prevented from ever happening again. A
// genuine size RANGE only ever ascends left-to-right (min <= max) -- no
// real range descends -- so whenever parsing the two sides the OTHER way
// produces min > max, the pair was never a range at all, just a
// mis-punctuated single size; rejoin the two halves with a space and use
// that as both bounds. Anything else (a genuine ascending range, or a pair
// that doesn't parse as NPS at all) passes through unchanged. Shared so
// both the worker's extraction-time expandBands (apps/worker/src/
// extraction/specSheet.ts) and the web app's no-Claude-call revalidation
// (apps/web/src/lib/revalidateSpecClass.ts) apply the exact same repair,
// the latter for data that was already extracted and stored before this
// fix existed.
export function repairInvertedSizeRange(sizeMin: unknown, sizeMax: unknown): { size_min: unknown; size_max: unknown } {
  const min = parseNpsInches(sizeMin);
  const max = parseNpsInches(sizeMax);
  if (min != null && max != null && min > max && typeof sizeMin === "string" && typeof sizeMax === "string") {
    const single = `${sizeMin.trim()} ${sizeMax.trim()}`;
    return { size_min: single, size_max: single };
  }
  return { size_min: sizeMin, size_max: sizeMax };
}

// Nominal pipe size (DN, mm) -> NPS (inches) per ASME B36.10/B16 standard
// designations. This is a lookup, not a unit conversion -- DN50 is
// nominally 2", not 50/25.4=1.97" -- so non-standard sizes must fail the
// lookup rather than be computed.
// Exported (not just the lookup functions below) so the UI can render this
// table itself as a plain NPS<->DN reference legend, using the exact same
// canonical mapping every size comparison in this app already goes through.
export const DN_TO_NPS_INCHES: Record<number, number> = {
  6: 0.125,
  8: 0.25,
  10: 0.375, // 1/8", 1/4", 3/8" -- below the 1/2" this table previously started at
  15: 0.5,
  20: 0.75,
  25: 1,
  32: 1.25,
  40: 1.5,
  50: 2,
  65: 2.5,
  80: 3,
  90: 3.5,
  100: 4,
  115: 4.5, // 4 1/2" -- was missing entirely, not just an extension of the small-bore range
  125: 5,
  150: 6,
  200: 8,
  250: 10,
  300: 12,
  350: 14,
  400: 16,
  450: 18,
  500: 20,
  550: 22,
  600: 24,
  650: 26,
  700: 28,
  750: 30,
  800: 32,
  850: 34,
  900: 36,
  950: 38,
  1000: 40,
  1050: 42,
  1100: 44,
  1150: 46,
  1200: 48,
};

// Exported so the item list's mm/inch size toggle can convert an admin
// Excel row's Size P1-P3 (DN, mm) the same way crossCheckItem itself does --
// same lookup-not-arithmetic reasoning as the module comment above.
export function dnToNpsInches(mmValue: string): number | null {
  const mm = Number(mmValue);
  if (!Number.isFinite(mm)) return null;
  return DN_TO_NPS_INCHES[Math.round(mm)] ?? null;
}

// The reverse direction, for display: a decimal NPS value (e.g. 1.5) back
// into this project's own fraction notation (e.g. "1 1/2", matching how
// parseNpsInches reads it and how every other size cell in this app already
// shows it). Standard NPS sizes are always eighths or simpler, so reducing
// to eighths and simplifying the fraction covers every size this table's
// own DN_TO_NPS_INCHES lookup can produce.
export function formatNpsInches(value: number): string {
  const whole = Math.floor(value + 1e-9);
  const eighths = Math.round((value - whole) * 8);
  if (eighths === 0) return String(whole);
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(eighths, 8);
  const fraction = `${eighths / divisor}/${8 / divisor}`;
  return whole > 0 ? `${whole} ${fraction}` : fraction;
}
