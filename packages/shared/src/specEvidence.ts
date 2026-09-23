// Which class a BOM item belongs to when the item itself NAMES a specific
// material, e.g. "PIPE ... + 3MM ALLOY 625 CLAD".
//
// A spec break puts several classes on one sheet and the extraction places each
// row by position or by pressure rating. Neither says anything about a material:
// a clad pipe carries no rating and its balloon can sit on either side of a
// break. But the class that specifies alloy 625 clad pipe is the class the item
// is made to, so the item's own words are evidence and the class's own spec text
// is what they are checked against.
//
// Deliberately narrow. Only markers that MEAN a particular spec are read --
// alloy / clad / overlay / UNS / stainless. A plain grade such as A106 is not
// evidence: the same grade appears in every carbon-steel class on a sheet and
// its punctuation ("A106 GR B" vs "A106 Gr.B") differs by document, so counting
// it would move items on formatting alone. Rating and schedule are not read
// either: they are what the extraction's own position/rating placement already
// decides, and this must not fight it.

const MATERIAL_MARKERS: RegExp[] = [
  /\bALLOY\s*[-]?\s*\d{3,4}\b/g,
  /\bCLAD(?:DING)?\b/g,
  /\bOVERLAY\b/g,
  /\bINCONEL(?:\s*\d{3,4})?\b/g,
  /\bMONEL(?:\s*\d{3})?\b/g,
  /\bHASTELLOY\b/g,
  /\bDUPLEX\b/g,
  /\bUNS\s*[A-Z]\d{5}\b/g,
  /\b(?:SS|TP|F)?\s?3(?:04|16)L?\b/g,
];

const squash = (s: string) => s.toUpperCase().replace(/[\s.\-]+/g, "");

/** The specific-material markers named in a piece of text, normalised for comparison. */
export function materialMarkers(text: string | null | undefined): string[] {
  if (!text) return [];
  const upper = text.toUpperCase();
  const found = new Set<string>();
  for (const re of MATERIAL_MARKERS) {
    for (const m of upper.matchAll(re)) found.add(squash(m[0]));
  }
  return [...found];
}

/** True when `text` carries every one of `markers` (as returned by materialMarkers). */
export function textCarriesMarkers(text: string, markers: string[]): boolean {
  const haystack = squash(text);
  return markers.every((m) => haystack.includes(m));
}

export interface ClassEvidence {
  /** The class code as the sheet prints it. */
  code: string;
  /** The class spec's own text for the row this item resolves to; null where the class has no such row. */
  specText: string | null;
}

/**
 * The class the item's named materials point at, or null to leave it where it is.
 *
 * Moves an item only when it names at least one specific material AND exactly one
 * candidate's spec text carries more of them than the item's current class does.
 * A tie, or no evidence, changes nothing.
 */
export function classByMaterialEvidence(
  itemText: string,
  currentCode: string,
  candidates: ClassEvidence[],
  sameClass: (a: string, b: string) => boolean = (a, b) => a.trim().toUpperCase() === b.trim().toUpperCase()
): { code: string; markers: string[] } | null {
  const wanted = materialMarkers(itemText);
  if (wanted.length === 0) return null;

  const scored = candidates.map((c) => {
    const haystack = squash(c.specText ?? "");
    const supported = c.specText ? wanted.filter((m) => haystack.includes(m)) : [];
    return { code: c.code, supported };
  });

  const current = scored.find((s) => sameClass(s.code, currentCode));
  const currentScore = current ? current.supported.length : 0;
  const best = Math.max(...scored.map((s) => s.supported.length));
  if (best <= currentScore) return null;

  const leaders = scored.filter((s) => s.supported.length === best);
  if (leaders.length !== 1) return null;
  return { code: leaders[0].code, markers: leaders[0].supported };
}
