import { inArray } from "drizzle-orm";
import { itemHolds } from "@easy/db";
import { getDb } from "@/lib/db";
import { isMissingTable } from "@/lib/progress";

// ON HOLD and PENDING: an item that is waiting on something, not wrong.
//
//   pending   the data to check it against has not been supplied -- typically by
//             the client or a vendor (an instrument with no hook-up or datasheet).
//   hold      the item itself is held: the drawing prints HOLD / TBA / TBC against
//             it, or somebody has marked it so.
//
// Neither is an error. A line's report is issued with these listed per SHEET --
// "line X, sheet 4: instrument FT-1234 pending client data" -- rather than held
// back for one item nobody on the job can answer yet.

//   vendor    PENDING VENDOR DATA: an instrument hook-up with no supporting
//             document -- no hook-up typical covers it, or none has been supplied
//             at all. Worked out by the hook-up check, never stored.
export type HoldStatus = "pending" | "hold" | "vendor";

export const HOLD_LABEL: Record<HoldStatus, string> = { pending: "Pending", hold: "On hold", vendor: "Pending Vendor Data" };

export interface ItemHold {
  status: HoldStatus;
  remark: string;
  /** Where the hold came from: printed on the drawing, worked out by a check, or marked by a person. */
  source: "drawing" | "check" | "manual";
  markedByName?: string | null;
  markedAt?: Date | null;
}

/**
 * A BOM row's identity on its drawing: page, materials block, PT NO, description.
 *
 * Not the extracted row id -- re-extraction recreates every row, and a hold has to
 * outlive that. Two rows sharing every one of these are the same item twice, and
 * holding one holds both, which is the right answer.
 */
export function bomItemKey(page: number | null, attrs: Record<string, unknown>): string {
  const part = (v: unknown) =>
    String(v ?? "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, " ");
  return [page ?? "", part(attrs.material_section), part(attrs.item_no), part(attrs.description)].join("|");
}

// What a draughtsman writes on a BOM row that is not yet settled. Whole words only,
// so "THREADED" never reads as TBD and "HOLDER" never as HOLD.
const PRINTED_HOLD = /\b(HOLD|TBA|TBC|TBD|PENDING)\b/i;

/** A hold the DRAWING prints on this BOM row -- in its description, quantity or item code. */
export function printedHold(attrs: Record<string, unknown>): ItemHold | null {
  for (const field of ["quantity", "item_code", "description", "size"] as const) {
    const value = attrs[field];
    if (typeof value !== "string") continue;
    const m = PRINTED_HOLD.exec(value);
    if (m) {
      const word = m[1].toUpperCase();
      return {
        status: word === "PENDING" ? "pending" : "hold",
        remark: `The drawing marks this item "${word}" (${field === "item_code" ? "item code" : field}).`,
        source: "drawing",
      };
    }
  }
  return null;
}

/**
 * Holds people have marked, for these documents, keyed `${documentId}::${itemKey}`.
 * `tableExists` is false until supabase/item-holds.sql has been run.
 */
export async function loadItemHolds(documentIds: string[]): Promise<{ holds: Map<string, ItemHold>; tableExists: boolean }> {
  const holds = new Map<string, ItemHold>();
  if (documentIds.length === 0) return { holds, tableExists: true };
  try {
    const rows = await getDb().select().from(itemHolds).where(inArray(itemHolds.documentId, documentIds));
    for (const r of rows) {
      holds.set(`${r.documentId}::${r.itemKey}`, {
        status: r.status === "hold" ? "hold" : "pending",
        remark: r.remark,
        source: "manual",
        markedByName: r.markedByName,
        markedAt: r.markedAt,
      });
    }
    return { holds, tableExists: true };
  } catch (err) {
    if (isMissingTable(err)) return { holds, tableExists: false };
    throw err;
  }
}

/** The remark for an instrument the hook-up check could not cover. */
export function instrumentPendingRemark(label: string, reason: string | null): string {
  return `No supporting hook-up document for this ${label}, so its piping cannot be checked until the vendor data is supplied.${reason ? ` ${reason}` : ""}`;
}
