import { classByMaterialEvidence, materialMarkers, parsePressureRating, textCarriesMarkers } from "@easy/shared";
import { closestAdminLines, combineAdminText, narrowAdminMatches, type AdminAttributeMismatch, type SheetItem } from "./parseSheetPage";
import { normalizeNominalSize, normalizeSpecClass } from "./verifyIso";
import {
  rowMatchesTypeHint,
  rowSizeRangeContains,
  normalizeSpecClassCode,
  sizeRangeLabel,
  DN_TO_NPS_INCHES,
  groupAdminItemsByClassRow,
  adminItemHint,
  type SpecCategory,
  type CategoryHint,
} from "./verifySpecCrossCheck";

// Ported from the sibling AIFF_LATEST project.
//
// Cross-checks an ISO drawing's own Bill of Material against the SAME
// client spec_class data (and, where available, the SAME admin-confirmed
// rows) the Admin cross-check already resolves -- "does what's actually
// being fabricated per the isometric trace back to material this class's
// spec (and, ideally, the client's own admin item list) actually covers."
// Reuses verifySpecCrossCheck.ts's CategoryHint/rowMatchesTypeHint directly
// rather than re-solving the exact same "Tee (Reduced) vs Reducer",
// "Spectacle blind vs Blind flange", "Orifice Flanges vs plain Flange"
// collisions a second time -- see that file's own CategoryHint comment for
// why a naive substring match isn't safe here.

// A BOM's own `component_type` column is NOT a fixed enum across documents
// -- confirmed against two real ISO exports of the same drawing set: one
// uses broad buckets ("FITTINGS", "FLANGES", "VALVES / IN-LINE ITEMS"),
// the other uses granular per-part values ("ELBOW", "FLANGE", "BOLT SET"),
// and a third wraps EVERY row (pipe, elbow, flange alike) in a generic
// "FABRICATION ITEM"/"ERECTION ITEM" label that carries no type information
// at all. So classification reads the row's own DESCRIPTION text (the one
// field that's reliably specific), the same way admin item classification
// reads free text rather than trusting a loosely-enumerated type column.
// Order matters: more specific patterns are listed before the generic ones
// they'd otherwise be swallowed by (e.g. "reducing tee" before bare "tee",
// "control valve" before bare "valve").
const OUT_OF_SCOPE_PATTERNS: RegExp[] = [
  /\bcontrol\s*valve\b|\binstrument\b/i, // checked before the generic \bvalve\b rule below
  /\bgasket\b/i,
  // "stud bolt"/"bolt set" specifically, NOT a bare \bbolt\b -- confirmed on
  // a real BOM where a Blind Flange's own description ("...BOLT HOLES TO
  // MATCH ANSI B16.5") mentions "bolt" only in passing, describing the
  // flange's own bolt-circle spec, not a fastener line item. Every real
  // stud-bolt BOM line seen consistently leads with "STUD BOLT" or "BOLT
  // SET", so this stays just as specific without the false positive.
  /\bstud\s*bolt\b|\bbolt\s*set\b/i,
  /\bpipe\s*support\b|\bsupport\b/i,
  /\breinforcement\b/i,
  /\bexpansion\s*joint\b/i,
  /\bstrainer\b/i,
];

interface BomClassification {
  category: SpecCategory;
  hint: CategoryHint;
}

const BOM_CLASSIFICATION_RULES: Array<{ match: RegExp; classify: BomClassification }> = [
  // Fittings -- most-specific Tee wording first (see CategoryHint's own
  // comment on why "reduced" is used, not "reduc": it can't leak into
  // "Reducer (Concentric/Eccentric)" the way the bare stem would).
  { match: /\breducing\s*tee\b|\btee\s*\(?\s*red/i, classify: { category: "fittings", hint: { category: "fittings", typeHint: "reduced" } } },
  { match: /\bequal\s*tee\b/i, classify: { category: "fittings", hint: { category: "fittings", typeHint: "straight" } } },
  { match: /\btee\b/i, classify: { category: "fittings", hint: { category: "fittings", typeHint: "tee" } } },
  { match: /\bweldolet\b|\bo'?let\b|\bsockolet\b/i, classify: { category: "fittings", hint: { category: "fittings", typeHint: "olet" } } },
  // "redu" alone (not just the full word "reducer") -- confirmed on a real
  // BOM using the abbreviated form "REDU CONC"/"REDU ECC", the same
  // shorthand the admin item-list's own GTYPE code uses. Safe from the same
  // "Tee (Reduced)" collision CategoryHint warns about because the tee
  // rules above are checked first in this same loop and already intercept
  // "reducing tee"/"tee (red..." before this rule ever sees them.
  { match: /\breducer\b|\bredu\b/i, classify: { category: "fittings", hint: { category: "fittings", typeHint: "reducer" } } },
  { match: /\belbow\b/i, classify: { category: "fittings", hint: { category: "fittings", typeHint: "elbow" } } },
  { match: /\bcap\b/i, classify: { category: "fittings", hint: { category: "fittings", typeHint: "cap" } } },
  // Flanges -- spectacle/spade/orifice checked before plain "flange" for
  // the same reason (all three contain, or sit next to, that word).
  { match: /\bspectacle\b/i, classify: { category: "flanges", hint: { category: "flanges", typeHint: "spectacle" } } },
  { match: /\bspade\b|\bspacer\b/i, classify: { category: "flanges", hint: { category: "flanges", typeHint: "spade" } } },
  { match: /\borifice\b/i, classify: { category: "flanges", hint: { category: "flanges", typeHint: "orifice" } } },
  {
    match: /\bblind\s*flange\b|\bflange,?\s*blind\b/i,
    classify: { category: "flanges", hint: { category: "flanges", typeHint: "blind", excludeHints: ["spectacle"] } },
  },
  { match: /\bflange\b/i, classify: { category: "flanges", hint: { category: "flanges", typeHint: "flange", excludeHints: ["blind", "orifice"] } } },
  // Valves -- sub-typed by the BOM item's own description, same fix (and
  // same real-document bug) as the admin GTYPE table's VALV entry
  // (verifySpecCrossCheck.ts's CATEGORY_BY_GTYPE): with no typeHint, EVERY
  // valve row covering the item's size was a candidate regardless of type,
  // and inRange[0] silently picked whichever one happened to sit first in
  // the client class's own array order -- confirmed on a real BOM where an
  // 8" Ball valve item matched the class's Gate valve row instead (Gate is
  // listed before Ball in that class's own valves array), showing a Gate
  // description and a wall of unrelated Gate admin lines under a Ball BOM
  // item. Specific patterns must come before the generic \bvalve\b fallback
  // below, same ordering reason as Tee/Reducer and the Flange family above.
  { match: /\bball\s*valve\b/i, classify: { category: "valves", hint: { category: "valves", typeHint: "ball" } } },
  { match: /\bgate\s*valve\b/i, classify: { category: "valves", hint: { category: "valves", typeHint: "gate" } } },
  { match: /\bglobe\s*valve\b/i, classify: { category: "valves", hint: { category: "valves", typeHint: "globe" } } },
  { match: /\bcheck\s*valve\b/i, classify: { category: "valves", hint: { category: "valves", typeHint: "check" } } },
  { match: /\bbutterfly\s*valve\b/i, classify: { category: "valves", hint: { category: "valves", typeHint: "butterfly" } } },
  // Fallback for a valve type this app doesn't have a keyword for yet (e.g.
  // plug, needle) -- matches any row, same as before this fix, rather than
  // being silently dropped as out-of-scope.
  { match: /\bvalve\b/i, classify: { category: "valves", hint: { category: "valves" } } },
  { match: /\bpipe\b/i, classify: { category: "pipes", hint: { category: "pipes" } } },
];

export function classifyBomItem(item: Record<string, unknown>): BomClassification | null {
  const text = `${item.component_type ?? ""} ${item.description ?? ""}`;
  if (OUT_OF_SCOPE_PATTERNS.some((p) => p.test(text))) return null;
  for (const rule of BOM_CLASSIFICATION_RULES) {
    if (rule.match.test(text)) return rule.classify;
  }
  return null;
}

// A BOM's own size column mixes bare mm ("200"), inch-marked ("1\""), and a
// run x branch pair for O'lets/reducing tees ("200 x 80", "2\"X1\"") --
// normalizeNominalSize (verifyIso.ts) already parses all of this down to a
// DN, taking the first (run) size for a pair, the same convention this
// class's own O'let/reducing-tee rows are indexed by.
//
// EXPLICITLY "mm", not the bare `normalizeNominalSize(size)` the project
// this was ported from used: this repo's own verifyIso.ts (isoBom's own
// size reading, "ISO BOM sizes come from a column headed 'N.S. (MM)'")
// already established that an ISO BOM's size column defaults to millimetres,
// not inches -- normalizeNominalSize's unmarked-number heuristic guesses
// inches otherwise, which turned a BOM's bare "25" (DN25) into 25" (DN635)
// before that fix existed. Passing the same hint here is what a BOM cross-
// check needs to avoid reintroducing that exact bug for this one call site.
function bomSizeToInches(size: unknown): number | null {
  if (size == null) return null;
  const dn = normalizeNominalSize(size, "mm");
  if (dn == null) return null;
  return DN_TO_NPS_INCHES[dn] ?? null;
}

// Same composition verifyIso.ts's own line/spec-class matching needs:
// normalizeSpecClass strips an ISO-specific suffix ("AC03N-N" -> "AC03N"),
// normalizeSpecClassCode strips a spec-sheet-specific one (a spurious
// trailing "1" some title blocks print, "AC03N1" -> "AC03N") -- a BOM
// item's item_spec_class can in principle carry either quirk, so both run
// regardless of which one actually applies.
export function normalizeBomSpecClass(raw: string): string {
  return normalizeSpecClassCode(normalizeSpecClass(raw) ?? raw.trim().toUpperCase());
}

// Mirrors the ISO document page's own spec-break resolution for a BOM item
// (see lib/isoChecks.ts / lib/lineSummary.ts's bomBySpec) -- kept here as
// one shared implementation instead of a second copy that could silently
// drift from it.
export function resolveBomItemSpecClass(itemAttrs: Record<string, unknown>, lineAttrs: Record<string, unknown>): string {
  const itemClass = itemAttrs.item_spec_class;
  if (typeof itemClass === "string" && itemClass.trim()) return itemClass.trim();
  const breaks = Array.isArray(lineAttrs.spec_breaks) ? lineAttrs.spec_breaks : [];
  const lineClass = typeof lineAttrs.spec_class === "string" ? lineAttrs.spec_class : "";
  if (breaks.length < 2 && lineClass) return lineClass;
  return "Unassigned";
}

export type BomCrossCheckStatus = "match" | "not_found" | "size_unrecognized" | "out_of_scope" | "class_not_found" | "no_client_data";

/**
 * One Badge tone per status -- shared so the class detail page and a line's
 * own MTO summary (LineReviewView) render the same status the same colour
 * and cannot drift onto two different conventions.
 */
export const BOM_STATUS_TONE: Record<BomCrossCheckStatus, "success" | "danger" | "warning" | "neutral" | "info"> = {
  match: "success",
  not_found: "danger",
  size_unrecognized: "warning",
  out_of_scope: "neutral",
  class_not_found: "danger",
  no_client_data: "info",
};

export interface BomCrossCheckResult {
  status: BomCrossCheckStatus;
  label: string;
  note: string | null;
  clientDescription?: string | null;
  clientSize?: string | null;
  // Which row in clientClass[category] this resolved to -- lets the caller
  // cross-reference groupAdminItemsByClassRow's own "{category}:{index}"
  // keys to answer "was this ALSO confirmed by the admin's own item list"
  // without this function needing to know anything about admin data at all
  // (the same separation crossCheckItem/compareAdminItemToClientRow keep).
  matchedCategory?: SpecCategory;
  matchedRowIndex?: number;
}

export function crossCheckBomItem(item: Record<string, unknown>, clientClass: Record<string, unknown> | undefined): BomCrossCheckResult {
  const classification = classifyBomItem(item);
  if (!classification) {
    return {
      status: "out_of_scope",
      label: "Not itemized in client spec",
      note: "This BOM item's component type isn't tracked in the piping material spec as its own row (e.g. gasket, bolt, support, instrument/control valve).",
    };
  }
  if (!clientClass) {
    return {
      status: "class_not_found",
      label: "Class not in client spec",
      note: `No client spec_sheet extraction found for class "${String(item.item_spec_class ?? item.spec_class ?? "(blank)")}" -- upload/extract that class's spec sheet to cross-check this item.`,
    };
  }

  const inches = bomSizeToInches(item.size);
  if (inches == null) {
    return { status: "size_unrecognized", label: "Size not recognized", note: `"${String(item.size ?? "")}" isn't a standard NPS/DN size.` };
  }

  const rows = (clientClass[classification.category] as Array<Record<string, unknown>> | undefined) ?? [];
  if (rows.length === 0) {
    return {
      status: "no_client_data",
      label: "No client data",
      note: `Client spec class has no ${classification.category} extracted at all -- re-run its extraction, not a BOM discrepancy.`,
    };
  }

  const indexed = rows.map((row, index) => ({ row, index }));
  const typeMatches = indexed.filter(({ row }) => rowMatchesTypeHint(row, classification.hint));
  const inRange = typeMatches.filter(({ row }) => rowSizeRangeContains(row, inches));

  if (inRange.length === 0) {
    return {
      status: "not_found",
      label: "Not in client spec",
      note: `No ${classification.category} row covers ${inches}" NPS at this item's own type -- this BOM item isn't in the client spec's list at this size.`,
    };
  }

  const match = inRange[0];
  return {
    status: "match",
    label: "Match",
    note: `Found in client spec's ${classification.category} list at this size.`,
    clientDescription: String(match.row.description ?? match.row.material ?? "") || null,
    clientSize: sizeRangeLabel(match.row),
    matchedCategory: classification.category,
    matchedRowIndex: match.index,
  };
}

/**
 * The class this BOM item's own named material points at, among the classes a
 * sheet's spec breaks list -- or null to leave it where it was placed.
 *
 * Each candidate class is asked what ITS spec says about this item (the same
 * row crossCheckBomItem resolves), and the item goes to the class whose spec
 * text carries the material the item names. See packages/shared/src/
 * specEvidence.ts for why only specific materials count.
 */
export function classByMaterial(
  item: Record<string, unknown>,
  placedClass: string,
  candidateClasses: string[],
  clientClassByNorm: Map<string, Record<string, unknown>>
): { code: string; markers: string[] } | null {
  const evidence = candidateClasses.map((code) => {
    const result = crossCheckBomItem(item, clientClassByNorm.get(normalizeBomSpecClass(code)));
    return { code, specText: result.status === "match" ? (result.clientDescription ?? null) : null };
  });
  return classByMaterialEvidence(String(item.description ?? ""), placedClass, evidence, (a, b) => normalizeBomSpecClass(a) === normalizeBomSpecClass(b));
}

/**
 * A BOM gasket, checked against the admin item list.
 *
 * The client spec has no per-gasket line to check one against, but the admin list
 * does: a gasket line's Size is the FLANGE size it fits, so a BOM gasket of size 80
 * is matched by any admin gasket line of size 80 in the same class. Nothing else is
 * required. The pressure class is only used to narrow the lines shown, and to flag
 * the case where the admin states a rating for every line and none is the BOM's.
 *
 * Null for anything that is not a gasket, and when no admin list is uploaded (the
 * item then stays "not itemized", as before).
 */
export function crossCheckBomGasket(
  item: Record<string, unknown>,
  classCode: string,
  adminItems: SheetItem[]
): { result: BomCrossCheckResult; adminMatches: SheetItem[]; adminMismatches: AdminAttributeMismatch[] } | null {
  const description = String(item.description ?? "");
  const isGasket = /^\s*gasket\b/i.test(description) || /\bgasket\b/i.test(String(item.component_type ?? ""));
  if (!isGasket || adminItems.length === 0) return null;

  const norm = normalizeBomSpecClass(classCode);
  const pool = adminItems.filter((a) => a.specCode.trim() && normalizeBomSpecClass(a.specCode) === norm && adminItemHint(a)?.typeHint === "gasket");
  const notFound = (note: string) => ({
    result: { status: "not_found" as const, label: "Not in admin list", note },
    adminMatches: [] as SheetItem[],
    adminMismatches: [] as AdminAttributeMismatch[],
  });
  if (pool.length === 0) return notFound(`The admin item list has no gasket lines for class "${classCode}".`);

  // Size is the whole match. narrowAdminMatches records a size mismatch when no
  // line has it, which here means "no gasket of this size".
  const bySize = narrowAdminMatches(pool, { size: item.size, description: "" });
  if (bySize.mismatches.some((m) => m.attribute === "size")) {
    return notFound(`The admin item list has no size ${String(item.size ?? "").trim()} gasket in class "${classCode}".`);
  }

  let lines = bySize.matches;
  const mismatches: AdminAttributeMismatch[] = [];
  const wanted = new Set([...description.matchAll(/\b(\d{3,4})\s*#/g)].map((m) => m[1]));
  if (wanted.size > 0) {
    const ratingOf = (m: SheetItem) => {
      const r = parsePressureRating(`${m.description} ${m.material}`);
      return r == null ? null : String(r);
    };
    const agreeing = lines.filter((m) => {
      const r = ratingOf(m);
      return r === null || wanted.has(r);
    });
    if (agreeing.length > 0) lines = agreeing;
    else {
      const found = [...new Set(lines.map(ratingOf).filter((r): r is string => r !== null))];
      if (found.length > 0) mismatches.push({ attribute: "pressure class", wanted: [...wanted].map((r) => `${r}#`).join(" / "), found: found.map((r) => `${r}#`) });
    }
  }

  const seen = new Set<string>();
  const adminMatches = lines.filter((m) => {
    const key = combineAdminText(m);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    result: { status: "match", label: "Match", note: "A gasket of this size is in the admin item list." },
    adminMatches: closestAdminLines(adminMatches, description),
    adminMismatches: mismatches,
  };
}

export type AdminCheckStatus = "match" | "deviation" | "missing" | "no_list" | "skipped";

/** One BOM item checked against the admin item list alone. */
export interface AdminCheck {
  status: AdminCheckStatus;
  label: string;
  note: string | null;
  /** The admin line(s) the item was matched to -- the closest one, not every twin. */
  adminMatches: SheetItem[];
  /** Attributes the BOM states that the admin's lines contradict. */
  adminMismatches: AdminAttributeMismatch[];
}

export const ADMIN_STATUS_TONE: Record<AdminCheckStatus, "success" | "warning" | "danger" | "neutral"> = {
  match: "success",
  deviation: "warning",
  missing: "danger",
  no_list: "neutral",
  skipped: "neutral",
};

const ADMIN_STATUS_LABEL: Record<AdminCheckStatus, string> = {
  match: "Match",
  deviation: "Deviation",
  missing: "Not in admin list",
  no_list: "No admin list",
  skipped: "Not checked",
};

function adminCheck(status: AdminCheckStatus, note: string | null, adminMatches: SheetItem[] = [], adminMismatches: AdminAttributeMismatch[] = []): AdminCheck {
  return { status, label: ADMIN_STATUS_LABEL[status], note, adminMatches, adminMismatches };
}

/**
 * Does the admin item list carry this BOM item, in the class the item is filed under?
 *
 * The admin list is the only thing consulted. A line matches when it is the same kind
 * of component at the same size and nothing the BOM states about its schedule, angle,
 * construction or pressure class is contradicted:
 *   match      an admin line agrees on everything the BOM states
 *   deviation  the admin has the component at that size, but a stated attribute differs
 *   missing    the admin list has no such component, or none at this size
 *   no_list    no admin lines at all for this class
 *   skipped    not something the admin list itemises (supports, instruments, control
 *              valves, stud bolts), or the item has no class
 */
export function crossCheckBomAdmin(item: Record<string, unknown>, classCode: string, adminItems: SheetItem[]): AdminCheck {
  if (classCode === "Unassigned") return adminCheck("skipped", "The drawing doesn't show which class this sits in.");

  const norm = normalizeBomSpecClass(classCode);
  if (!adminItems.some((a) => a.specCode.trim() && normalizeBomSpecClass(a.specCode) === norm)) {
    return adminCheck("no_list", `The admin item list has no lines for class "${classCode}".`);
  }

  const gasket = crossCheckBomGasket(item, classCode, adminItems);
  if (gasket) {
    if (gasket.result.status !== "match") return adminCheck("missing", gasket.result.note);
    return adminCheck(gasket.adminMismatches.length > 0 ? "deviation" : "match", gasket.result.note, gasket.adminMatches, gasket.adminMismatches);
  }

  const classification = classifyBomItem(item);
  if (!classification) return adminCheck("skipped", "Supports, instruments, control valves and stud bolts aren't lines in the admin item list.");

  const pool = adminPoolFor(classification, norm, adminItems);
  if (pool.length === 0) return adminCheck("missing", `The admin item list has no ${classification.category} of this type in class "${classCode}".`);

  const narrowed = narrowAdminMatches(pool, item);
  const size = narrowed.mismatches.find((m) => m.attribute === "size");
  if (size) return adminCheck("missing", `The admin item list has this component in ${size.found.join(" / ")}, but not ${size.wanted}.`);

  const lines = closestAdminLines(narrowed.matches, String(item.description ?? ""));
  return narrowed.mismatches.length > 0 ? adminCheck("deviation", null, lines, narrowed.mismatches) : adminCheck("match", null, lines);
}

const typeHintsAgree =(a: string | undefined, b: string | undefined): boolean => {
  if (!a || !b) return true; // one side names no sub-type (a plain valve, a pipe)
  if (a === b) return true;
  // The admin list sub-types a tee straight/reduced; a BOM may only say "tee".
  const tee = (x: string) => x === "tee" || x === "straight" || x === "reduced";
  return tee(a) && tee(b) && (a === "tee" || b === "tee");
};

/** The admin lines of one class that are the same KIND of component as this BOM item. */
function adminPoolFor(classification: BomClassification, normClass: string, adminItems: SheetItem[]): SheetItem[] {
  return adminItems.filter((a) => {
    if (!a.specCode.trim() || normalizeBomSpecClass(a.specCode) !== normClass) return false;
    const hint = adminItemHint(a);
    return hint != null && hint.category === classification.category && typeHintsAgree(classification.hint.typeHint, hint.typeHint);
  });
}

/**
 * The class whose ADMIN item list actually contains this BOM item, or null to leave
 * the item where it was placed.
 *
 * The admin list is one flat sheet whose every line names the class it belongs to
 * (Spec-of column), so "which class is this item" can be answered by looking the item
 * up: same component, same size, and none of its stated schedule / angle / construction
 * / named material contradicted by the class's lines (narrowAdminMatches). A class
 * whose lines hold the item is a candidate; the item moves only when exactly ONE
 * candidate does. Two classes that both carry it -- AC03N and AC03U sharing their 150#
 * flanges -- say nothing about which side of the break it sits, so it stays where the
 * drawing's position or rating put it.
 *
 * `candidateClasses` is what bounds this: the classes the ISO and its P&ID actually
 * involve, so an item is never filed under an unrelated class that happens to stock it.
 */
export function classByAdminList(
  item: Record<string, unknown>,
  placedClass: string,
  candidateClasses: string[],
  adminItems: SheetItem[]
): { code: string; matched: number } | null {
  const classification = classifyBomItem(item);
  if (!classification || adminItems.length === 0) return null;

  const wantedMarkers = materialMarkers(String(item.description ?? ""));
  // NACE service is what separates a class that is otherwise a twin of another:
  // AC03N and AC03U list the same carbon-steel pipe, fittings and flanges, but
  // AC03N's lines all say "NACE MR0175/ISO 15156" and AC03U's say nothing. A BOM
  // item that states NACE is therefore the NACE class's, and one that does not
  // is the plain class's.
  const isNace = (text: string) => /\bNACE\b/i.test(text);
  const bomNace = isNace(String(item.description ?? ""));
  const holding: Array<{ code: string; matched: number; nace: "nace" | "plain" | "mixed" }> = [];

  for (const code of candidateClasses) {
    const norm = normalizeBomSpecClass(code);
    const pool = adminPoolFor(classification, norm, adminItems);
    if (pool.length === 0) continue;

    const narrowed = narrowAdminMatches(pool, item);
    if (narrowed.matches.length === 0 || narrowed.mismatches.length > 0) continue;
    // A named material has to be in the lines that matched, or the class holds
    // a plain version of this item, not this one.
    const carriers = wantedMarkers.length === 0 ? narrowed.matches : narrowed.matches.filter((m) => textCarriesMarkers(combineAdminText(m), wantedMarkers));
    if (carriers.length === 0) continue;
    const texts = carriers.map((m) => isNace(combineAdminText(m)));
    holding.push({ code, matched: carriers.length, nace: texts.every(Boolean) ? "nace" : texts.some(Boolean) ? "mixed" : "plain" });
  }

  // A class whose lines are all NACE (or all plain) only holds the item if the item
  // says the same. A class that lists both kinds tells nothing either way.
  const agreeing = holding.filter((h) => h.nace === "mixed" || (h.nace === "nace") === bomNace);
  if (agreeing.length !== 1) return null;
  return normalizeBomSpecClass(agreeing[0].code) === normalizeBomSpecClass(placedClass) ? null : { code: agreeing[0].code, matched: agreeing[0].matched };
}

export type ValveClientStatus = "match" | "not_found" | "size_unrecognized" | "no_client_data";

export interface ValveClientResult {
  status: ValveClientStatus;
  clientDescription: string | null;
  // null when no admin data was resolved for this class at all (distinct
  // from false, which means the class's own client row is real but no
  // admin item list actually confirms it) -- same distinction the rest of
  // this app's admin cross-check already draws.
  adminConfirmed: boolean | null;
}

// Companion to crossCheckBomItem, scoped to valves specifically -- unlike
// pipes/fittings/flanges, a valve row is never sub-classified by type
// keyword anywhere in this app (the admin GTYPE table's own VALV entry has
// no typeHint, see verifySpecCrossCheck.ts's CATEGORY_BY_GTYPE), so a plain
// DN -> NPS -> rowSizeRangeContains check is the whole answer; no
// classification step is needed the way pipes/fittings/flanges require.
//
// NOT YET WIRED INTO ANY PAGE IN THIS REPO. Ported alongside the rest of
// this module because resolveClientAndAdminData below depends on it and the
// two are meant to be used together (the sibling project's ISO document page
// uses this for its own "Valve match: ISO vs P&ID" table's client/admin
// columns) -- this repo's own valve-match table (verifyIso.ts's
// ValveMatchRow/buildIsoChecks) does not call it yet. Left available rather
// than ported partially, in case that integration is wanted next; harmless
// unused exports until then.
export function resolveValveClientStatus(
  dn: number | null,
  clientClass: Record<string, unknown> | undefined,
  adminGroups: Map<string, SheetItem[]> | undefined
): ValveClientResult {
  const inches = dn == null ? null : (DN_TO_NPS_INCHES[dn] ?? null);
  if (inches == null) return { status: "size_unrecognized", clientDescription: null, adminConfirmed: null };
  if (!clientClass) return { status: "no_client_data", clientDescription: null, adminConfirmed: null };

  const rows = (clientClass.valves as Array<Record<string, unknown>> | undefined) ?? [];
  const index = rows.findIndex((row) => rowSizeRangeContains(row, inches));
  if (index === -1) return { status: "not_found", clientDescription: null, adminConfirmed: null };

  const row = rows[index];
  const adminConfirmed = adminGroups ? (adminGroups.get(`valves:${index}`)?.length ?? 0) > 0 : null;
  return { status: "match", clientDescription: String(row.description ?? row.material ?? "") || null, adminConfirmed };
}

export interface ClientAndAdminData {
  clientClassByNorm: Map<string, Record<string, unknown>>;
  adminGroupsByNorm: Map<string, Map<string, SheetItem[]>>;
}

// Resolves, for a SET of normalized class codes, (a) each one's own client
// spec_class data and (b) its admin-confirmed rows -- shared by every page
// that cross-checks ISO/BOM data against multiple spec classes at once. Pure/
// synchronous: callers do their own DB fetching and pass the already-fetched
// rows in. See resolveValveClientStatus's own comment -- not yet wired into
// any page in this repo, ported for the same reason.
export function resolveClientAndAdminData(
  specClassTags: Array<{ tagNumber: string; attributes: unknown }>,
  adminItems: SheetItem[],
  neededSpecs: Set<string>
): ClientAndAdminData {
  // More than one document can hold a spec_class tag for the SAME
  // normalized class code -- confirmed on a real project where a class has
  // both a real PDF-sourced extraction (pipes/fittings/flanges/valves all
  // populated) AND a broken .xlsx-sourced one (every array empty, a known
  // separate extraction bug). Postgres gives no row-order guarantee, so
  // "first one seen wins" is non-deterministic; picking the tag with the
  // MOST total rows across all four categories is deterministic regardless
  // of query order, and always prefers real data over an empty duplicate.
  const richness = (attrs: Record<string, unknown>) =>
    (["pipes", "fittings", "flanges", "valves"] as const).reduce((n, k) => n + (Array.isArray(attrs[k]) ? (attrs[k] as unknown[]).length : 0), 0);

  const clientClassByNorm = new Map<string, Record<string, unknown>>();
  for (const t of specClassTags) {
    const norm = normalizeSpecClassCode(t.tagNumber);
    if (!neededSpecs.has(norm)) continue;
    const attrs = t.attributes as Record<string, unknown>;
    const existing = clientClassByNorm.get(norm);
    if (!existing || richness(attrs) > richness(existing)) clientClassByNorm.set(norm, attrs);
  }

  const adminGroupsByNorm = new Map<string, Map<string, SheetItem[]>>();
  if (adminItems.length > 0) {
    for (const norm of neededSpecs) {
      const clientClass = clientClassByNorm.get(norm);
      if (clientClass) adminGroupsByNorm.set(norm, groupAdminItemsByClassRow(norm, clientClass, adminItems));
    }
  }

  return { clientClassByNorm, adminGroupsByNorm };
}
