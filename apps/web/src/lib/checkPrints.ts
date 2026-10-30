import { asc, eq } from "drizzle-orm";
import { lineCheckPrints } from "@easy/db";
import { getDb } from "@/lib/db";
import type { IsoLine } from "@/lib/isoLines";
import { isMissingTable } from "@/lib/progress";

// CHECK PRINTS. A line's ISO is checked and, while it still has errors, sent back
// to the designer as a check print -- CP-01, CP-02, CP-03 -- then issued FINAL once
// it has none, which is what marks it done. FINAL is refused while any error
// remains, however many check prints there have been.
//
// The cycle belongs to an ISO REVISION: REV A runs CP-01 .. Final, and REV B, when
// it comes, starts again at CP-01. Within a revision the next check print waits
// for the designer's resubmitted drawing -- re-issuing the same file would only
// repeat the same errors.

export const MAX_CHECK_PRINTS = 3;

export interface CheckPrint {
  id: string;
  lineKey: string;
  kind: "cp" | "final";
  seq: number;
  isoRevision: string | null;
  isoDocumentIds: string[];
  errorCount: number;
  issuedByName: string | null;
  issuedAt: Date;
}

/** "CP-01", "CP-02" ... or "Final". */
export const checkPrintLabel = (p: { kind: string; seq: number }) => (p.kind === "final" ? "Final" : `CP-${String(p.seq).padStart(2, "0")}`);

/** Every check print in a project, oldest first. Null when the table has not been created yet. */
export async function checkPrintsOf(projectId: string): Promise<CheckPrint[] | null> {
  try {
    const rows = await getDb().select().from(lineCheckPrints).where(eq(lineCheckPrints.projectId, projectId)).orderBy(asc(lineCheckPrints.issuedAt));
    return rows.map((r) => ({
      id: r.id,
      lineKey: r.lineKey,
      kind: r.kind === "final" ? "final" : "cp",
      seq: r.seq,
      isoRevision: r.isoRevision,
      isoDocumentIds: Array.isArray(r.isoDocumentIds) ? (r.isoDocumentIds as string[]) : [],
      errorCount: r.errorCount,
      issuedByName: r.issuedByName,
      issuedAt: r.issuedAt,
    }));
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

/** What a line's next step is, and why. */
export type NextStep =
  /** Errors remain and a check print can be issued: `label` is its number. */
  | { step: "cp"; label: string }
  /** No errors: the line can be issued Final, which marks it done. */
  | { step: "final"; label: "Final" }
  /** A check print was issued on this ISO revision; the designer's revised ISO is awaited. */
  | { step: "waiting"; label: string }
  /** All three check prints used and errors remain: Final needs them fixed first. */
  | { step: "blocked"; label: string };

/** Whether a check print was made on the very drawing files now in force for the line. */
const sameDrawing = (p: CheckPrint, line: IsoLine) => p.isoDocumentIds.slice().sort().join() === line.documentIds.slice().sort().join();

/**
 * The cycle runs PER ISO REVISION: REV A has its own CP-01 .. CP-03 and Final,
 * and REV B starts again at CP-01. These are a line's prints for the revision now
 * in force.
 */
export const printsOfRevision = (prints: CheckPrint[], line: IsoLine) =>
  prints.filter((p) => p.lineKey === line.key && (p.isoRevision ?? null) === (line.revision ?? null));

export function nextStep(prints: CheckPrint[], line: IsoLine, errorCount: number): NextStep {
  const cps = printsOfRevision(prints, line).filter((p) => p.kind === "cp");
  if (errorCount === 0) return { step: "final", label: "Final" };
  const last = cps[cps.length - 1];
  if (last && sameDrawing(last, line)) return { step: "waiting", label: checkPrintLabel(last) };
  if (cps.length >= MAX_CHECK_PRINTS) return { step: "blocked", label: checkPrintLabel(last!) };
  return { step: "cp", label: checkPrintLabel({ kind: "cp", seq: cps.length + 1 }) };
}

/** A line's own check prints, oldest first. */
export const printsOfLine = (prints: CheckPrint[] | null, lineKey: string) => (prints ?? []).filter((p) => p.lineKey === lineKey);
