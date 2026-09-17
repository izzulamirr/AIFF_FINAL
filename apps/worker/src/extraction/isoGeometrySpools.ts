// The drawing's own answer to which spool each weld belongs to, wired for the
// extraction pipeline rather than for a script.
//
// WHY THIS EXISTS. The vision pipeline works out spools by asking the model
// where the boundaries are and walking each weld's `comes_after_weld` answer.
// Measured against the reference ISO, that produces 2 spools of 18 correct;
// measured against its revision, 21 of 66 welds land in the right spool and 6
// of 12 boundaries are in the right place. The geometry gets all 18, on both
// drawings, and the failure is not random: the model reads tables and text
// excellently (the weld list comes back exact, 93 of 93, complete 1..N on every
// page) and cannot reliably tie a valve to a weld NUMBER. The one sheet it
// placed perfectly is the one whose every boundary is a field weld -- read off
// the table, not off the drawing.
//
// So the split here gives each half the job it is good at:
//
//   the model     the title block, the BOM, the WELD LIST -- number, TYPE, bore
//   the geometry  where every weld IS, and where the line comes apart
//
// The only thing neither can do alone is read the NUMBER inside a weld flag:
// the CAD export outlines its text, so `getTextContent()` returns nothing and
// the number is vector paths. That is one small contact sheet of already
// isolated, blown-up labels -- 2,844 input tokens for a whole sheet's welds --
// and it comes back exact.
//
// It is also CHEAPER than what it replaces. The boundary pass it makes
// unnecessary is a full image set at 16k max tokens per sheet, about $0.89 a
// time; the contact sheet for a whole five-sheet document is about $0.10.
import { readWeldMarks, type WeldMarkResult } from "./isoWeldMarks";
import { readSpoolCuts, assignSpools, type WeldRow } from "./isoSpoolCuts";
import { findSpoolTagLeaders, blockOfLeader, tagsByBlock } from "./isoSpoolTags";
import { readPageGeometry } from "../pdfGeometry";

export interface FlagRegion {
  label: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Every flag on a page, ready for the contact sheet.
 *
 * EVERY one goes on, including the few whose leader was never traced. Reading a
 * number does not depend on having followed its leader, and the numbers coming
 * back as a complete 1..N with no repeat is the self-check that the read is
 * right -- a check that only works if no flag was left off. An untraced flag has
 * no box recorded, so one is cut around its centre at the height every flag is
 * drawn to.
 */
export function flagRegions(page: number, marks: WeldMarkResult): FlagRegion[] {
  return [
    ...marks.hits.map((h, i) => ({ label: flagCell(page, i), bbox: h.flagBox })),
    ...marks.untraced.map((u, j) => ({
      label: `${page}-u${j + 1}`,
      bbox: { x0: u.x - 27, y0: u.y - 8, x1: u.x + 27, y1: u.y + 8 },
    })),
  ];
}

/**
 * Did this page's flags come back as a complete, unduplicated 1..N?
 *
 * This is the whole reason the contact sheet can be trusted without anyone
 * looking at it. A misread almost always shows up as a gap or a repeat, and the
 * weld list read separately by the sheet pass says how many welds there should
 * be. Where this is false the geometry has no usable numbering for the page and
 * the vision answer is left in place.
 */
export function numberingComplete(labels: Array<string | null | undefined>, expected: number): boolean {
  const nums = labels
    .map((s) => Number(String(s ?? "").replace(/^[A-Za-z\s]+/, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length !== expected) return false;
  const distinct = new Set(nums);
  if (distinct.size !== nums.length) return false;
  for (let n = 1; n <= expected; n++) if (!distinct.has(n)) return false;
  return true;
}

export interface GeometrySpoolPage {
  page: number;
  /** Where the spools break, in weld numbers: the spool ends AFTER each. */
  cuts: number[];
  /** Whether the cut count matched the sheet's own printed spool count. */
  trusted: boolean;
  /** Said plainly when it is not, so a sheet is never silently left behind. */
  why?: string;
  evidence: Array<{ cut: number; why: string }>;
  /** Weld number -> the printed spool tag it belongs to. Empty when untrusted. */
  assignment: Map<number, string>;
  /** The printed tags in block order, after any correction by tag leader. */
  tagOrder: string[];
  tagChanges: Array<{ block: number; from: string; to: string }>;
}

/**
 * Which spool each weld on one sheet belongs to, from the drawing.
 *
 * `weldNumberOf` maps a located mark to its weld number -- supplied by the
 * caller because that is the one part costing anything. Everything else here is
 * read from the PDF.
 *
 * A sheet whose cut count does not match its printed spool count is REFUSED,
 * never guessed at: N tags means exactly N-1 cuts, and getting that wrong puts
 * welds in the wrong spool, which is worse than leaving them where the vision
 * pass put them.
 */
export async function readGeometrySpools(opts: {
  pdf: Buffer;
  page: number;
  marks: WeldMarkResult;
  /** The sheet's weld list as the model read it -- number, TYPE and bore. */
  welds: WeldRow[];
  /** The sheet's printed PIPE SPOOLS tags. */
  spoolTags: string[];
  weldNumberOf: (hitIndex: number) => number | null;
  /** Tag string per spool-tag cell, where they have been read. */
  tagLabels?: Map<string, string>;
}): Promise<GeometrySpoolPage> {
  const { pdf, page, marks, welds, spoolTags, weldNumberOf } = opts;
  const { cuts, evidence } = await readSpoolCuts(pdf, page, marks, welds, weldNumberOf);

  const expected = spoolTags.length - 1;
  const empty = { page, cuts, evidence, assignment: new Map<number, string>(), tagOrder: spoolTags, tagChanges: [] };
  if (spoolTags.length === 0) {
    return { ...empty, trusted: false, why: "the sheet's PIPE SPOOLS schedule was not read, so there is nothing to check the cut count against" };
  }
  if (cuts.length !== expected) {
    // Say WHICH cuts, and what each was read off. A bare count leaves a
    // reviewer with a refused sheet and nowhere to start; the evidence points
    // straight at the suspect one. The usual cause of one cut too many is a
    // weld MISTYPED as FW in the weld list -- a field weld IS the forced cut,
    // so a mistyped one invents a boundary -- and the weld type is the one
    // input the geometry cannot supply or check.
    const how = evidence.length > 0 ? `; ${evidence.map((e) => e.why).join("; ")}` : "";
    return {
      ...empty,
      trusted: false,
      why: `the drawing gives ${cuts.length} cut${cuts.length === 1 ? "" : "s"} but its ${spoolTags.length} printed spool tags need ${expected}${how}`,
    };
  }

  // Which tag names which block, where the drawing says so with a leader.
  // Sheet 4 of the reference ISO is the case: its leaders put N-14 on the
  // 6000mm middle piece, which sorted order gives to N-13.
  let tagOrder = spoolTags;
  let tagChanges: Array<{ block: number; from: string; to: string }> = [];
  if (opts.tagLabels && opts.tagLabels.size > 0) {
    const { paths } = await readPageGeometry(pdf, page);
    const leaders = findSpoolTagLeaders(paths, locatedWelds(marks, weldNumberOf)).map((l, i) => ({
      tag: opts.tagLabels?.get(tagCell(page, i)) ?? null,
      block: blockOfLeader(l.flanking, cuts),
    }));
    // tagsByBlock accepts a re-ordering only if it is a PERMUTATION of the tags
    // the sheet prints -- every tag used once, none invented, none dropped.
    // Anything else keeps sorted order, which at least uses each tag once.
    const byBlock = tagsByBlock(leaders, spoolTags);
    tagOrder = byBlock.tags;
    tagChanges = byBlock.changed;
  }

  return { page, cuts, trusted: true, evidence, assignment: assignSpools(welds, cuts, tagOrder), tagOrder, tagChanges };
}

/**
 * Cell keys.
 *
 * Weld flags and spool tags go on SEPARATE contact sheets but into one label
 * map, so their keys must not collide -- a page's first weld flag and its first
 * spool tag are both "1". The spool tags carry an `s`.
 */
export const flagCell = (page: number, i: number) => `${page}-${i + 1}`;
export const tagCell = (page: number, i: number) => `s${page}-${i + 1}`;

/**
 * The boxes holding a sheet's spool tag strings.
 *
 * Needs the welds NUMBERED, because a tag's leader is placed by which welds
 * flank where it lands -- so this runs after the flag read, not beside it.
 */
export async function spoolTagRegions(
  pdf: Buffer,
  page: number,
  marks: WeldMarkResult,
  weldNumberOf: (hitIndex: number) => number | null
): Promise<FlagRegion[]> {
  const { paths } = await readPageGeometry(pdf, page);
  return findSpoolTagLeaders(paths, locatedWelds(marks, weldNumberOf)).map((l, i) => ({ label: tagCell(page, i), bbox: l.box }));
}

/** The welds whose mark was found AND whose flag was read, which is what the
 *  leader tracer needs to say where a tag points. */
function locatedWelds(marks: WeldMarkResult, weldNumberOf: (i: number) => number | null) {
  return marks.hits
    .map((h, i) => ({ weldNo: weldNumberOf(i), mark: h.mark }))
    .filter((w): w is { weldNo: number; mark: (typeof marks.hits)[number]["mark"] } => w.weldNo != null && w.weldNo > 0);
}

/** Every page's weld marks, read off the PDF. Free. */
export async function locateWeldFlags(pdf: Buffer, pages: number[]): Promise<Map<number, WeldMarkResult>> {
  const out = new Map<number, WeldMarkResult>();
  for (const page of pages) {
    try {
      out.set(page, await readWeldMarks(pdf, page));
    } catch {
      // A page the geometry cannot be read from simply has no geometric
      // answer; the vision result stands for it. Never fatal -- this whole
      // layer is an improvement on a pipeline that already works.
    }
  }
  return out;
}
