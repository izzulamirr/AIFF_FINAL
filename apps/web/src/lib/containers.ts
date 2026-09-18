import { isFieldWeld, nominalBoreOdMm } from "@easy/shared";
import { buildSpoolSheets, type SpoolEnvelopeAttr, type SpoolingTag } from "./spooling";

// What the container page needs to know about each spool.
//
// The FIELD WELD COUNT comes from the extraction, because it has to: a field
// weld adds 150mm of excess pipe to what gets shipped (NOTE 4 -- "WHENEVER
// FIELD ADJUSTED JOINT (FAJ) IS INDICATED, AN EXCESS OF 150mm TO BE
// PROVIDED"), and it is the one input a loader cannot eyeball off the spool.
//
// The SIZE comes from the dimensions read off the sheets. Each length is tied
// to a spool by where it ATTACHES to the pipe.
//
// It carries the lengths that produced it, and the page shows those workings
// beside the figure. A number on its own invites a nod; "588 = 202+202+184"
// lets someone who knows the drawing say which of the three does not belong.
// There is nothing to type: the size is read off the drawing, and the page's
// job is to let someone CHECK it.
export interface ContainerSpool {
  key: string;
  lineNumber: string;
  sheetLabel: string;
  page: number | null;
  spoolNo: string;
  weldCount: number;
  /** Field welds inside this spool: each one carries its own 150mm allowance. */
  fieldWelds: number;
  /**
   * WHICH welds those are. The 150mm of excess pipe goes on the axis the
   * field weld actually sits on -- matching it to the length that attaches
   * there -- rather than on the longest side, which is only the worst-case
   * guess made when the direction is unknown.
   */
  fieldWeldNumbers: number[];
  /** Size worked out from the sheet's dimensions, unconfirmed. */
  envelope: SpoolEnvelopeAttr | null;
  /**
   * The pipe's OUTSIDE diameter, from the biggest bore in the spool's own
   * weld list. The container check needs it to work on the run rather than on
   * the box: a run is a centreline, and what occupies the box is that line
   * plus the pipe around it.
   *
   * Null where a bore is missing or off the standard table -- the check then
   * falls back to the bounding box, which never claims more than it should.
   */
  pipeOdMm: number | null;
}

/**
 * ONE ROW PER SPOOL, not one per sheet.
 *
 * A spool is a thing that gets welded up and put on a truck, and it does not
 * stop being one because the draughtsman ran out of paper. N-15 and N-16 each
 * carry on from sheet 4 onto sheet 5, so each had TWO rows -- one showing four
 * welds and no size, the other showing five welds and the size -- and a loader
 * reading that would count two spools and ship the wrong number of them. The
 * Each sheet carries its own envelope, covering only that sheet's pipe -- see
 * the note at the call site for why only the starting sheet's is reported.
 *
 * Merged here rather than in the extraction, where a row per sheet is the
 * right shape: weld numbers restart on every sheet, so the rows are what keeps
 * "weld 12 of sheet 4" apart from "weld 12 of sheet 5".
 */
export function buildContainerSpools(tags: SpoolingTag[]): ContainerSpool[] {
  const bySpool = new Map<string, ContainerSpool & { sheetLabels: string[] }>();
  for (const sheet of buildSpoolSheets(tags)) {
    const envelopeOf = new Map(sheet.spools.map((r) => [r.spoolNo, r.envelope]));
    for (const group of sheet.weldsBySpool) {
      // "-" is the bucket for welds whose spool is unknown. It is not a spool
      // and nothing ships as one, so it has no envelope to check.
      if (group.spoolNo === "-") continue;
      const fieldWeldNumbers = group.welds
        .filter((w) => isFieldWeld(w.weldType))
        .map((w) => Number(w.weldNo))
        .filter((n) => Number.isFinite(n));
      // THE BIGGEST bore on the spool. A run carries branches at smaller
      // sizes, and it is the largest that decides how much room the pipe
      // itself takes up.
      const ods = group.welds.map((w) => nominalBoreOdMm(w.size)).filter((n): n is number => n != null);
      const pipeOdMm = ods.length > 0 ? Math.max(...ods) : null;
      const envelope = envelopeOf.get(group.spoolNo) ?? null;
      const at = bySpool.get(group.spoolNo);
      if (!at) {
        bySpool.set(group.spoolNo, {
          key: group.spoolNo,
          lineNumber: sheet.lineNumber,
          sheetLabel: sheet.sheetLabel,
          sheetLabels: [sheet.sheetLabel],
          page: sheet.page,
          spoolNo: group.spoolNo,
          weldCount: group.welds.length,
          fieldWelds: group.welds.filter((w) => isFieldWeld(w.weldType)).length,
          fieldWeldNumbers,
          envelope,
          pipeOdMm,
        });
        continue;
      }
      at.weldCount += group.welds.length;
      at.fieldWelds += group.welds.filter((w) => isFieldWeld(w.weldType)).length;
      at.fieldWeldNumbers = [...new Set([...at.fieldWeldNumbers, ...fieldWeldNumbers])];
      if (pipeOdMm != null) at.pipeOdMm = Math.max(at.pipeOdMm ?? 0, pipeOdMm);
      if (!at.sheetLabels.includes(sheet.sheetLabel)) at.sheetLabels.push(sheet.sheetLabel);
      // THE SIZE COMES FROM THE SHEET THE SPOOL STARTS ON, and only that one.
      //
      // Envelopes are keyed `page:spool`, so a spool spanning two sheets has
      // one per sheet, each covering only that sheet's pipe. Combining them
      // was tried and is NOT wired up, because it does not survive contact
      // with the sum-vs-extent problem: N-16's two halves merge to
      // 6054 x 0 x 4399, which fits no container at all, where the drawing's
      // actual extents are UP 5580 and WEST 2795. An axis total is a SUM of its
      // legs, and a spool that changes sheets nearly always changes direction
      // too, so a merged total adds an up leg to a down leg and a west leg to
      // an east one. Resolving that needs the run topology, which is not
      // solved -- so until it is, the starting sheet's figure is reported and
      // the continuation sheet's lengths are left off.
      //
      // That means a spanning spool's size is INCOMPLETE, not merely
      // unconfirmed. `sheetLabel` says "4 & 5 / 5" while the size covers 4.
      if (!at.envelope && envelope) at.envelope = envelope;
    }
  }
  return [...bySpool.values()].map(({ sheetLabels, ...spool }) => ({
    ...spool,
    // "4 & 5 / 5" rather than two rows saying "4 / 5" and "5 / 5".
    sheetLabel:
      sheetLabels.length === 1
        ? sheetLabels[0]
        : `${sheetLabels.map((l) => l.split("/")[0].trim()).join(" & ")} / ${sheetLabels[0].split("/")[1]?.trim() ?? ""}`.trim(),
  }));
}
