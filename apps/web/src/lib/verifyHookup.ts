// Hook-up verification: does the ISO (the shop drawing) actually carry the
// components a typical instrument hook-up requires?
//
// The reason this check exists: a P&ID SIMPLIFIES an instrument to a bubble
// and a tap. The valves that really sit between the line and the instrument
// -- the root/isolation valve above all -- are not drawn there. So an ISO
// checked only against a P&ID can be missing them and still look complete.
// The hook-up typical is the document that says what must be there.
//
// Only the PIPING side of the discipline break is checked. Tubing, tube
// fittings and the valve manifold are the instrument department's supply;
// holding a piping ISO to them would report a shortfall that is not the
// piping engineer's to answer for.
import { classifyComponent, classifyInstrument, normalizeNominalSize, formatNominalSize } from "./verifyIso";

export interface HookupItem {
  itemNo: string | null;
  description: string;
  size: string | null;
  quantity: string | null;
  discipline: string;
  disciplineBasis: string | null;
  /** Required by the sheet but not in its BOM -- deferred to another document. */
  implied: boolean;
  deferredTo: string | null;
  /** Where the size came from, when the sheet does not print one outright. */
  sizeBasis: string | null;
  /**
   * The document this sheet hands the component's TYPE to. A flow-transmitter
   * typical draws the isolation valve as a dashed reference and states only
   * its configuration (SBB or DBB), sending the type to the piping standard
   * detail. That deferral is itself the requirement and has to be visible --
   * resolving the type from the ISO instead would invert the check, since the
   * ISO is the document being audited.
   */
  typeDeferredTo: string | null;
  /**
   * True when the sheet does NOT fix this size -- the flow-transmitter
   * typicals defer the isolation valve's size to the piping standard, so the
   * size shown is the connection the sheet evidences, not a requirement. A
   * size like that must not be used to reject an otherwise correct match.
   */
  sizeIndicative: boolean;
}

export interface HookupSheet {
  key: string;
  title: string | null;
  sheet: string | null;
  drawingNumber: string | null;
  instrumentType: string | null;
  measuredVariable: string | null;
  service: string | null;
  mounting: string | null;
  slope: string | null;
  disciplineBreakNote: string | null;
  items: HookupItem[];
  sourcePage: number | null;
}

export interface HookupItemCheck {
  item: HookupItem;
  status: "present" | "missing" | "not checkable";
  isoDetail: string | null;
  /**
   * What the ISO actually specified for a requirement the typical states
   * only by function. The hook-up says "isolation valve"; the ISO says
   * "gate valve" -- the specific answer is what a reviewer needs to see.
   */
  matchedAs: string | null;
  /** The bore the ISO specified for it, so the named component is complete. */
  matchedSize: string | null;
}

export interface HookupInstrumentCheck {
  instrumentTag: string;
  instrumentLabel: string;
  measuredVariable: string | null;
  service: string | null;
  /** null when no typical in the set covers this instrument. */
  sheet: HookupSheet | null;
  /** true when a person picked the sheet instead of the automatic match. */
  overridden: boolean;
  checks: HookupItemCheck[];
  missingCount: number;
}

/** Groups a hook-up document's tags back into sheets. */
export function groupHookupSheets(tags: Array<{ tagType: string; tagNumber: string; sourcePage: number | null; attributes: unknown }>): HookupSheet[] {
  const bySheet = new Map<string, HookupSheet>();
  for (const tag of tags) {
    if (tag.tagType !== "hookup_item") continue;
    const a = tag.attributes as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const key = `${tag.sourcePage ?? "?"}|${str(a.drawing_number) ?? ""}|${str(a.sheet) ?? ""}`;
    let sheet = bySheet.get(key);
    if (!sheet) {
      sheet = {
        key,
        title: str(a.title),
        sheet: str(a.sheet),
        drawingNumber: str(a.drawing_number),
        instrumentType: str(a.instrument_type),
        measuredVariable: str(a.measured_variable)?.toLowerCase() ?? null,
        service: str(a.service)?.toLowerCase() ?? null,
        mounting: str(a.mounting),
        slope: str(a.slope),
        disciplineBreakNote: str(a.discipline_break_note),
        items: [],
        sourcePage: tag.sourcePage,
      };
      bySheet.set(key, sheet);
    }
    sheet.items.push({
      itemNo: str(a.item_no),
      description: String(a.description ?? tag.tagNumber),
      size: str(a.size),
      quantity: str(a.quantity),
      discipline: String(a.discipline ?? "undetermined"),
      disciplineBasis: str(a.discipline_basis),
      implied: a.implied === true,
      deferredTo: str(a.deferred_to),
      sizeBasis: str(a.size_basis),
      sizeIndicative: a.size_indicative === true,
      typeDeferredTo: str(a.type_deferred_to),
    });
  }
  return [...bySheet.values()].sort((a, b) => (a.sourcePage ?? 0) - (b.sourcePage ?? 0));
}

// The PLL's fluid phase is a single letter ("L", "V"); a hook-up sheet
// spells its service out and may cover more than one ("GAS/ LIQUID
// (NON-TOXIC SERVICE)" is valid for both). So this returns the SET of
// services a value covers, not one label.
//
// The single-letter forms are matched anchored and on their own: an earlier
// version used /^l|liq/, which the regex engine reads as (^l)|(liq) -- so
// "gas/liquid" matched "liquid" AND "gas", and the first pressure sheet in
// the set silently won every pressure lookup.
export function serviceSet(value: unknown): Set<string> {
  const s = String(value ?? "").trim().toLowerCase();
  const out = new Set<string>();
  if (!s) return out;
  if (/^l$/.test(s) || /\bliquid\b|\bliq\b/.test(s)) out.add("liquid");
  if (/^[vg]$/.test(s) || /\bgas\b|\bvapou?r\b|\bvap\b/.test(s)) out.add("gas");
  if (/\bsteam\b/.test(s)) out.add("steam");
  if (/two.?phase|mixed/.test(s)) out.add("two phase");
  if (out.size === 0) out.add(s);
  return out;
}

/** The single best label for display; null when the value names no service. */
export function normalizeService(value: unknown): string | null {
  const set = serviceSet(value);
  return set.size === 0 ? null : [...set].join("/");
}

/**
 * Picks the typical that applies to an instrument. A hook-up set is indexed
 * by measured variable and service, which is exactly what an ISA tag plus the
 * line's fluid phase give us: FT-0003 on a liquid line wants the
 * "flow transmitter / liquid service" sheet.
 *
 * Variable must match -- a pressure typical is never right for a flow
 * transmitter. Service must match too where the set distinguishes it: liquid
 * and gas hook-ups are genuinely different assemblies (a liquid impulse line
 * runs DOWN from the tap so it self-drains, a gas one runs UP so it
 * self-vents, and the transmitter sits on the opposite side accordingly).
 * Quietly applying the liquid sheet to a gas line would check the wrong
 * components and report a clean result, so an unmatched service returns null
 * and the UI asks for a manual choice instead.
 *
 * A sheet that names no service is generic and covers the variable outright.
 */
export function matchHookupSheet(sheets: HookupSheet[], measuredVariable: string | null, service: string | null): HookupSheet | null {
  if (!measuredVariable) return null;
  const sameVariable = sheets.filter((s) => s.measuredVariable === measuredVariable);
  if (sameVariable.length === 0) return null;

  const wanted = service ? serviceSet(service) : new Set<string>();
  const candidates = sameVariable.filter((s) => {
    if (!s.service) return true; // a sheet naming no service covers the variable outright
    if (wanted.size === 0) return false;
    const covers = serviceSet(s.service);
    return [...wanted].some((w) => covers.has(w));
  });

  // A real set distinguishes more than service -- toxic vs non-toxic, slurry
  // vs non-choking, gauge vs transmitter -- and nothing in an ISO says which
  // applies. Several equally valid candidates is not a match to be guessed;
  // returning null asks the reviewer, which is the only correct answer.
  return candidates.length === 1 ? candidates[0] : null;
}

// A hook-up BOM says "NEEDLE VALVE TUBE END CONNECTIONS, 6000#" and the ISO
// says "NEEDLE VALVE TUBE END CONNECTION"; sizes are written "1/4\" OD" one
// side and "8" (mm) the other. Matching on the significant words plus DN is
// the strongest key both documents share.
function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9/\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "per", "type", "nos", "reqd", "std", "astm", "asme", "ansi", "iso", "nace", "mss",
  "sch", "gr", "wt", "note", "notes", "conn", "connections", "connection", "material", "mtrl",
]);

// Valve types that can serve as a process isolation (root) valve. A hook-up
// sheet names the FUNCTION -- "isolation valve (SBB or DBB)" -- and leaves
// the type to the piping standard, while the ISO names the TYPE it actually
// specified ("GATE VALVE 150#"). Neither document is going to use the
// other's wording, so function and type are reconciled here.
const ISOLATION_VALVE_TYPES = new Set(["gate", "ball", "globe", "plug", "needle", "butterfly"]);

function isIsolationValveRequirement(description: string): boolean {
  return /\bisolation\b|\broot\b|\bsbb\b|\bdbb\b|block\s*(and|&)\s*bleed/i.test(description) && /valve/i.test(description);
}

function itemMatchesIso(
  item: HookupItem,
  isoBom: Array<Record<string, unknown>>
): { matched: boolean; detail: string | null; category: string | null; size: string | null } {
  const wanted = significantWords(item.description);
  if (wanted.length === 0) return { matched: false, detail: null, category: null, size: null };
  // An indicative size is what the sheet's connection happens to be, not a
  // size it requires -- constraining on it would reject a correct match.
  const wantedDn = item.sizeIndicative ? null : normalizeNominalSize(item.size);
  // Compare by what each row IS, not by how it is worded, wherever both
  // sides classify. Word overlap alone reported the root valve missing on a
  // drawing that plainly carries one: "isolation valve (SBB or DBB) at
  // process connection" and "GATE VALVE 150#" share only the word "valve".
  const wantedCategory = classifyComponent(item.description);
  const wantsIsolationValve = isIsolationValveRequirement(item.description);

  let best: { detail: string; score: number; category: string | null; size: string | null } | null = null;
  for (const row of isoBom) {
    const text = `${row.component_type ?? ""} ${row.description ?? ""}`;
    const rowCategory = classifyComponent(text);
    const categoryMatch =
      (wantsIsolationValve && rowCategory != null && ISOLATION_VALVE_TYPES.has(rowCategory)) ||
      (wantedCategory != null && rowCategory === wantedCategory);

    const have = new Set(significantWords(text));
    const hits = wanted.filter((w) => have.has(w)).length;
    // Most of the naming has to line up -- one shared word ("valve") is not
    // a match, or every valve on the line would satisfy every hook-up row.
    const score = categoryMatch ? 1 : hits / wanted.length;
    if (!categoryMatch && (hits === 0 || score < 0.5)) continue;
    // Where both sides give a size it has to agree; an ISO row of the right
    // kind but the wrong bore is not the component the typical calls for.
    const rowDn = normalizeNominalSize(row.size, "mm");
    if (wantedDn != null && rowDn != null && wantedDn !== rowDn) continue;
    const detail = `${String(row.description ?? "").split(",")[0].trim()}${rowDn != null ? ` ${formatNominalSize(rowDn)}` : ""} x${row.quantity ?? 1}`;
    if (!best || score > best.score) best = { detail, score, category: rowCategory, size: rowDn != null ? formatNominalSize(rowDn) : null };
  }
  return best
    ? { matched: true, detail: best.detail, category: best.category, size: best.size }
    : { matched: false, detail: null, category: null, size: null };
}

/**
 * Checks one ISO against a project's hook-up typicals.
 *
 * `isoInstruments` are the ISO's own instrument entries (BOM rows such as
 * "INSTRUMENT FT-0003"); `isoBom` is the whole ISO bill of material, which is
 * where the hook-up components would appear if they are there at all.
 */
export function verifyHookup(
  sheets: HookupSheet[],
  isoInstruments: Array<{ tag: string; text: string }>,
  isoBom: Array<Record<string, unknown>>,
  lineService: string | null,
  overrides: Record<string, string> = {}
): HookupInstrumentCheck[] {
  const service = normalizeService(lineService);
  return isoInstruments.map(({ tag, text }) => {
    const label = classifyInstrument(`${text} ${tag}`);
    const measuredVariable = label ? label.split(" ")[0] : null;
    const overrideKey = overrides[tag];
    const overridden = Boolean(overrideKey && sheets.some((s) => s.key === overrideKey));
    const sheet = overridden ? (sheets.find((s) => s.key === overrideKey) ?? null) : matchHookupSheet(sheets, measuredVariable, service);

    const checks: HookupItemCheck[] = (sheet?.items ?? [])
      // Only the piping side is the ISO's to carry. "undetermined" rows are
      // shown but not counted against it -- an unplaced row is a gap in the
      // hook-up extraction, not evidence of a missing component.
      .filter((item) => item.discipline !== "instrument")
      .map((item) => {
        if (item.discipline !== "piping") return { item, status: "not checkable" as const, isoDetail: null, matchedAs: null, matchedSize: null };
        const { matched, detail, category, size } = itemMatchesIso(item, isoBom);
        // Only worth showing where the typical stated a function and the
        // ISO answered it with a type -- "isolation valve" -> "gate valve".
        const resolved = matched && category && classifyComponent(item.description) !== category ? category : null;
        return {
          item,
          status: matched ? ("present" as const) : ("missing" as const),
          isoDetail: detail,
          matchedAs: resolved,
          matchedSize: resolved ? size : null,
        };
      });

    return {
      instrumentTag: tag,
      instrumentLabel: label ?? "instrument",
      measuredVariable,
      service,
      sheet,
      overridden,
      checks,
      missingCount: checks.filter((c) => c.status === "missing").length,
    };
  });
}
