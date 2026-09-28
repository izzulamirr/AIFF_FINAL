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
   * True when the size comes from the connection the sheet DRAWS rather than
   * a dimension it prints in words -- the transmitter typicals show a 1/2"
   * NPT tapping connection while note 5 sends the valve's process end to the
   * piping standard. It is still checked: the instrument end has to accept
   * the sheet's own connector, and catching where the ISO specified another
   * bore is why this comparison exists. The flag only tells the reader where
   * the figure came from.
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
  status: "match" | "unmatched" | "not checkable";
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
  /** Why no typical was chosen, in words -- what the hook-up set does and does not hold. Null when one was. */
  noTypicalReason: string | null;
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

/**
 * The fluid PHASE named by a service description in words.
 *
 * A line number carries a service CODE, not a phase: "CRD" says nothing to a
 * hook-up set indexed by "liquid" and "gas". The P&ID legend is where the
 * code is defined -- its service-code table reads "CRD -- CRUDE OIL" -- so
 * the code is expanded there and the words are classified here, rather than
 * this file carrying a project-specific list of codes it cannot verify.
 *
 * Order matters: "ACID GAS" is a gas though it says acid, and "STEAM
 * CONDENSATE" is the condensate. The more specific phase is tested first.
 */
export function fluidPhaseOf(meaning: unknown): string | null {
  const t = String(meaning ?? "").toLowerCase();
  if (!t.trim()) return null;
  if (/condensate/.test(t)) return "liquid";
  if (/\bsteam\b/.test(t)) return "steam";
  if (/\bgas\b|vapou?r|\bair\b|nitrogen|\bflare\b|atmosphere|\bvent\b|\bco2\b|\bh2\b|hydrogen|oxygen|\blng\b|\blpg\b/.test(t)) return "gas";
  if (
    /water|\boil\b|crude|amine|caustic|solvent|\bacid\b|sludge|slop|diesel|glycol|methanol|brine|foam|\bsewer\b|\bdrain\b|chemical|sulphur|sulfur|chlorine|liquid|solution|reject|\bslurry\b/.test(t)
  )
    return "liquid";
  return null;
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
export function matchHookupSheet(
  sheets: HookupSheet[],
  measuredVariable: string | null,
  service: string | null,
  deviceType: string | null = null
): HookupSheet | null {
  if (!measuredVariable) return null;
  const sameVariable = sheets.filter((s) => s.measuredVariable === measuredVariable);
  if (sameVariable.length === 0) return null;

  // The variable alone is too coarse to pick a sheet. A real set holds
  // pressure GAUGES, pressure TRANSMITTERS and DIFFERENTIAL pressure
  // transmitters, and all of them answer to "pressure" -- so every pressure
  // instrument found several candidates and was handed back to the reviewer
  // as unmatched. The ISA tag already names the device: PT-0004 is a
  // pressure transmitter, not a gauge and not a differential one. Narrowing
  // on that first leaves service to do the job it is actually for.
  // Exact equality is deliberate -- "differential pressure transmitter" must
  // not satisfy a plain PT. Falls back to the whole variable when no sheet
  // names the device, so a set that titles its sheets differently still
  // behaves as before.
  const lower = (v: unknown) => String(v ?? "").trim().toLowerCase();
  const sameDevice = deviceType ? sameVariable.filter((s) => lower(s.instrumentType) === lower(deviceType)) : [];
  const pool = sameDevice.length > 0 ? sameDevice : sameVariable;

  const wanted = service ? serviceSet(service) : new Set<string>();
  const candidates = pool.filter((s) => {
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

/**
 * Says why no typical was picked, from what the set actually holds. "No typical covers X" alone
 * leaves the reader unable to tell a gap in the hook-up drawing from a fault on the ISO.
 */
export function noTypicalReasonOf(sheets: HookupSheet[], measuredVariable: string | null, service: string | null, label: string | null): string {
  const variables = [...new Set(sheets.map((s) => s.measuredVariable).filter((v): v is string => !!v))];
  const held = variables.length > 0 ? ` The hook-up set holds typicals for: ${variables.join(", ")}.` : "";
  if (!measuredVariable) return `The instrument could not be identified from its tag, so no typical could be chosen.${held}`;
  const sameVariable = sheets.filter((s) => s.measuredVariable === measuredVariable);
  if (sameVariable.length === 0) {
    return `The hook-up drawing has no ${measuredVariable} typical at all, so this is a gap in the hook-up set, not a fault on the ISO.${held}`;
  }
  const services = [...new Set(sameVariable.map((s) => s.service).filter((v): v is string => !!v))];
  const has = `${measuredVariable} typicals exist${services.length > 0 ? ` (${services.join("; ")})` : ""}`;
  const named = label ? ` for a ${label}` : "";
  return service
    ? `${has[0].toUpperCase()}${has.slice(1)}, but none${named} on ${service} service, or more than one fits and the ISO does not say which.`
    : `${has[0].toUpperCase()}${has.slice(1)}, but the line's service is not known, so none could be chosen.`;
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

function parseQty(value: unknown): number {
  const n = Number(String(value ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Which ISO BOM row holds the ROOT valve for each instrument on the line.
 *
 * Searching per instrument cannot answer this. Every isolation-type valve on
 * the line matches the words "isolation valve" equally well, so each search
 * returns the same row and one instrument gets told its root valve is
 * another's -- or, before the bore tie-break, that it was the 8" ball valve
 * in the process run. The tapping sizes are the discriminator, and no single
 * instrument's search can see them: the hook-up sheets all state the same
 * indicative connection, and the ISO BOM aggregates by size without saying
 * which tag each valve serves.
 *
 * So the line is solved once, as an allocation. Root valves are the
 * small-bore isolation valves, taken smallest first; an instrument's valves
 * are kept TOGETHER on one row wherever the row has room for all of them,
 * and the instruments needing the most are placed first. A device that taps
 * the line several times is a differential one -- an orifice flow meter --
 * and its taps are the smallest connections on the run, so it settles onto
 * the smallest bore while single-tap transmitters take the next size up.
 * On this project that puts FT-0003 on the DN15 pair and PT-0004 on a DN25,
 * which is what the ISO draws.
 */
function allocateRootValves(
  demands: Array<{ tag: string; count: number; dn: number | null }>,
  isoBom: Array<Record<string, unknown>>
): Map<string, { detail: string; category: string | null; size: string | null; sizeOk: boolean }> {
  const supply = isoBom
    .map((row) => {
      const category = classifyComponent(`${row.component_type ?? ""} ${row.description ?? ""}`);
      return { row, category, dn: normalizeNominalSize(row.size, "mm"), left: parseQty(row.quantity) };
    })
    .filter((c) => c.category != null && ISOLATION_VALVE_TYPES.has(c.category))
    .sort((a, b) => (a.dn ?? Infinity) - (b.dn ?? Infinity));

  const out = new Map<string, { detail: string; category: string | null; size: string | null; sizeOk: boolean }>();
  for (const demand of [...demands].sort((a, b) => b.count - a.count)) {
    // The bore the typical calls for is not negotiable: a root valve of the
    // wrong size is the discrepancy this check exists to find, so it is
    // never allocated as if it satisfied the requirement. Where the sheet
    // fixes no size, any isolation valve can serve.
    const pool = demand.dn == null ? supply : supply.filter((c) => c.dn === demand.dn);
    let fits = pool.find((c) => c.left >= demand.count) ?? pool.find((c) => c.left > 0);
    let sizeOk = true;
    if (!fits) {
      // Nothing of the required bore. Fall back to the valve the ISO really
      // did put on this instrument and report it as the failure -- naming
      // the wrong-size valve is what tells a reviewer WHAT to correct,
      // where an empty cell only says something is amiss.
      fits = supply.find((c) => c.left >= demand.count) ?? supply.find((c) => c.left > 0);
      sizeOk = false;
    }
    if (!fits) continue;
    const taken = Math.min(demand.count, fits.left);
    fits.left -= taken;
    out.set(demand.tag, {
      detail: `${String(fits.row.description ?? "").split(",")[0].trim()}${fits.dn != null ? ` ${formatNominalSize(fits.dn)}` : ""} x${taken}`,
      category: fits.category,
      size: fits.dn != null ? formatNominalSize(fits.dn) : null,
      sizeOk,
    });
  }
  return out;
}

function itemMatchesIso(
  item: HookupItem,
  isoBom: Array<Record<string, unknown>>
): { matched: boolean; detail: string | null; category: string | null; size: string | null } {
  const wanted = significantWords(item.description);
  if (wanted.length === 0) return { matched: false, detail: null, category: null, size: null };
  // Checking the SIZE is the point of this comparison, so any size the sheet
  // prints is a requirement -- including the tapping connection it shows for
  // the root valve. A row the sheet gives no usable size for ("line size at
  // the meter run", or nothing at all) parses to null and is settled by
  // presence alone.
  const wantedDn = normalizeNominalSize(item.size);
  // Compare by what each row IS, not by how it is worded, wherever both
  // sides classify. Word overlap alone reported the root valve missing on a
  // drawing that plainly carries one: "isolation valve (SBB or DBB) at
  // process connection" and "GATE VALVE 150#" share only the word "valve".
  const wantedCategory = classifyComponent(item.description);
  const wantsIsolationValve = isIsolationValveRequirement(item.description);

  type Candidate = { detail: string; score: number; category: string | null; size: string | null; dn: number | null };
  let best: Candidate | null = null;
  // The best row of the right KIND whose bore disagrees. Reported when
  // nothing passes, so the row shows what the ISO actually specified
  // instead of an empty cell.
  let wrongSize: Candidate | null = null;
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
    // Where the sheet FIXES a size, the size decides. An ISO row of the
    // right kind but the wrong bore is not the component the typical calls
    // for, and neither is one whose bore the ISO never states -- a size that
    // cannot be confirmed has not been met. Only a size the sheet does not
    // fix (see wantedDn) lets presence alone settle the row.
    const rowDn = normalizeNominalSize(row.size, "mm");
    const detail = `${String(row.description ?? "").split(",")[0].trim()}${rowDn != null ? ` ${formatNominalSize(rowDn)}` : ""} x${row.quantity ?? 1}`;
    if (wantedDn != null && rowDn !== wantedDn) {
      const closer =
        !wrongSize ||
        score > wrongSize.score ||
        (score === wrongSize.score && rowDn != null && (wrongSize.dn == null || Math.abs(rowDn - wantedDn) < Math.abs(wrongSize.dn - wantedDn)));
      if (closer) wrongSize = { detail, score, category: rowCategory, size: rowDn != null ? formatNominalSize(rowDn) : null, dn: rowDn };
      continue;
    }
    // Every isolation-type valve on the line ties on category, so without a
    // tie-break the first row won and a root valve was "found" as the 8"
    // ball valve in the process run. A root valve sits on an instrument
    // TAPPING -- the smallest connection there is -- so among equally good
    // candidates the smallest bore is the one the typical means.
    const better = !best || score > best.score || (score === best.score && rowDn != null && (best.dn == null || rowDn < best.dn));
    if (better) best = { detail, score, category: rowCategory, size: rowDn != null ? formatNominalSize(rowDn) : null, dn: rowDn };
  }
  if (best) return { matched: true, detail: best.detail, category: best.category, size: best.size };
  if (wrongSize) return { matched: false, detail: wrongSize.detail, category: wrongSize.category, size: wrongSize.size };
  return { matched: false, detail: null, category: null, size: null };
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
  lineService: string | null
): HookupInstrumentCheck[] {
  const service = normalizeService(lineService);

  // Resolve the sheet for every instrument BEFORE checking any of them: the
  // root valves have to be allocated across the whole line at once (see
  // allocateRootValves), which needs every instrument's requirement in hand.
  const resolved = isoInstruments.map(({ tag, text }) => {
    const label = classifyInstrument(`${text} ${tag}`);
    const measuredVariable = label ? label.split(" ")[0] : null;
    const sheet = matchHookupSheet(sheets, measuredVariable, service, label);
    return { tag, label, measuredVariable, sheet };
  });

  const rootValves = allocateRootValves(
    resolved.flatMap(({ tag, sheet }) => {
      const rows = (sheet?.items ?? []).filter((i) => i.discipline === "piping" && isIsolationValveRequirement(i.description));
      const count = rows.reduce((sum, i) => sum + parseQty(i.quantity), 0);
      const dn = rows.map((i) => normalizeNominalSize(i.size)).find((v) => v != null) ?? null;
      return count > 0 ? [{ tag, count, dn }] : [];
    }),
    isoBom
  );

  return resolved.map(({ tag, label, measuredVariable, sheet }) => {

    const checks: HookupItemCheck[] = (sheet?.items ?? [])
      // Only the piping side is the ISO's to carry. "undetermined" rows are
      // shown but not counted against it -- an unplaced row is a gap in the
      // hook-up extraction, not evidence of a missing component.
      .filter((item) => item.discipline !== "instrument")
      .map((item) => {
        if (item.discipline !== "piping") return { item, status: "not checkable" as const, isoDetail: null, matchedAs: null, matchedSize: null };
        // The root valve comes from the line-wide allocation, so this
        // instrument is shown ITS valve rather than whichever isolation
        // valve on the line happened to sort first.
        const isRootValve = isIsolationValveRequirement(item.description);
        const allocated = isRootValve ? rootValves.get(tag) : undefined;
        // For a root valve the allocation is the answer, including when it
        // found nothing. Falling back to a general search here would hand
        // this instrument a valve already allocated to another one, turning
        // a genuine size shortfall into a match.
        const { matched, detail, category, size } = isRootValve
          ? allocated
            ? { matched: allocated.sizeOk, detail: allocated.detail, category: allocated.category, size: allocated.size }
            : { matched: false, detail: null, category: null, size: null }
          : itemMatchesIso(item, isoBom);
        // Only worth showing where the typical stated a function and the
        // ISO answered it with a type -- "isolation valve" -> "gate valve".
        const named = matched && category && classifyComponent(item.description) !== category ? category : null;
        return {
          item,
          status: matched ? ("match" as const) : ("unmatched" as const),
          isoDetail: detail,
          matchedAs: named,
          matchedSize: named ? size : null,
        };
      });

    return {
      instrumentTag: tag,
      instrumentLabel: label ?? "instrument",
      measuredVariable,
      service,
      sheet,
      noTypicalReason: sheet ? null : noTypicalReasonOf(sheets, measuredVariable, service, label),
      checks,
      missingCount: checks.filter((c) => c.status === "unmatched").length,
    };
  });
}
