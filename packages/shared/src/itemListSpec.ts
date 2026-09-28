import { combineAdminText, type SheetItem } from "./sheetItems";
import { dnToNpsInches, formatNpsInches } from "./pipeSize";
import { parsePressureRating } from "./specBreak";

// Spec classes read straight off an admin item-list workbook, with no model call.
//
// An admin item list is already structured: every line names its class (Spec-of), its
// component type (GTYPE), its size (Size P1/P3) and carries the description and material
// text. Sending it to a model to "extract" pipes, fittings, flanges and valves only
// re-derives what the columns say, at the cost of several passes over the whole workbook.
// This groups the lines the same way and produces the same `spec_class` shape the
// client-spec extraction produces, so the document's Extracted tags and Piping classes
// look the same either way.
//
// The row labels are chosen to match what the web app's type matching looks for
// (see rowMatchesTypeHint / CATEGORY_BY_GTYPE in apps/web/src/lib/verifySpecCrossCheck.ts):
// "Elbow", "Tee (Straight)", "Reducer (Concentric/Eccentric)", "O'let (Weldolet)",
// "Flange (weld neck)", "Blind flange", "Spectacle blind", "Gasket", and a valve's own
// body type. Change one and the cross-check stops finding that component.

export type SpecCategoryKey = "pipes" | "fittings" | "flanges" | "valves";

export interface BuiltSpecClass {
  class_code: string;
  attributes: Record<string, unknown>;
}

interface Placement {
  category: SpecCategoryKey;
  /** The row's own type field: fitting_type, flange_type or valve_type. */
  field: "fitting_type" | "flange_type" | "valve_type" | null;
  label: string | null;
}

const text = (i: SheetItem) => `${i.description} ${i.material}`;

// The body type is the LEADING noun of the description. "CHECK VALVE, BALL LIFT TYPE" is a
// check valve whose mechanism is a ball lift, and both words are in the text, so the
// earliest one wins -- the same rule the web app's type matching uses.
function valveBody(lowerText: string): string {
  let best: { index: number; label: string } | null = null;
  for (const [word, label] of [["ball", "Ball"], ["gate", "Gate"], ["globe", "Globe"], ["check", "Check"], ["butterfly", "Butterfly"]] as const) {
    const index = lowerText.search(new RegExp(`\\b${word}\\b`));
    if (index !== -1 && (best === null || index < best.index)) best = { index, label };
  }
  return best ? best.label : "Valve";
}

function placementOf(item: SheetItem): Placement | null {
  const t = text(item).toLowerCase();
  switch (item.type.trim().toUpperCase()) {
    case "TUBE":
      return { category: "pipes", field: null, label: null };
    case "ELBO":
      return { category: "fittings", field: "fitting_type", label: "Elbow" };
    case "TEE":
      return { category: "fittings", field: "fitting_type", label: /reducing|reduced/.test(t) ? "Tee (Reduced)" : "Tee (Straight)" };
    case "REDU":
      return { category: "fittings", field: "fitting_type", label: "Reducer (Concentric/Eccentric)" };
    case "OLET":
      return { category: "fittings", field: "fitting_type", label: /sockolet|socket/.test(t) ? "O'let (Sockolet)" : "O'let (Weldolet)" };
    case "CAP":
      return { category: "fittings", field: "fitting_type", label: "Cap" };
    case "FLAN":
      return {
        category: "flanges",
        field: "flange_type",
        label: /orifice/.test(t) ? "Orifice Flanges" : /\bwn\b|weld\s*neck/.test(t) ? "Flange (weld neck)" : "Flange",
      };
    case "FBLI":
      return { category: "flanges", field: "flange_type", label: "Blind flange" };
    case "PCOM":
      return { category: "flanges", field: "flange_type", label: /spade|spacer/.test(t) ? "Spade & Spacer" : "Spectacle blind" };
    case "GASK":
      return { category: "flanges", field: "flange_type", label: "Gasket" };
    case "BOLT":
      return { category: "flanges", field: "flange_type", label: "Stud Bolt/Hvy-Hex Nuts" };
    case "VALV":
      return { category: "valves", field: "valve_type", label: valveBody(t) };
    default:
      // Supports, weld markers, tubing, instruments, bends: not part of a piping class.
      return null;
  }
}

const END_TYPE = /\b(BW|SW|SCRD|THRD|THD|LJ|SO|PE|BE|TE|FE)\b/i;
const SCHEDULE = /\bSCH(?:EDULE)?\.?\s?(\d+(?:\.\d+)?S?|XXS|XS|STD)(?:\s?[xX]\s?(?:SCH(?:EDULE)?\.?\s?)?(\d+(?:\.\d+)?S?|XXS|XS|STD))?\b/i;

function scheduleOf(t: string): string | null {
  const m = SCHEDULE.exec(t);
  if (!m) return null;
  return m[2] ? `${m[1].toUpperCase()} x ${m[2].toUpperCase()}` : m[1].toUpperCase();
}

function sizeLabel(dn: string): string | null {
  const inches = dnToNpsInches(dn);
  return inches == null ? null : formatNpsInches(inches);
}

/** "1 1/2" -> 1.5, for ordering only. */
function sizeOrder(label: unknown): number {
  if (typeof label !== "string") return Number.MAX_SAFE_INTEGER;
  const m = /^(?:(\d+)\s+)?(\d+)(?:\/(\d+))?$/.exec(label.trim());
  if (!m) return Number.MAX_SAFE_INTEGER;
  return m[1] != null ? Number(m[1]) + Number(m[2]) / Number(m[3] ?? 1) : m[3] != null ? Number(m[2]) / Number(m[3]) : Number(m[2]);
}

function rowOf(item: SheetItem, placement: Placement): Record<string, unknown> {
  const t = text(item);
  const size = sizeLabel(item.sizeP1);
  const branch = item.sizeP3.trim() ? sizeLabel(item.sizeP3) : null;
  const row: Record<string, unknown> = {};

  if (placement.field && placement.label) row[placement.field] = placement.label;
  if (size) {
    row.size_min = size;
    row.size_max = size;
  }
  if (branch) row.branch_size = branch;

  const end = END_TYPE.exec(t)?.[1]?.toUpperCase();
  if (end) row.end_type = end;

  const schedule = scheduleOf(t);
  if (schedule) row.schedule = schedule;

  if (placement.category === "flanges" || placement.category === "valves") {
    const rating = parsePressureRating(t);
    if (rating != null) row.class = String(rating);
  }
  if (placement.category === "valves" && item.catalogueRef.trim()) row.valve_index_code = item.catalogueRef.trim();

  // One text field: the workbook's description and material columns together, which is
  // how the web app shows an admin line everywhere else.
  row.description = combineAdminText(item);
  return row;
}

/**
 * Groups an item list's lines into one spec class per Spec-of code. Lines with no
 * Spec-of (a workbook that is one class per file) go under `fallbackClass`.
 *
 * Rows are one per distinct size / schedule / end / rating / wording, the way the
 * client-spec extraction expands a band into a row per printed size, so the web
 * app's adjacent-row merge behaves the same on both.
 */
export function buildSpecClassesFromItemList(items: SheetItem[], fallbackClass: string): BuiltSpecClass[] {
  const byClass = new Map<string, Record<SpecCategoryKey, Array<Record<string, unknown>>>>();
  const seen = new Set<string>();

  for (const item of items) {
    const placement = placementOf(item);
    if (!placement) continue;
    const code = (item.specCode.trim() || fallbackClass).toUpperCase();
    if (!code) continue;

    const row = rowOf(item, placement);
    const key = `${code}|${placement.category}|${JSON.stringify(row)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const groups = byClass.get(code) ?? { pipes: [], fittings: [], flanges: [], valves: [] };
    groups[placement.category].push(row);
    byClass.set(code, groups);
  }

  const typeKey = (r: Record<string, unknown>) => String(r.fitting_type ?? r.flange_type ?? r.valve_type ?? "");
  return [...byClass.entries()].map(([class_code, groups]) => {
    for (const rows of Object.values(groups)) {
      rows.sort((a, b) => typeKey(a).localeCompare(typeKey(b)) || sizeOrder(a.size_min) - sizeOrder(b.size_min));
    }
    return { class_code, attributes: { class_code, source: "item_list_workbook", ...groups } };
  });
}
