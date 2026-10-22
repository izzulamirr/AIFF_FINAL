import { formatStudSize, parsePressureRating, studNutCounts, studOrderSize } from "@easy/shared";
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

// What makes one gasket a different gasket from another: its TYPE (spiral wound, flat ring, ring
// joint) and what it is made of (the winding, the filler, the insert, the outer ring). A 200 mm
// 150# spiral wound gasket is not a 200 mm 150# flat ring gasket, so matching on size and pressure
// class alone let one stand in for the other.
const GASKET_MARKERS: Array<[string, RegExp]> = [
  ["spiral wound", /SPIRAL\s*(?:WD|WOUND)/],
  ["flat ring", /FLAT\s*RING/],
  ["ring joint", /RING\s*JOINT|\bRTJ\b/],
  ["SS316", /\bSS\s*316L?\b/],
  ["316 insert", /316\s*INSERT/],
  ["non metal", /NON[\s-]*METAL/],
  ["tanged graphite", /TANGED\s*GRAPHITE/],
  ["graphite", /GRAPHITE/],
  ["alloy 625", /ALLOY[R]?\s*625/],
  ["cs outer ring", /CS\s*OUTER\s*RING|CARBON\s*STEEL/],
  ["ptfe", /PTFE/],
];

function gasketMarkers(text: string): string[] {
  const upper = text.toUpperCase();
  return GASKET_MARKERS.filter(([, re]) => re.test(upper)).map(([name]) => name);
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
  if (pool.length === 0) return notFound(`BOM gasket is not in the ${classCode} spec: no gasket is listed.`);

  // Size is the whole match. narrowAdminMatches records a size mismatch when no
  // line has it, which here means "no gasket of this size".
  const bySize = narrowAdminMatches(pool, { size: item.size, description: "" });
  if (bySize.mismatches.some((m) => m.attribute === "size")) {
    return notFound(`BOM gasket size ${String(item.size ?? "").trim()} is not in the ${classCode} spec.`);
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

  // Type and material: the admin line has to be the same KIND of gasket, made of what the BOM
  // says, not merely one of the right size and class.
  const wantedMarkers = gasketMarkers(description);
  if (wantedMarkers.length > 0) {
    const carrying = lines.filter((m) => {
      const has = gasketMarkers(combineAdminText(m));
      return wantedMarkers.every((w) => has.includes(w));
    });
    if (carrying.length > 0) lines = carrying;
    else {
      const nearest = closestAdminLines(lines, description);
      const found = [...new Set(nearest.flatMap((m) => gasketMarkers(combineAdminText(m))))];
      mismatches.push({ attribute: "gasket type / material", wanted: wantedMarkers.join(", "), found: found.length > 0 ? found : ["none"] });
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

const STUD_TEXT = /\bstud\s*bolt\b|\bbolt\s*set\b/i;

/**
 * A stud bolt against the admin list.
 *
 * The admin export has no diameter or length on its stud lines -- each is a coded reference
 * ("AC03N/150RF-FAMA-Z") and a description ending "WITH 2 NUTS" or "WITH 3 NUTS" -- so what a
 * stud CAN be matched on is that the class has a stud line stating the same nut count. The size
 * is shown as what to order (the diameter as the BOM states it, the length up to the next 5 mm,
 * which is the step the admin's studs are made to) and is not compared.
 */
function checkStudBolt(item: Record<string, unknown>, classCode: string, norm: string, adminItems: SheetItem[]): AdminCheck | null {
  const description = String(item.description ?? "");
  if (!STUD_TEXT.test(`${item.component_type ?? ""} ${description}`)) return null;

  const size = studOrderSize(item.size);
  const detail = size
    ? `Order size ${formatStudSize(size)} mm (BOM ${size.diameterMm}X${size.lengthMm}, length up to the next 5 mm)`
    : null;

  const lines = adminItems.filter((a) => a.specCode.trim() && normalizeBomSpecClass(a.specCode) === norm && adminItemHint(a)?.typeHint === "bolt");
  if (lines.length === 0) return { ...missing(`BOM stud bolt is not in the ${classCode} spec: no stud bolt is listed.`, BOM_ACTION.component(classCode)), detail };

  const wanted = studNutCounts(description);
  const nutsOf = (a: SheetItem) => studNutCounts(combineAdminText(a));
  const agreeing = wanted.length === 0 ? lines : lines.filter((a) => nutsOf(a).some((n) => wanted.includes(n)));

  const distinct = (rows: SheetItem[]) => {
    const seen = new Set<string>();
    return rows.filter((r) => {
      const key = combineAdminText(r);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  if (agreeing.length > 0) return { ...adminCheck("match", null, distinct(agreeing)), detail };

  const found = [...new Set(lines.flatMap(nutsOf))].sort((x, y) => x - y);
  return {
    ...adminCheck("deviation", null, distinct(lines).slice(0, 1), [{ attribute: "nuts", wanted: `${wanted.join(" / ")}`, found: found.map(String) }]),
    detail,
  };
}

export type AdminCheckStatus = "match" | "wrong_spec" | "deviation" | "missing" | "no_list" | "skipped";

/** One BOM item checked against the admin item list alone. */
export interface AdminCheck {
  status: AdminCheckStatus;
  label: string;
  note: string | null;
  /** Something worth saying beside a verdict, whatever it is (a stud's order size). */
  detail?: string | null;
  /**
   * What somebody has to DO about it, and who -- set where the item is not in the
   * admin spec. `note` says what is wrong; this says what happens next, so a
   * reader does not have to work out whether the drawing or the spec is at fault.
   */
  action?: string | null;
  /**
   * Set when the item does not match the class it is filed under but DOES match another spec on
   * its sheet: the classes it matches instead. The item is not moved -- the class is the
   * extraction's -- the wrong spec is reported.
   */
  wrongSpec?: string[];
  /** The admin line(s) the item was matched to -- the closest one, not every twin. */
  adminMatches: SheetItem[];
  /** Attributes the BOM states that the admin's lines contradict. */
  adminMismatches: AdminAttributeMismatch[];
}

export const ADMIN_STATUS_TONE: Record<AdminCheckStatus, "success" | "warning" | "danger" | "neutral"> = {
  match: "success",
  wrong_spec: "danger",
  deviation: "danger",
  missing: "danger",
  no_list: "neutral",
  skipped: "neutral",
};

const ADMIN_STATUS_LABEL: Record<AdminCheckStatus, string> = {
  match: "Match",
  // Said plainly, as what is wrong with the BOM. "Deviation" was dropped: it
  // reads as a tolerated difference, when the BOM item is simply not to spec.
  //   deviation   the item is in the class, but what the BOM states is not what the spec requires
  //   wrong_spec  the item belongs to a DIFFERENT class from the one it is filed under
  wrong_spec: "Wrong class",
  deviation: "Wrong spec",
  missing: "Not in spec",
  no_list: "Class not in spec",
  skipped: "Not checked",
};

// THE ADMIN SPEC IS THE REFERENCE. Every verdict here is a statement about the
// BOM -- what the BOM states, and what the spec requires instead -- never about
// the admin list being wrong. A result that reads "admin A105N" in red invites
// the question of who is at fault; "BOM A234 WPB, spec requires A105N" does not.

/** One attribute the BOM gets wrong, said from the BOM's side. `specClass` names the spec where that matters. */
export function bomFault(m: AdminAttributeMismatch, specClass?: string): string {
  const attribute = m.attribute.charAt(0).toUpperCase() + m.attribute.slice(1);
  return `${attribute}: BOM states ${m.wanted} — ${specClass ?? "spec"} requires ${m.found.join(" / ")}`;
}

/** The same admin line reached by two parts of a merged row is one line. */
function distinctLines(lines: SheetItem[]): SheetItem[] {
  const seen = new Set<string>();
  return lines.filter((l) => {
    const key = combineAdminText(l);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function adminCheck(status: AdminCheckStatus, note: string | null, adminMatches: SheetItem[] = [], adminMismatches: AdminAttributeMismatch[] = []): AdminCheck {
  return { status, label: ADMIN_STATUS_LABEL[status], note, adminMatches, adminMismatches };
}

// The required action. The fix is always to the BOM, since the admin spec is
// the reference it is checked against.
const BOM_ACTION = {
  /** The class has no line for this kind of component at all. */
  component: (classCode: string) => `Piping designer to correct the BOM: replace this item with one listed in the ${classCode} spec.`,
  /** The component is in the class, but not at the size the BOM states. */
  size: (classCode: string, available: string[]) =>
    `Piping designer to correct the BOM size to one listed in the ${classCode} spec (${available.join(" / ")}).`,
  /** The BOM's class is not in the admin spec at all. */
  noList: (classCode: string) =>
    `Piping designer to confirm the class on the BOM: "${classCode}" is not in the admin spec, so no item filed under it can be checked.`,
  /** The component is listed, but an attribute the BOM states differs. */
  deviation: (classCode: string) => `Piping designer to correct the BOM item to match the ${classCode} spec.`,
  /** Filed under one class, but matches another. */
  wrongSpec: (ownClass: string, matches: string[]) =>
    matches.length > 0
      ? `Piping designer to correct the BOM: file this item under ${matches.join(" / ")}, or change it to the item the ${ownClass} spec requires.`
      : `Piping designer to correct the BOM item to the one the ${ownClass} spec requires.`,
};

/** A "not in admin list" verdict carrying its required action. */
function missing(note: string, action: string): AdminCheck {
  return { ...adminCheck("missing", note), action };
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
/** One verdict for the parts of a cell that landed in the same class. */
function combineChecks(checks: AdminCheck[]): AdminCheck {
  if (checks.length === 1) return checks[0];
  const checked = checks.filter((c) => c.status !== "skipped");
  if (checked.length === 0) return checks[0];
  const failing = checked.filter((c) => c.status !== "match");
  const lines = distinctLines(checked.flatMap((c) => c.adminMatches));
  if (failing.length === 0) {
    const detail = checked.map((c) => c.detail).filter(Boolean).join("; ");
    return { ...adminCheck("match", null, lines), ...(detail ? { detail } : {}) };
  }
  return { ...failing[0], adminMatches: lines, adminMismatches: failing.flatMap((c) => c.adminMismatches) };
}

const failed = (c: AdminCheck) => c.status === "deviation" || c.status === "missing" || c.status === "no_list";

/**
 * One BOM item against the admin list, under the class the extraction filed it under.
 *
 * The item is NOT moved. The class is what the drawing says, and a BOM that is filed under the
 * wrong spec is a fault in the extraction or the design, not something to quietly repair. So:
 *   - it matches its own class          -> match
 *   - it does not, but it matches another spec on its sheet identically (same pressure class,
 *     NACE service, schedule and named material, carried by the admin line and not merely
 *     unstated)                          -> "Wrong spec", naming the spec it matches
 *   - it matches no spec on the sheet   -> the deviation or missing line it is
 *
 * A BOM cell that holds several items is judged part by part, so a plain pipe matching does not
 * hide the clad pipe beside it -- but it stays one row, under one class.
 */
export function checkBomItem(item: Record<string, unknown>, ownClass: string, sheetClasses: string[], adminItems: SheetItem[]): AdminCheck {
  const description = String(item.description ?? "");
  const own = normalizeBomSpecClass(ownClass);
  const segments = splitMergedRow(description);

  // Every class the admin list has, not only the ones this sheet's BOM is filed under: the spec an
  // item really belongs to may be one the drawing never mentions (AC03U on a sheet of AC03N/BC70N).
  const candidates = [...new Set([...sheetClasses, ...adminItems.map((a) => a.specCode.trim()).filter(Boolean)].map(normalizeBomSpecClass))]
    .filter((c) => c !== own);
  const hasNace = (t: string) => /\bNACE\b/i.test(t);
  const lineText = (l: SheetItem) => `${l.description} ${l.material}`;

  const parts = segments.map((text) => {
    const part = { ...item, description: text };
    const here = checkAgainstClass(part, ownClass, adminItems);
    const elsewhere: Array<{ code: string; lines: SheetItem[]; why: "match" | "service" }> = [];
    let serviceNote: string | null = null;
    if (failed(here)) {
      for (const c of candidates) {
        const there = checkAgainstClass(part, c, adminItems);
        if (there.status === "match" && agreesOutright(part, there.adminMatches)) elsewhere.push({ code: c, lines: there.adminMatches, why: "match" });
      }
      // NACE is the service the whole class is written for, not a detail of one line. A BOM that
      // states no NACE against a class whose lines are all NACE (or the reverse) is the wrong spec
      // whatever else differs; the classes that carry the item in the BOM's own service are named.
      const bomNace = hasNace(text);
      if (elsewhere.length === 0 && here.adminMatches.length > 0 && here.adminMatches.every((l) => hasNace(lineText(l)) !== bomNace)) {
        serviceNote = bomNace
          ? `BOM states NACE, but ${ownClass} is not NACE service`
          : `BOM does not state NACE, but ${ownClass} requires NACE MR0175 service`;
        for (const c of candidates) {
          const there = checkAgainstClass(part, c, adminItems);
          if ((there.status === "match" || there.status === "deviation") && there.adminMatches.some((l) => hasNace(lineText(l)) === bomNace)) {
            elsewhere.push({ code: c, lines: there.adminMatches, why: "service" });
          }
        }
        if (elsewhere.length === 0) elsewhere.push({ code: "", lines: here.adminMatches, why: "service" });
      }
    }
    return { text, here, elsewhere, serviceNote };
  });

  const wrong = parts.filter((p) => failed(p.here) && p.elsewhere.length > 0);
  if (wrong.length > 0) {
    const classes = [...new Set(wrong.flatMap((p) => p.elsewhere.map((e) => e.code).filter(Boolean)))];
    const short = (t: string) => (t.length > 70 ? `${t.slice(0, 70)}...` : t);
    const said = wrong
      .map((p) => {
        const subject = segments.length > 1 ? `"${short(p.text)}" ` : "";
        const codes = p.elsewhere.map((e) => e.code).filter(Boolean).join(" / ");
        if (p.serviceNote) return `${subject}${p.serviceNote}${codes ? `; the item as stated on the BOM matches ${codes}` : "; no other spec carries the item as stated on the BOM"}`;
        return `${subject}BOM item matches ${codes}, not ${ownClass}`;
      })
      .join("; ");
    // A cell of several items: say which part is right, or the row reads as though all of it is wrong.
    const fine = parts.filter((p) => !wrong.includes(p) && p.here.status === "match");
    const rest =
      segments.length > 1 && fine.length > 0
        ? ` The other ${fine.length === 1 ? "item" : `${fine.length} items`} in this cell ${fine.length === 1 ? "matches" : "match"} ${ownClass}.`
        : "";
    return {
      ...adminCheck(
        "wrong_spec",
        `${said}. The BOM item is filed under the wrong class.${rest}`,
        distinctLines(wrong.flatMap((p) => p.elsewhere.flatMap((e) => e.lines))),
        wrong.flatMap((p) => p.here.adminMismatches)
      ),
      wrongSpec: classes,
      action: BOM_ACTION.wrongSpec(ownClass, classes),
    };
  }
  const combined = combineChecks(parts.map((p) => p.here));
  return combined.status === "deviation" && !combined.action ? { ...combined, action: BOM_ACTION.deviation(ownClass) } : combined;
}

// Sorting an item into another class is a claim, and a class whose admin lines merely SAY NOTHING
// about an attribute the item states has not shown it carries the item. So beyond the ordinary match,
// the other class's lines must positively agree with the BOM on what it states: the same NACE
// service (present on both or on neither -- AC03N's lines all say NACE, AC03U's none), the same
// pressure class, and a schedule where the BOM states one.
function agreesOutright(item: Record<string, unknown>, lines: SheetItem[]): boolean {
  if (lines.length === 0) return false;
  const description = String(item.description ?? "");
  const textOf = (l: SheetItem) => `${l.description} ${l.material}`;

  const bomNace = /\bNACE\b/i.test(description);
  if (!lines.some((l) => /\bNACE\b/i.test(textOf(l)) === bomNace)) return false;

  const ratings = new Set([...description.matchAll(/\b(\d{3,4})\s*(?:#|LBS?\b)/gi)].map((m) => m[1]));
  if (ratings.size > 0) {
    const stated = lines.map((l) => parsePressureRating(textOf(l))).filter((r): r is number => r != null);
    if (!stated.some((r) => ratings.has(String(r)))) return false;
  }

  if (/\bSCH\s?\d/i.test(description) && !lines.some((l) => /\bSCH\s?\d/i.test(textOf(l)))) return false;

  const markers = materialMarkers(description);
  if (markers.length > 0 && !lines.some((l) => carriesMarkers(textOf(l), markers))) return false;
  return true;
}

// A specific material the BOM names -- alloy 625, clad, overlay, inconel, duplex, stainless -- is
// part of what the item IS. Size, schedule and construction agreeing does not make a plain pipe
// the clad pipe, so where the BOM names one, the matched admin line has to carry it too.
const MATERIAL_MARKERS: RegExp[] = [
  /\bALLOY\s*-?\s*\d{3,4}\b/g,
  /\bCLAD(?:DING)?\b/g,
  /\bOVERLAY\b/g,
  /\bINCONEL(?:\s*\d{3,4})?\b/g,
  /\bMONEL(?:\s*\d{3})?\b/g,
  /\bHASTELLOY\b/g,
  /\bDUPLEX\b/g,
  /\bUNS\s*[A-Z]\d{5}\b/g,
];
const squash = (s: string) => s.toUpperCase().replace(/[\s.\-]+/g, "");
function materialMarkers(text: string): string[] {
  const upper = text.toUpperCase();
  const found = new Set<string>();
  for (const re of MATERIAL_MARKERS) for (const m of upper.matchAll(re)) found.add(squash(m[0]));
  return [...found];
}
const carriesMarkers = (text: string, markers: string[]) => {
  const haystack = squash(text);
  return markers.every((m) => haystack.includes(m));
};

// Row-splitting: the words an item's description opens with. A row is merged when the same one
// opens it more than once ("PIPE ... PIPE ...", "FLANGE ... FLANGE ...", "GASKET ... GASKET ...").
const ITEM_HEADS = ["PIPE", "FLANGE", "GASKET", "STUD BOLT", "ELBOW", "REDU", "REDUCER", "REDUCING TEE", "TEE", "WELDOLET", "SPECTACLE BLIND"];

/** The items a merged BOM cell holds, or the one description when it is not merged. */
export function splitMergedRow(description: string): string[] {
  const text = description.trim();
  const head = ITEM_HEADS.find((h) => new RegExp(`^(?:\\d+\\s+)?${h}\\b`, "i").test(text));
  if (!head) return [text];
  const starts: number[] = [];
  for (const m of text.matchAll(new RegExp(`\\b${head}\\b`, "gi"))) {
    const at = m.index ?? 0;
    // "TO MATCH PIPE", "BORE TO MATCH FLANGE": mentioned, not starting an item.
    if (at > 0 && /\b(?:MATCH|TO|WITH|OF)\s*$/i.test(text.slice(Math.max(0, at - 12), at))) continue;
    // A stud's length leads its description: "110 STUD BOLT ...".
    const lead = /(\d+\s+)$/.exec(text.slice(0, at));
    starts.push(lead && at > 0 ? at - lead[1].length : at);
  }
  if (starts.length < 2 || starts[0] !== 0) return [text];
  const segments = starts.map((s, i) => text.slice(s, starts[i + 1] ?? text.length).trim());
  // Two short fragments are a description that happens to repeat a word, not two items.
  return segments.every((s) => s.length >= 25) ? segments : [text];
}

function checkAgainstClass(item: Record<string, unknown>, classCode: string, adminItems: SheetItem[]): AdminCheck {
  const result = checkWithinClass(item, classCode, adminItems);
  if (result.status !== "match") return result;
  const markers = materialMarkers(String(item.description ?? ""));
  if (markers.length === 0 || result.adminMatches.some((l) => carriesMarkers(`${l.description} ${l.material}`, markers))) return result;
  return {
    ...result,
    status: "deviation",
    label: ADMIN_STATUS_LABEL.deviation,
    adminMismatches: [
      ...result.adminMismatches,
      { attribute: "material", wanted: markers.map((m) => m.replace(/([A-Z])(\d)/, "$1 $2")).join(" ").toLowerCase(), found: ["none"] },
    ],
  };
}

function checkWithinClass(item: Record<string, unknown>, classCode: string, adminItems: SheetItem[]): AdminCheck {
  if (classCode === "Unassigned") return adminCheck("skipped", "The drawing doesn't show which class this sits in.");

  const norm = normalizeBomSpecClass(classCode);
  if (!adminItems.some((a) => a.specCode.trim() && normalizeBomSpecClass(a.specCode) === norm)) {
    return { ...adminCheck("no_list", `BOM class "${classCode}" is not in the admin spec.`), action: BOM_ACTION.noList(classCode) };
  }

  const gasket = crossCheckBomGasket(item, classCode, adminItems);
  if (gasket) {
    if (gasket.result.status !== "match") return missing(gasket.result.note ?? `BOM item is not in the ${classCode} spec.`, BOM_ACTION.component(classCode));
    return adminCheck(gasket.adminMismatches.length > 0 ? "deviation" : "match", gasket.result.note, gasket.adminMatches, gasket.adminMismatches);
  }

  const stud = checkStudBolt(item, classCode, norm, adminItems);
  if (stud) return stud;

  const classification = classifyBomItem(item);
  if (!classification) return adminCheck("skipped", "Supports, instruments, control valves and stud bolts aren't lines in the admin item list.");

  const pool = adminPoolFor(classification, norm, adminItems);
  if (pool.length === 0) {
    return missing(`BOM item is not in the ${classCode} spec: no ${classification.category} of this type is listed.`, BOM_ACTION.component(classCode));
  }

  const narrowed = narrowAdminMatches(pool, item);
  const size = narrowed.mismatches.find((m) => m.attribute === "size");
  if (size) {
    return missing(`BOM size ${size.wanted} is not in the ${classCode} spec, which lists ${size.found.join(" / ")}.`, BOM_ACTION.size(classCode, size.found));
  }

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
