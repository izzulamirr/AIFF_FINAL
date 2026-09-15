import Anthropic from "@anthropic-ai/sdk";
import {
  LOCATE_ISO_SECTIONS_TOOL,
  ISO_SPOOL_BOUNDARIES_TOOL,
  ISO_SHEET_TOOL,
  buildSystemPrompt,
  buildNumberedText,
  sliceText,
  type PageRange,
} from "@easy/extraction-schemas";
import { enrichIsoLineAttrs, normalizeSlope, assignItemSpec, parsePressureRating, buildSpoolsFromWeldTopology, type WeldTopology } from "@easy/shared";
import { callTool, callWithRetry } from "./claudeClient";
import { renderPdfPages, renderPdfPageTiles } from "../pdfImages";
import { normalizeCellValue } from "./pll";
import type { DocTypeExtractor, TagDraft } from "./types";

interface LocateIsoResult {
  sheets: Array<{ drawing_number: string; sheet?: string; pages: PageRange }>;
}

interface IsoValve {
  item_no?: string;
  description?: string;
  size?: string;
  on_main_run?: boolean;
  flanged_both_sides?: boolean;
  pipe_continues_past?: boolean;
  is_boundary?: boolean;
  nearest_upstream_weld?: string;
  location_note?: string;
}

interface IsoBoundariesResult {
  line_size?: string;
  spool_tags?: Array<string | { spool_tag?: string }>;
  valves?: IsoValve[];
  field_welds?: Array<{ weld_no?: string; evidence?: string }>;
}

interface IsoSheetResult {
  document_number?: string;
  drawing_number?: string;
  line_number: string;
  size?: string;
  spec_class?: string;
  service?: string;
  from_location?: string;
  to_location?: string;
  slope?: string;
  scale?: string;
  sheet?: string;
  revision?: string;
  owner_pid_no?: string;
  pid_no?: string;
  owner_ga_dwg_no?: string;
  ga_dwg_no?: string;
  design_pressure?: string;
  design_temperature?: string;
  operating_pressure?: string;
  operating_temperature?: string;
  hydrotest_pressure?: string;
  hydrotest_temperature?: string;
  painting_system?: string;
  radiograph?: string;
  test_type?: string;
  insul_spec?: string;
  insul_thickness_mm?: string;
  spec_breaks?: Array<{ spec_class: string; location_note?: string; rating?: string }>;
  // The schema asks for plain tag strings; the object form is only here
  // because real runs have drifted to it -- see where this is unwrapped below.
  spool_tags?: Array<string | { spool_tag?: string }>;
  spool_boundaries?: Array<{ after_weld?: string; boundary_type?: string; evidence?: string }>;
  welds?: Array<{ weld_no: string; weld_type?: string; size?: string; nde_codes?: string; comes_after_weld?: string; closes_spool?: boolean }>;
  bom_items: Array<{
    item_no?: string;
    material_section?: string;
    description: string;
    component_type?: string;
    size?: string;
    quantity?: string;
    material?: string;
    item_code?: string;
    item_spec_class?: string;
    item_spec_basis?: string;
  }>;
}

const SYSTEM_PROMPT = buildSystemPrompt("piping isometric drawing");

function pageRangeToNumbers(range: PageRange): number[] {
  const numbers: number[] = [];
  for (let n = range.start; n <= range.end; n++) numbers.push(n);
  return numbers;
}

// A tool schema says "array", but the returned value is model-authored and a
// single-entry list comes back as a bare object often enough to matter: a
// real run died on "(result.spec_breaks ?? []).map is not a function" after
// all three sheets had already been extracted and paid for. `?? []` only
// guards null/undefined, so every list off the model goes through here.
function asArray<T>(value: T[] | T | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function normalizeKey(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

const missingLinkCount = (welds: IsoSheetResult["welds"]) =>
  asArray(welds).filter((w) => w.comes_after_weld == null || String(w.comes_after_weld).trim() === "").length;

type IsoWeld = NonNullable<IsoSheetResult["welds"]>[number];

// Which welds a spool ends at. spool_boundaries is the evidence-bearing answer
// (each entry names the valve or FW tick it was read from) and is checked
// against the sheet's own printed spool count, so it wins where it exists; the
// per-weld closes_spool flags are the fallback for a sheet that returned no
// boundary list at all. Either way a field weld is added: that one is not a
// judgement call, since a field weld IS the forced cut past 6000mm and so
// always closes the spool it ends, whatever the model said about it.
export function resolveBoundaryWelds(welds: IsoWeld[], boundaries: IsoSheetResult["spool_boundaries"]): Set<number> {
  const boundaryWelds = new Set<number>();
  for (const b of asArray(boundaries)) {
    const no = Number(String(b.after_weld ?? "").trim());
    if (Number.isFinite(no)) boundaryWelds.add(no);
  }
  if (boundaryWelds.size === 0) {
    for (const w of welds) if (w.closes_spool) boundaryWelds.add(Number(w.weld_no));
  }
  for (const w of welds) {
    if (normalizeKey(w.weld_type) === "FW") boundaryWelds.add(Number(w.weld_no));
  }
  return boundaryWelds;
}

// The size most of the sheet's welds are at IS the main run -- a branch is
// smaller-bore, and there are always fewer branch welds than run welds. Taken
// as the mode rather than from the title block so no inch/mm conversion is
// needed: the WELD LIST's own ND column is compared against itself.
function mainRunWeldSize(welds: IsoWeld[]): string | undefined {
  const counts = new Map<string, number>();
  for (const w of welds) {
    const size = normalizeKey(w.size);
    if (size) counts.set(size, (counts.get(size) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [size, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = size;
    }
  }
  return best;
}

export function buildWeldTopology(welds: IsoWeld[], boundaryWelds: Set<number>): WeldTopology[] {
  const weldByNo = new Map(welds.map((w) => [Number(w.weld_no), w]));
  const runSize = mainRunWeldSize(welds);
  return [...weldByNo.entries()].map(([weldNo, w]) => {
    const size = normalizeKey(w.size);
    return {
      weldNo,
      comesAfterWeld: w.comes_after_weld != null && String(w.comes_after_weld).trim() !== "" ? Number(w.comes_after_weld) : null,
      closesSpool: boundaryWelds.has(weldNo),
      // Left undefined where either size is unknown, so an unsized weld list
      // simply falls back to the subtree-size rule.
      onMainSize: runSize && size ? size === runSize : undefined,
    };
  });
}

// The sheet's own printed "PIPE SPOOLS" tags, tolerating the object shape real
// runs have drifted to ({spool_tag, ...}) instead of the declared strings.
export function readSpoolTags(spoolTags: IsoSheetResult["spool_tags"]): string[] {
  return asArray(spoolTags)
    .map((t) => (typeof t === "string" ? t : ((t as { spool_tag?: string } | null)?.spool_tag ?? undefined)))
    .map((t) => (t != null ? (normalizeCellValue(t) ?? t) : undefined))
    .filter((t): t is string => Boolean(t));
}

// Which of the valves pass 1 found actually break the sheet. The conjunction is
// applied here rather than taken from the model's own is_boundary: a real run
// returned both of a sheet's check valves as on_main_run + flanged_both_sides +
// pipe_continues_past and then said is_boundary false, contradicting its own
// three answers. The three observations are what it was asked to look at; the
// conclusion from them is arithmetic.
export function boundaryValvesOf(boundaries: IsoBoundariesResult): IsoValve[] {
  return asArray(boundaries.valves).filter((v) => {
    const observed = v.on_main_run != null || v.flanged_both_sides != null || v.pipe_continues_past != null;
    if (!observed) return Boolean(v.is_boundary); // nothing to recompute from
    return Boolean(v.on_main_run) && Boolean(v.flanged_both_sides) && v.pipe_continues_past !== false;
  });
}

// Pass 1's answer reduced to what the spool walk needs. Its weld numbers are
// only usable if every boundary got a distinct one: two spools cannot break at
// the same weld, so a repeat means the field was not really read. A real run
// returned weld 14 for all four of a sheet's ball valves.
export function locatedBoundariesOf(boundaries: IsoBoundariesResult): {
  located: NonNullable<IsoSheetResult["spool_boundaries"]>;
  weldNumbersUsable: boolean;
} {
  const valves = boundaryValvesOf(boundaries);
  const fieldWelds = asArray(boundaries.field_welds).filter((f) => String(f.weld_no ?? "").trim() !== "");

  const located = [
    ...valves
      .filter((v) => String(v.nearest_upstream_weld ?? "").trim() !== "")
      .map((v) => ({
        after_weld: String(v.nearest_upstream_weld).trim(),
        boundary_type: "valve",
        evidence: [v.item_no ? `PT NO ${v.item_no}` : "", v.size, v.description, v.location_note].filter(Boolean).join(", "),
      })),
    ...fieldWelds.map((f) => ({
      after_weld: String(f.weld_no).trim(),
      boundary_type: "field_weld",
      evidence: f.evidence ?? "hatched FW tick on the isometric",
    })),
  ];

  const weldNos = located.map((b) => b.after_weld);
  const everyBoundaryPlaced = located.length === valves.length + fieldWelds.length;
  const allDistinct = new Set(weldNos).size === weldNos.length;

  return { located, weldNumbersUsable: located.length > 0 && everyBoundaryPlaced && allDistinct };
}

export function buildIsoSheetPrompt(opts: {
  sheetText: string;
  drawingNumber?: string;
  sheetLabel?: string;
  pageNumber: number;
  tileCount: number;
  tileCols?: number;
  tileRows?: number;
  boundaryNote: string;
  retryNote: string;
}): string {
  return (

      `${opts.sheetText}\n\nThis is isometric drawing "${opts.drawingNumber ?? ""}"${opts.sheetLabel ? `, sheet ${opts.sheetLabel}` : ""} -- page ${opts.pageNumber} of the document. The attached images are THIS sheet only, so extract only what is printed on it. ` +
      `The FIRST image is the whole sheet -- use it for the title block, the materials table, and for tracing where the run goes. ` +
      (opts.tileCount
        ? `The REMAINING ${opts.tileCount} images are overlapping close-up tiles of that same sheet, in reading order (row 1 left to right, then row 2), each covering about a ${opts.tileCols ?? 3}x${opts.tileRows ?? 2} slice of it at far higher resolution. Small annotation detail -- weld diamonds, item balloons -- is only legible in the TILES, so read those from them and use the whole-sheet image only to work out what sits where. Adjacent tiles OVERLAP, so a mark appearing in two tiles is ONE mark; never count it twice. `
        : "") +
      `Read the title block and Bill of Material table directly from the image(s); the text above (if any) is often just a footer/watermark, not the real content. ` +
      `Extract the full title block (document number, drawing number, line number, size, spec, service, scale, sheet, revision, owner P&ID no., P&ID no., ` +
      `owner GA drawing no., GA drawing no., any slope annotation, design/operating/hydrotest pressure and temperature, painting system, radiograph, test type, insulation spec, insulation thickness) ` +
      `and Bill of Material rows via the record_iso_sheet tool call. ` +
      `For from_location/to_location: trace the drawn pipe run itself from one end to the other -- the start is the callout where the piping begins ` +
      `(equipment/nozzle connection, tie-in flag, or a "CONT'D FROM ..." continuation box) and the end is the callout where it terminates ` +
      `("CONT'D ON ...", equipment/nozzle, or tie-in). These callouts sit at the ends of the drawn pipeline, not in the title block. ` +
      `Read each unit from its column header and append it to the value (e.g. under a "PRESS. kPag" header the value 5 becomes "5 kPag"; under "TEMP. °C" the value 90 becomes "90 °C"; ` +
      `"INSUL/THK(MM)" of 25 becomes "25 mm"). Leave non-numeric placeholders such as NA, NIL. or AMB. exactly as printed. ` +
      `Where one field holds more than one value, join them with " / " -- never a line break.\n\n` +
      `SPEC BREAKS: check THIS sheet for "MATL <class>" callout boxes -- a pair of them printed either side of a joint ON THIS SHEET marks a material/spec break. A "CONT'D ON/FROM ..." reference to a different line number is NOT a break by itself, even when that line's number carries a different class suffix -- it is simply where this run continues onto a separate drawing (often for an unrelated line, e.g. after a size change or a tie-in), and tells you nothing about this sheet's own BOM. Only record spec_breaks when an actual "MATL" callout pair is drawn on this sheet; otherwise record only the title-block class. Record every class present under spec_breaks (including the title-block class) with its pressure class in rating. ` +
      `Then set item_spec_class on EVERY BOM row: a spec break is a point on the run, so each item sits on one definite side. ` +
      `Place un-rated rows (plain pipe, weldolets, butt-weld elbows/tees/reducers) by POSITION -- follow the row's item-number balloons to where they sit on the drawn run and decide whether that point is upstream or downstream of the "MATL" callouts. A repeated item code split across two rows is the giveaway that one row is each side (e.g. pipe 28.1M on the long upstream run vs pipe 1.5M on the short stub past the break; 7 elbows upstream vs 1 downstream) -- place each row by where its balloons actually are, and record item_spec_basis "position". ` +
      `Place rated rows AWAY FROM THE BREAK JOINT by their own rating (item_spec_basis "rating"): a "150# RF" flange, gasket, "150RF" bolt or 150# valve is the 150# class, a "300# RF" one or an alloy-overlay valve is the 300# class. ` +
      `RATING ONLY PLACES AN ITEM WHERE IT TELLS THE CLASSES APART. Two classes on one sheet often share a rating -- a sheet running AC03N, AC03U and BC70N has AC03N and AC03U BOTH at 150# and only BC70N at 300# -- so a "150# RF" ball valve is NOT evidence for AC03N over AC03U, and neither is a class whose rating the drawing never prints. Before using rating, check the ratings you recorded in spec_breaks: if the item's rating matches more than one class, or if any class on the sheet has no rating printed, rating decides NOTHING and you must place the item by POSITION instead. Getting this wrong is not a rounding error -- it files a valve under a class it is nowhere near. ` +
      `CRITICAL: rating does NOT identify the side AT the break joint, because that joint is rate-matched to the HIGHER class -- the mating flange on the lower-rated side, the joint gasket and its bolts are all made to the higher rating so they bolt together, yet the flange still BELONGS to the lower class because the break is at the joint face, after it. On a 150#/300# break a 300# flange sitting upstream of the MATL callout is a 150#-class item rate-matched up, NOT a 300#-class item. Place break-joint hardware by POSITION, basis "position (rate-matched to the higher class)". ` +
      `Never place by rating where the rating comes from the component's own standard either: ASME B16.36 orifice flanges and their gaskets start at 300#, so a 150# line's orifice assembly is 300# with no break involved -- place those by position. ` +
      `A sheet with no "MATL" callouts has no break on it: set item_spec_class to the title-block class for every row on that sheet, basis "sheet has no spec break".\n\n` +
      `WELDS: every weld is drawn as a small mark on the pipe, usually labelled with its WELD LIST ID number -- this sheet's own WELD LIST table (columns ID / ND / Type / Category) gives every weld's size and type by that ID. Record one entry per weld under welds, reading the number from the TILES and looking up its type/size in the table BY THAT ID -- never by assuming the table's row order matches physical position along the pipe (a branch takeoff can carry an ID numbered out of sequence with where it sits, and the table itself can be grouped by category rather than by the walk). Attach any NDE code boxes leadered to that weld (e.g. "F5 G9 B11", "FX GX BX", "X") as nde_codes. Sweep the run end to end rather than sampling -- a missed mark undercounts the sheet. ` +
      `For weld_type, cross-check the table against the mark itself: a genuine FIELD WELD carries its own distinct hatched "FW" tick at that weld's point on the isometric (sometimes drawn beside the weld's number label, not replacing it) -- if that hatched mark sits at a different weld than the table's row order would suggest, trust the mark on the drawing over the table.\n\n` +
      `SPOOLS: this sheet's own "PIPE SPOOLS" schedule (near the title block) lists this line's spool tags for the sheet -- read just that list of tags, in order, into spool_tags. If the sheet genuinely prints no such schedule, leave spool_tags empty; sequential tags get invented automatically from however many spools the welds below produce.\n` +
      `THAT LIST FIXES THE COUNT. N tags printed means the sheet is cut into exactly N spools, so there are exactly N-1 boundaries between them -- record those in spool_boundaries, one entry each, in order along the run.\n\n` +
      `FINDING THE BOUNDARIES -- LOOK, DO NOT DIVIDE. A boundary is only ever (a) a valve flanged on BOTH sides sitting on the MAIN RUN -- a bowtie/hourglass symbol with a heavy flange bar drawn either side of it and its own BOM item balloon -- or (b) a field weld, the forced cut once a welded run passes 6000mm, drawn as a hatched "FW" tick. Nothing else: not an elbow, not a reducer, not a branch takeoff, and not a valve at the dead end of a BRANCH (a branch stays inside whichever spool its takeoff belongs to). ` +
      `Go and locate each valve symbol and each hatched FW tick on the tiles FIRST, then read off which main-run weld sits immediately before it -- that weld's ID is after_weld. ` +
      `Do NOT space the boundaries evenly through the weld numbering, and do not assume each spool holds a similar number of welds: real spools are very uneven, one may hold a single weld and the next a dozen. An evenly spaced answer (every 4th weld, say) is the signature of guessing rather than reading, and is wrong. ` +
      `Cite what you actually saw in evidence -- the valve's BOM PT NO and description, or the weld ID carrying the FW tick and the dimension that forces the cut. If you cannot point at a specific drawn valve or FW tick, it is not a boundary.\n\n` +
      `DO NOT try to sort the sheet's welds into spool groups yourself -- that whole-sheet grouping is exactly the task that goes wrong: it collapses a dozen-plus welds into a handful of buckets in one shot and drifts, jumping welds out of sequence into the wrong spool. Instead, answer two small LOCAL questions for EACH weld, looking only at that one weld's own immediate neighbourhood on the drawing:\n` +
      `(1) comes_after_weld -- which weld sits immediately before THIS one along the pipe. Look at this weld's own mark and trace back one step to whatever weld or fitting comes right before it. Leave it blank ONLY for the very first weld on the sheet's run. Two different welds legitimately sharing the same comes_after_weld value is normal: that is exactly what a branch takeoff looks like -- the branch's first weld and the mainline's next weld both point back to the same shared weld.\n` +
      `(2) closes_spool -- the same fact you recorded in spool_boundaries, marked against the weld itself: true for exactly the welds you listed as after_weld there, false everywhere else. If the two disagree, go back to the drawing and settle it rather than leaving them inconsistent. ` +
      `Getting comes_after_weld and closes_spool right for each weld, one at a time, is what actually produces correct spools -- the grouping itself is computed afterward from your answers, so do not also try to pre-group welds or invent spool_no/spool_tag values on individual welds.\n\n` +
      `MATERIALS BLOCKS: a fabrication-issued sheet prints TWO materials tables -- FABRICATION MATERIALS (pipe, fittings, flanges, valves) and ERECTION MATERIALS (gaskets, bolts, spectacle blinds, instruments). Each restarts its own PT NO sequence, so the same PT NO can appear in both and they are different items; record the rows of BOTH and set material_section on every row. ` +
      `Rows added by a revision are printed WITHOUT a PT NO and WITHOUT an ITEM CODE, appended under the category they belong to and often in a different colour -- an extra PIPE row, an extra 150# blind flange, a small-bore gate valve, extra stud bolts. These are real material: record them with item_no and item_code left blank, taking description, size and quantity exactly as printed. Do not skip a row because it has no number, and do not renumber the table. ` +
      `Do NOT record a sheet's "PIPE SPOOLS" list as BOM rows -- that list belongs in spool_tags instead.` +
    opts.boundaryNote +
    opts.retryNote
  );
}

// How pass 1's answer is handed to pass 2. What pass 1 is good at is saying
// WHICH valves break the sheet; tying each to a weld number is a different job,
// done against the weld list that pass 2 is reading anyway. So the valves go
// across by name and location, and pass 1's own weld numbers only as a hint,
// and only when they survived locatedBoundariesOf's checks.
export function buildBoundaryNote(
  boundaries: IsoBoundariesResult,
  located: NonNullable<IsoSheetResult["spool_boundaries"]>,
  weldNumbersUsable: boolean
): string {
  const valves = boundaryValvesOf(boundaries);
  const fieldWelds = asArray(boundaries.field_welds);
  if (valves.length + fieldWelds.length === 0) return "";

  const spoolCount = readSpoolTags(boundaries.spool_tags).length;
  const expected = spoolCount > 0 ? spoolCount - 1 : null;
  const found = valves.length + fieldWelds.length;

  return (
    `\n\nSPOOL BOUNDARIES ON THIS SHEET, from a pass that did nothing but look for them` +
    (spoolCount > 0 ? `. Its PIPE SPOOLS schedule lists ${spoolCount} spools, so there are ${expected} cuts` : "") +
    `:\n` +
    valves
      .map((v, i) => `  ${i + 1}. VALVE -- ${[v.item_no ? `PT NO ${v.item_no}` : "", v.size, v.description].filter(Boolean).join(", ")}\n       ${v.location_note ?? ""}`)
      .join("\n") +
    (fieldWelds.length ? `\n` + fieldWelds.map((f) => `  - FIELD WELD at weld ${f.weld_no} -- ${f.evidence ?? ""}`).join("\n") : "") +
    `\n\nYOUR JOB is to say where each one falls in the weld numbering: record one spool_boundaries entry per item above, and set closes_spool true on exactly those welds.\n` +
    `HOW TO PICK after_weld. A flanged valve is drawn as: pipe -- WELD -- flange -- VALVE -- flange -- WELD -- pipe. That first weld, the one joining the pipe to the valve's UPSTREAM flange, is the last weld of the spool that ends here, and it is the one you record. ` +
    `Walk the main run toward the valve and take the VERY LAST weld mark you pass before reaching it -- not the one before that. Getting this off by one puts the whole spool boundary in the wrong place, and it is the single most common way this goes wrong. ` +
    `The same applies past the valve: the weld on its downstream flange is the FIRST weld of the next spool, so it is never an after_weld.\n` +
    `If a branch takes off just before one of these valves and dead-ends, give the MAIN RUN's weld -- not the branch's. Two boundaries can never share the same after_weld: each cut is at a different place on the run. ` +
    (expected != null && found < expected
      ? `\n\nNOTE: that locating pass found only ${found} of the ${expected} cuts this sheet must have. Place the ${found} above, then find the missing ${expected - found} yourself -- look for a both-sides-flanged valve on the main run that it missed, or a hatched FW tick. A likely miss is a valve in a REDUCED section of the main run: where the run steps down through a reducer, the valve there is smaller than the line size but still on the main run, not on a branch.`
      : expected != null && found > expected
        ? `\n\nNOTE: that locating pass gave ${found} cuts but this sheet has ${expected}. One of the items above is not really a boundary -- most likely a valve on a branch, or one with nothing continuing past it. Drop it.`
        : "") +
    (weldNumbersUsable
      ? `\n\nThe locating pass read these weld numbers for them, as a starting point to check rather than copy: ${located.map((b) => `${b.after_weld} (${b.boundary_type})`).join(", ")}.`
      : "")
  );
}

// Pass 1's prompt. Exported so it can be run on its own against a single sheet
// (scripts/probe-boundaries.ts) -- the boundary pass is the part whose accuracy
// is worth measuring by itself, and doing so costs a fraction of a full sheet
// extraction.
export function buildSpoolBoundaryPrompt(opts: {
  drawingNumber?: string;
  sheetLabel?: string;
  pageNumber: number;
  imageNote: string;
}): string {
  return (
    `This is isometric drawing "${opts.drawingNumber ?? "(unnamed)"}"${opts.sheetLabel ? `, sheet ${opts.sheetLabel}` : ""} -- page ${opts.pageNumber} of the document. The attached images are THIS sheet only. ${opts.imageNote}\n\n` +
    `YOUR ONLY JOB HERE is to find where this sheet's pipe spools break. Ignore the title block, the materials table and the weld list except where they help you answer that.\n\n` +
    `A spool is one shop-welded assembly: welded up in the shop, trucked to site, bolted into place. So it can only end in two places.\n` +
    `(1) AT A VALVE that is flanged on both sides and sits on the MAIN RUN -- the bolted joints either side are what let the pipe come apart there. Drawn as a bowtie/hourglass symbol with a heavy flange bar each side, an item balloon leadered to it, and usually an operator (handwheel, lever, a "VALVE_WRENCH" callout) alongside.\n` +
    `(2) AT A FIELD WELD -- the forced cut once a continuous welded run passes the ~6000mm that fits on a truck. Drawn as a hatched "FW" tick at that weld's own point.\n` +
    `Nothing else breaks a spool. Not an elbow, not a reducer, not a branch takeoff, and NOT a valve on a branch: a branch (a smaller-bore drain, vent or instrument tap that leaves the run and dead-ends at its own blind flange) stays inside whichever spool its takeoff belongs to, however far it runs and whatever is on it.\n\n` +
    `Work in this order:\n` +
    `1. Read line_size from the title block / line number -- the main run's own size. Everything below depends on it.\n` +
    `2. Read the "PIPE SPOOLS" schedule near the title block into spool_tags. N tags means this sheet is cut into N spools, so you are looking for exactly N-1 boundaries. Use that as your check at the end, not as a way to place them.\n` +
    `3. Sweep the WHOLE drawing on the tiles and list EVERY valve you can see in valves -- main run and branches alike. Cross-check the count against the BOM's valve rows before you answer: if the BOM shows four 200mm ball valves and you found three, you have missed one, so go back and find it. Listing a valve and marking it not-a-boundary is right and expected; missing one is not.\n` +
    `4. For each valve answer the three local questions -- is it on the main run (at line_size, not a smaller branch), is it flanged on both sides, does the run carry on past it -- and set is_boundary true only when all three are true. A valve at the very end of the run has nothing after it, so it is not a boundary.\n` +
    `5. Give nearest_upstream_weld for each valve by reading the weld label printed at the mark just before it ("BW12" gives "12"). This is what ties your answer to the weld list.\n` +
    `6. List every hatched FW tick in field_welds, read off the DRAWING -- the weld list table is often grouped by category, so its row order does not tell you which weld is the field weld.\n\n` +
    `Do not place boundaries by spacing them through the weld numbering. Spools are very uneven -- one may hold a single weld and the next a dozen. If you cannot point at a drawn valve or FW tick, it is not a boundary.`
  );
}

export function buildSheetImageNote(tileCount: number, cols = 3, rows = 2): string {
  return (
    `The FIRST image is the whole sheet -- use it to see where the run goes and what sits where. ` +
    (tileCount
      ? `The REMAINING ${tileCount} images are overlapping close-up tiles of that same sheet, in reading order (row 1 left to right, then row 2), each covering about a ${cols}x${rows} slice of it at far higher resolution. Small annotation detail -- weld marks, item balloons, the flanges either side of a valve -- is only legible in the TILES. Adjacent tiles OVERLAP, so a symbol appearing in two tiles is ONE symbol; never count it twice. `
      : "")
  );
}

// What a correct spool read of a sheet has to satisfy, checked against what
// that same sheet prints -- so a bad read is caught from the drawing's own
// evidence rather than from a fixed expectation about any one drawing.
// Exported so it can be run over stored payloads offline (see
// scripts/replay-spools.ts) without paying for a vision call.
//
// Each problem is phrased as the complaint the retry quotes back, so a retry
// always names the specific defect rather than asking again in general terms.
export function spoolProblems(r: IsoSheetResult): string[] {
  const problems: string[] = [];
  const welds = asArray(r.welds);
  if (welds.length === 0) return problems;

  // Every weld except the sheet's true first one should carry a
  // comes_after_weld pointer -- that is what buildSpoolsFromWeldTopology needs
  // to place it in a spool at all. More than one weld missing it means welds
  // that would fall out of every spool.
  const missing = missingLinkCount(r.welds);
  if (missing > 1) {
    problems.push(
      `you recorded ${welds.length} welds but left comes_after_weld blank on ${missing} of them -- only the sheet's very first weld should ever be blank there. Go weld by weld and trace back one step to whatever comes immediately before each one, even on branches.`
    );
  }

  const weldNos = new Set(welds.map((w) => Number(w.weld_no)).filter(Number.isFinite));
  const boundaries = asArray(r.spool_boundaries);
  const boundaryNos = boundaries.map((b) => Number(String(b.after_weld ?? "").trim())).filter(Number.isFinite);
  const tagCount = asArray(r.spool_tags).length;

  // The PIPE SPOOLS schedule is printed on the sheet, so the number of cuts is
  // not a judgement call: N spools are separated by N-1 boundaries.
  if (tagCount > 0 && boundaries.length !== tagCount - 1) {
    problems.push(
      `you read ${tagCount} spool tags from the PIPE SPOOLS schedule, which means the sheet is cut into ${tagCount} spools and there must be exactly ${tagCount - 1} boundaries -- but you gave ${boundaries.length}. Find every both-sides-flanged valve on the main run and every hatched FW tick, and record one boundary per cut.`
    );
  }

  const unknown = boundaryNos.filter((no) => !weldNos.has(no));
  if (unknown.length > 0) {
    problems.push(`spool_boundaries points at weld ${unknown.join(", ")}, which is not in the weld list you recorded for this sheet.`);
  }

  // Two spools cannot break at the same weld. A repeat means the weld number
  // was not actually read off the drawing for each one -- a real run put all
  // four of a sheet's ball valves at weld 14.
  const repeated = [...new Set(boundaryNos.filter((no, i) => boundaryNos.indexOf(no) !== i))];
  if (repeated.length > 0) {
    problems.push(
      `more than one boundary is recorded at weld ${repeated.join(", ")}. Each cut is at a different place on the run, so no two can share an after_weld -- go back to each valve in turn and read the weld label printed at the mark just before it.`
    );
  }

  // A field weld IS a forced cut, so one that closes nothing means either the
  // weld type or the boundary list is misread.
  const uncoveredFw = welds
    .filter((w) => normalizeKey(w.weld_type) === "FW")
    .map((w) => Number(w.weld_no))
    .filter((no) => Number.isFinite(no) && !boundaryNos.includes(no));
  if (uncoveredFw.length > 0) {
    problems.push(
      `weld ${uncoveredFw.join(", ")} is typed FW (field weld) but is not in spool_boundaries. A field weld is itself the forced cut past 6000mm, so it always ends the spool it closes -- either it is a boundary, or it is not really a field weld and its type is wrong.`
    );
  }

  // A boundary is only a boundary because something is drawn there, so an
  // entry that cannot name what it saw is an inferred one.
  const vague = boundaries.filter((b) => normalizeKey(b.boundary_type) === "VALVE" && !/valve/i.test(String(b.evidence ?? "")));
  if (vague.length > 0) {
    problems.push(
      `${vague.length} of your boundaries are typed "valve" but their evidence does not name a valve (${vague.map((b) => `after weld ${b.after_weld}`).join(", ")}). Give the valve's BOM PT NO and description for each, e.g. "PT NO 7, 200mm BALL VALVE, flanged both sides, between welds 14 and 15" -- if you cannot name the valve you are looking at, you have not found the boundary.`
    );
  }

  // Evenly spaced boundaries are the signature of dividing the weld numbering
  // up rather than finding the valves: real spools are uneven. Judged over
  // VALVE boundaries only -- field welds are forced cuts at a fixed run
  // length, so several of them falling at a regular spacing is exactly what
  // the rule that places them would produce, and is not evidence of guessing.
  const valveBoundaryNos = boundaries
    .filter((b) => normalizeKey(b.boundary_type) !== "FIELD_WELD")
    .map((b) => Number(String(b.after_weld ?? "").trim()))
    .filter(Number.isFinite);
  if (valveBoundaryNos.length >= 3) {
    const sorted = [...valveBoundaryNos].sort((a, b) => a - b);
    const gaps = sorted.slice(1).map((no, i) => no - sorted[i]);
    if (gaps.every((g) => g === gaps[0]) && gaps[0] > 1) {
      problems.push(
        `your boundaries are at welds ${sorted.join(", ")} -- exactly ${gaps[0]} apart every time. That even spacing is what dividing the weld numbering looks like, not what reading the drawing looks like; real spools are uneven. Go back to the tiles, find each valve symbol (bowtie with a flange bar either side) and each hatched FW tick by eye, and read off the main-run weld immediately before each one.`
      );
    }
  }

  return problems;
}

// Keeps the FIRST occurrence, so a weld read from a tile that also carries
// its NDE codes is not replaced by a barer duplicate from the next tile.
function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    const k = key(row);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}

// Isometric drawings are graphics-heavy CAD exports -- the title block,
// line callouts, and BOM table are usually vector art with little or no
// real text layer (confirmed on a real upload: plain text extraction
// yielded only a footer watermark, nothing else). Page images are sent to
// Claude alongside whatever text does exist, rather than relying on text
// extraction alone like the other document types.
export const extractIsoDocument: DocTypeExtractor = async (pages, apiKey, onProgress, pdfBuffer) => {
  const client = new Anthropic({ apiKey });
  const pageList = pages.map((p) => ({ pageNumber: p.pageNumber, pageText: p.pageText }));
  const fullText = buildNumberedText(pageList);

  const allPageNumbers = pages.map((p) => p.pageNumber);
  const renderedPages = pdfBuffer ? await renderPdfPages(pdfBuffer, allPageNumbers) : [];
  const imageByPage = new Map(renderedPages.map((r) => [r.pageNumber, r.pngBase64]));
  // Weld marks are ~10 px diamonds on a whole A1 sheet once the API has
  // downsampled it to 1568 px on the long edge, which is far too small to
  // read "SW" over "01" out of -- item-number balloons are just as small.
  // Same problem, and same fix, as the P&ID's valve symbols: send
  // overlapping close-up tiles alongside the full sheet so small annotation
  // arrives at a legible size. See pdfImages.ts.
  const renderedTiles = pdfBuffer ? await renderPdfPageTiles(pdfBuffer, allPageNumbers) : [];
  const tilesByPage = new Map<number, typeof renderedTiles>();
  for (const tile of renderedTiles) {
    const list = tilesByPage.get(tile.pageNumber) ?? [];
    list.push(tile);
    tilesByPage.set(tile.pageNumber, list);
  }

  const locate = await callWithRetry(() =>
    callTool<LocateIsoResult>(client, {
      tool: LOCATE_ISO_SECTIONS_TOOL,
      systemPrompt: SYSTEM_PROMPT,
      userText:
        `${fullText}\n\nThe attached page image(s) are the actual drawing content -- use them as the primary source, the text above (if any) is often just a footer/watermark. ` +
        `Identify every isometric SHEET via the locate_iso_sheets tool call: one entry per sheet, each with its own single-page range. ` +
        `Sheets of a multi-sheet drawing repeat the same drawing number and differ only by the title block's "SHEET n OF m" -- read that field on each page and return a separate entry per page, never one entry spanning them.`,
      maxTokens: 8000,
      useThinking: true,
      images: renderedPages.map((r) => r.pngBase64),
    })
  );

  if (!locate.sheets || locate.sheets.length === 0) {
    throw new Error("locate_iso_sheets found no drawings in this document.");
  }

  // Guard: sheets of a multi-sheet drawing share one drawing number and
  // differ only by "SHEET n OF m", so locate can collapse them into a single
  // multi-page entry -- which then extracts only the first sheet's BOM and
  // silently loses the rest (seen on a real 3-sheet drawing: 11 of 45 rows).
  // Any entry spanning several pages is split into one entry per page, so
  // every sheet is always read on its own.
  const locatedSheets = locate.sheets.flatMap((sheet) => {
    const numbers = pageRangeToNumbers(sheet.pages).filter((n) => imageByPage.has(n) || pageList.some((p) => p.pageNumber === n));
    if (numbers.length <= 1) return [sheet];
    return numbers.map((n) => ({ ...sheet, pages: { start: n, end: n } as PageRange }));
  });
  onProgress?.({ phase: "locate", current: 1, total: 1 });

  const allSheets: Array<{ drawing_number: string; pageNumber: number; result: IsoSheetResult }> = [];
  for (let i = 0; i < locatedSheets.length; i++) {
    const sheet = locatedSheets[i];
    const sheetText = sliceText(pageList, sheet.pages);
    const sheetImages = pageRangeToNumbers(sheet.pages)
      .map((n) => imageByPage.get(n))
      .filter((img): img is string => Boolean(img));
    const sheetTiles = pageRangeToNumbers(sheet.pages).flatMap((n) => tilesByPage.get(n) ?? []);

    const imageNote = buildSheetImageNote(sheetTiles.length, sheetTiles[0]?.cols, sheetTiles[0]?.rows);
    const sheetImageSet = [...sheetImages, ...sheetTiles.map((t) => t.pngBase64)];

    // PASS 1 -- where the spools break, asked on its own before anything else.
    // Finding the valves is a sweep of the drawing; it does not survive being
    // one field among forty of a full sheet extraction, which is how a busy
    // sheet ended up cut at evenly spaced weld numbers instead of at its
    // valves. Nothing else is asked for here.
    const boundaries = await callWithRetry(() =>
      callTool<IsoBoundariesResult>(client, {
        tool: ISO_SPOOL_BOUNDARIES_TOOL,
        systemPrompt: SYSTEM_PROMPT,
        userText: buildSpoolBoundaryPrompt({
          drawingNumber: sheet.drawing_number,
          sheetLabel: sheet.sheet,
          pageNumber: sheet.pages.start,
          imageNote,
        }),
        maxTokens: 16000,
        useThinking: true,
        images: sheetImageSet,
      })
    );

    const boundaryValves = boundaryValvesOf(boundaries);
    const { located: locatedBoundaries, weldNumbersUsable } = locatedBoundariesOf(boundaries);

    // What pass 1 is good at is saying WHICH valves break the sheet; tying each
    // to a weld number is a different job, done against the weld list that pass
    // 2 is reading anyway. So pass 2 is always given the valves by name and
    // asked to place them -- and pass 1's own weld numbers are passed on only
    // when they survive `locatedBoundariesOf`'s checks.
    const boundaryNote = buildBoundaryNote(boundaries, locatedBoundaries, weldNumbersUsable);

    const buildUserText = (retryNote: string) =>
      buildIsoSheetPrompt({
        sheetText,
        drawingNumber: sheet.drawing_number,
        sheetLabel: sheet.sheet,
        pageNumber: sheet.pages.start,
        tileCount: sheetTiles.length,
        tileCols: sheetTiles[0]?.cols,
        tileRows: sheetTiles[0]?.rows,
        boundaryNote,
        retryNote,
      });

    const sheetRead = await callWithRetry(() =>
      callTool<IsoSheetResult>(client, {
        tool: ISO_SHEET_TOOL,
        systemPrompt: SYSTEM_PROMPT,
        userText: buildUserText(""),
        maxTokens: 32000,
        useThinking: true,
        images: sheetImageSet,
      })
    );

    // Pass 1 looked for the boundaries and nothing else, so its answer stands
    // over whatever the sheet pass reported alongside forty other fields --
    // but only where it actually found any. Same for the printed spool tags,
    // which both passes read.
    const result: IsoSheetResult = {
      ...sheetRead,
      // Pass 1 places the cuts only where it placed every one of them at a
      // distinct weld; otherwise pass 2's placement stands, since pass 2 was
      // told which valves to place and read the weld list to do it.
      spool_boundaries: weldNumbersUsable ? locatedBoundaries : sheetRead.spool_boundaries,
      spool_tags: readSpoolTags(sheetRead.spool_tags).length > 0 ? sheetRead.spool_tags : boundaries.spool_tags,
    };

    // Retry the sheet once when its own printed schedule contradicts the read.
    // Welds are re-taken from the retry as a set (never merged with the first
    // attempt's), since comes_after_weld and after_weld only mean anything
    // against the same weld IDs they were read against.
    let finalResult = result;
    const problems = spoolProblems(result);
    if (problems.length > 0) {
      // The sheet's own BOM already says which valves exist on it. Quoting
      // those rows back turns "find the valves" into "find these specific
      // valves", and the line size separates main-run valves (a boundary
      // each, where flanged both sides) from small-bore branch ones (never).
      const valveRows = asArray(result.bom_items).filter((i) => /valve/i.test(`${i.description ?? ""} ${i.component_type ?? ""}`));
      const valveNote = valveRows.length
        ? `\n\nThe BOM you just read from this sheet lists these valves${result.size ? ` (the line itself is ${result.size})` : ""}:\n` +
          valveRows.map((v) => `  - ${v.quantity ? `${v.quantity}x ` : ""}${v.size ?? "?"} ${v.description ?? ""}${v.item_no ? ` (PT NO ${v.item_no})` : ""}`).join("\n") +
          `\nEvery one of these is drawn somewhere on this sheet. The ones at the LINE's own size sit on the main run -- each of those, where it is flanged on both sides and has pipe continuing past it, is a boundary. Smaller ones are branch/small-bore valves and are not.`
        : "";

      const retryResult = await callWithRetry(() =>
        callTool<IsoSheetResult>(client, {
          tool: ISO_SHEET_TOOL,
          systemPrompt: SYSTEM_PROMPT,
          userText: buildUserText(
            `\n\nRETRY -- READ CAREFULLY. Your previous attempt on this exact sheet has ${problems.length === 1 ? "a problem" : `${problems.length} problems`} that the sheet itself contradicts:\n` +
              problems.map((p, i) => `(${i + 1}) ${p}`).join("\n") +
              valveNote +
              `\n\nRe-read the drawing and fix these. Work from the valve symbols and FW ticks you can actually see on the tiles -- name each one in evidence -- rather than inferring boundaries from the weld numbering.`
          ),
          maxTokens: 32000,
          useThinking: true,
          images: sheetImageSet,
        })
      );
      // Judge the retry as it would actually be used -- pass 1's boundaries
      // still standing over it -- and keep it only if it is a cleaner read.
      const retryCandidate: IsoSheetResult = {
        ...result,
        spool_tags: readSpoolTags(retryResult.spool_tags).length > 0 ? retryResult.spool_tags : result.spool_tags,
        spool_boundaries: weldNumbersUsable ? locatedBoundaries : retryResult.spool_boundaries,
        welds: retryResult.welds,
      };
      if (spoolProblems(retryCandidate).length < problems.length) finalResult = retryCandidate;
    }

    allSheets.push({ drawing_number: sheet.drawing_number, pageNumber: sheet.pages.start, result: finalResult });
    onProgress?.({ phase: "sheet", current: i + 1, total: locatedSheets.length, detail: `${sheet.drawing_number}${sheet.sheet ? ` sheet ${sheet.sheet}` : ""}` });
  }

  const tags: TagDraft[] = [];
  const n = normalizeCellValue; // collapse any embedded newlines to " / "
  for (const { drawing_number, pageNumber, result } of allSheets) {
    // Classes present on this sheet, with their pressure class where known --
    // the basis for placing each BOM item when the drawing has a spec break.
    const specsWithRatings = asArray(result.spec_breaks).map((b) => ({
      spec_class: b.spec_class,
      location_note: b.location_note,
      rating: parsePressureRating(b.rating) ?? (b.rating ? Number(String(b.rating).replace(/\D/g, "")) || null : null),
    }));

    const welds = dedupeBy(asArray(result.welds), (w) => `${normalizeKey(w.weld_type)}|${normalizeKey(w.weld_no)}`);

    // Spool boundaries are computed purely from each weld's own local
    // answers (comes_after_weld, closes_spool) -- see
    // buildSpoolsFromWeldTopology in @easy/shared. The model is never asked
    // to group a whole sheet's welds into spools directly (that consistently
    // produced wrong, out-of-sequence groupings); it answers a small local
    // question per weld while looking at just that weld's neighbourhood, and
    // the walk here assembles those answers into spools, mapped onto the
    // sheet's own printed "PIPE SPOOLS" tags (spool_tags) in order.
    const weldByNo = new Map(welds.map((w) => [Number(w.weld_no), w]));
    const boundaryWelds = resolveBoundaryWelds(welds, result.spool_boundaries);
    const weldTopology = buildWeldTopology(welds, boundaryWelds);
    const spoolTags = readSpoolTags(result.spool_tags);
    const { spools: resolvedSpools, weldToSpoolTag } = buildSpoolsFromWeldTopology(weldTopology, spoolTags);

    // Deterministic, not asked of the model: a spool's closing weld tells a
    // reviewer why it ends there without needing separate free-text from a
    // second pass -- a field weld is always the forced 6000mm cut, anything
    // else closing a spool is a valve.
    function closingNote(spool: (typeof resolvedSpools)[number], isLastSpool: boolean): string | undefined {
      const lastWeldNo = spool.weldNumbers[spool.weldNumbers.length - 1];
      const lastWeld = lastWeldNo != null ? weldByNo.get(lastWeldNo) : undefined;
      if (!lastWeld) return undefined;
      if (normalizeKey(lastWeld.weld_type) === "FW") return `forced 6000mm cut, closes at field weld FW-${lastWeld.weld_no}`;
      if (boundaryWelds.has(Number(lastWeld.weld_no))) {
        // The model's own evidence for this boundary, where it gave any --
        // what a reviewer needs to check the cut without reopening the sheet.
        const evidence = asArray(result.spool_boundaries).find((b) => Number(String(b.after_weld ?? "").trim()) === Number(lastWeld.weld_no))?.evidence;
        return evidence ? `ends at a valve after weld ${lastWeld.weld_no} (${n(evidence) ?? evidence})` : `ends at a valve after weld ${lastWeld.weld_no}`;
      }
      return isLastSpool ? "runs to the end of the sheet" : undefined;
    }

    if (result.line_number) {
      const lineNumber = n(result.line_number) ?? result.line_number;
      tags.push({
        tagType: "line",
        tagNumber: lineNumber,
        // The sheet this row was read from -- a multi-sheet drawing's BOM is
        // per sheet, and a spec break can apply to one sheet only, so the
        // page is what ties a row to its sheet (see the BOM-by-spec view).
        sourcePage: pageNumber,
        // enrichIsoLineAttrs decodes the line-number convention
        // (size-service-class-unique-insulation-heattrace) and fills any
        // field the title block left blank or as an "XX.XX" placeholder.
        attributes: enrichIsoLineAttrs(lineNumber, {
          drawing_number: n(result.drawing_number) ?? drawing_number,
          document_number: n(result.document_number),
          size: n(result.size),
          spec_class: n(result.spec_class),
          service: n(result.service),
          from_location: n(result.from_location),
          to_location: n(result.to_location),
          slope: normalizeSlope(n(result.slope)),
          scale: n(result.scale),
          sheet: n(result.sheet),
          revision: n(result.revision),
          owner_pid_no: n(result.owner_pid_no),
          pid_no: n(result.pid_no),
          owner_ga_dwg_no: n(result.owner_ga_dwg_no),
          ga_dwg_no: n(result.ga_dwg_no),
          design_pressure: n(result.design_pressure),
          design_temperature: n(result.design_temperature),
          operating_pressure: n(result.operating_pressure),
          operating_temperature: n(result.operating_temperature),
          hydrotest_pressure: n(result.hydrotest_pressure),
          hydrotest_temperature: n(result.hydrotest_temperature),
          painting_system: n(result.painting_system),
          radiograph: n(result.radiograph),
          test_type: n(result.test_type),
          insul_spec: n(result.insul_spec),
          insul_thickness_mm: n(result.insul_thickness_mm),
          // Every class present on the drawing (a spec break means the line
          // carries two) -- gate 4/7 validate each BOM item against its own
          // class rather than the title block's.
          spec_breaks: specsWithRatings,
        }),
      });
      for (const spool of resolvedSpools) {
        tags.push({
          tagType: "spool",
          // The exact tag printed in the sheet's own "PIPE SPOOLS"
          // schedule (or a sequential fallback on the rare sheet that
          // prints none) -- see buildSpoolsFromWeldTopology in @easy/shared.
          tagNumber: spool.spoolTag,
          sourcePage: pageNumber,
          attributes: {
            drawing_number: n(result.drawing_number) ?? drawing_number,
            line_number: lineNumber,
            spool_index: spool.index,
            weld_numbers: spool.weldNumbers,
            note: closingNote(spool, spool.index === resolvedSpools.length),
          },
        });
      }
      for (const weld of welds) {
        const weldType = n(weld.weld_type);
        const weldNo = Number(weld.weld_no);
        const spoolTag = Number.isFinite(weldNo) ? weldToSpoolTag.get(weldNo) : undefined;
        tags.push({
          tagType: "weld",
          // Weld numbers restart per sheet, so the type prefix and the sheet
          // (sourcePage) are what make a weld identifiable across a drawing.
          tagNumber: weldType ? `${weldType}-${weld.weld_no}` : weld.weld_no,
          sourcePage: pageNumber,
          attributes: {
            drawing_number: n(result.drawing_number) ?? drawing_number,
            line_number: lineNumber,
            weld_no: weld.weld_no,
            weld_type: weldType,
            size: n(weld.size),
            nde_codes: n(weld.nde_codes),
            // Computed by buildSpoolsFromWeldTopology from this weld's own
            // comes_after_weld/closes_spool answers, then mapped onto the
            // sheet's printed "PIPE SPOOLS" tags -- never asked of the model
            // directly. Blank when this weld's ID never appeared in the
            // topology walk (e.g. a broken comes_after_weld link).
            spool_no: spoolTag,
          },
        });
      }
    }
    for (const item of asArray(result.bom_items)) {
      const materialSection = n(item.material_section);
      tags.push({
        tagType: "bom_item",
        // Revision-added rows are printed with no PT NO, so item_no cannot be
        // the key for them -- fall back to the description, the same way an
        // untagged P&ID valve is keyed by its valve type. Nothing is
        // composed into this: the PT NO is reported verbatim from item_no,
        // and the materials block it belongs to stays in material_section
        // where the BOM view reads it from.
        tagNumber: item.item_no?.trim() || (n(item.description) ?? item.description),
        sourcePage: pageNumber,
        attributes: {
          drawing_number,
          line_number: result.line_number,
          item_no: n(item.item_no),
          material_section: materialSection,
          description: item.description,
          component_type: item.component_type,
          size: item.size,
          quantity: item.quantity,
          material: item.material,
          item_code: item.item_code,
          // The class governing THIS item on a spec-break drawing. Falls back
          // to a deterministic rating match (150# -> the 150# class, 300# ->
          // the 300# class) when the extraction left it blank; stays blank for
          // items with no rating signature rather than guessing a side.
          item_spec_class:
            n(item.item_spec_class) ??
            assignItemSpec(`${item.description ?? ""} ${item.item_code ?? ""}`, specsWithRatings)?.spec_class,
          // How the class was decided, so a reviewer can audit it: the
          // extraction reports its own basis (position/rating/rate-matched),
          // and the deterministic rating fallback labels itself.
          item_spec_basis:
            n(item.item_spec_basis) ??
            (n(item.item_spec_class)
              ? undefined
              : assignItemSpec(`${item.description ?? ""} ${item.item_code ?? ""}`, specsWithRatings)
                ? "rating"
                : undefined),
          // The line's own spec class (e.g. "150JY11") -- item_code (e.g.
          // "P9610-C") is what should be looked up within that class's
          // pipes/fittings/flanges/valves, not compared as if it were a
          // class code itself (see verifyIso.ts).
          spec_class: result.spec_class,
        },
      });
    }
  }

  return { rawJson: { sheets: allSheets }, tags };
};
