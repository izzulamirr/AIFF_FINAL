import { isFieldWeld } from "@easy/shared";
import { buildSpoolSheets, type SpoolEnvelopeAttr, type SpoolingTag } from "./spooling";

// What the container page needs to know about each spool.
//
// The FIELD WELD COUNT comes from the extraction, because it has to: a field
// weld adds 150mm of excess pipe to what gets shipped (NOTE 4 -- "WHENEVER
// FIELD ADJUSTED JOINT (FAJ) IS INDICATED, AN EXCESS OF 150mm TO BE
// PROVIDED"), and it is the one input a loader cannot eyeball off the spool.
//
// The SIZE is derived too, from the dimensions read off the sheets. Each
// length is tied to a spool by where it ATTACHES to the pipe, and the one
// spool verified by hand -- N-01, 588mm down and 404mm west -- comes out
// exactly. The other seventeen have not been checked against the drawing.
//
// So it arrives marked `derived` and carrying the lengths that produced it,
// and the page shows those workings beside the figure. A number on its own
// invites a nod; "588 = 202+202+184" lets someone who knows the drawing say
// which of the three does not belong. There is nothing to type: the size is
// read off the drawing, and the page's job is to let someone CHECK it.
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
}

export function buildContainerSpools(tags: SpoolingTag[]): ContainerSpool[] {
  const out: ContainerSpool[] = [];
  for (const sheet of buildSpoolSheets(tags)) {
    const envelopeOf = new Map(sheet.spools.map((r) => [r.spoolNo, r.envelope]));
    for (const group of sheet.weldsBySpool) {
      // "-" is the bucket for welds whose spool is unknown. It is not a spool
      // and nothing ships as one, so it has no envelope to check.
      if (group.spoolNo === "-") continue;
      out.push({
        key: `${sheet.page ?? 0}:${group.spoolNo}`,
        lineNumber: sheet.lineNumber,
        sheetLabel: sheet.sheetLabel,
        page: sheet.page,
        spoolNo: group.spoolNo,
        weldCount: group.welds.length,
        fieldWelds: group.welds.filter((w) => isFieldWeld(w.weldType)).length,
        fieldWeldNumbers: group.welds
          .filter((w) => isFieldWeld(w.weldType))
          .map((w) => Number(w.weldNo))
          .filter((n) => Number.isFinite(n)),
        envelope: envelopeOf.get(group.spoolNo) ?? null,
      });
    }
  }
  return out;
}
