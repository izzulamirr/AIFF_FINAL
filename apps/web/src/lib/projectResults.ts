import { isoLinesOf } from "@/lib/isoLines";
import { summariseLine } from "@/lib/lineSummary";
import { buildIsoReport, type IsoReport } from "@/lib/isoReport";

// What the checks found on every ISO line of a project -- the same numbers the line's error
// report shows, rolled up. It needs no progress tables: it reads the extractions and runs the
// checks, so it is real data the day the drawings are uploaded.

export interface LineResult {
  lineNumber: string;
  revision: string | null;
  /** Errors only; findings for information are counted apart. */
  errors: number;
  info: number;
  /** On hold or pending data from the client -- not errors. */
  pending: number;
  byCheck: Omit<IsoReport["totals"], "all" | "info" | "pending">;
  /** Checks that could not run on this line (nothing uploaded to compare against). */
  notChecked: number;
  /** True when the checks themselves failed to run for this line. */
  failed: boolean;
}

const EMPTY: LineResult["byCheck"] = { designBasis: 0, bom: 0, pid: 0, hookup: 0, spooling: 0, containers: 0, supports: 0 };

/** Every current ISO line of one project, with what its checks found. */
export async function resultsOfProject(projectId: string): Promise<LineResult[]> {
  const lines = await isoLinesOf(projectId);
  const out: LineResult[] = [];
  // A few at a time: each line loads its drawing's tags and runs every check.
  for (let i = 0; i < lines.length; i += 4) {
    const batch = await Promise.all(
      lines.slice(i, i + 4).map(async (line): Promise<LineResult> => {
        const failed: LineResult = { lineNumber: line.lineNumber, revision: line.revision, errors: 0, info: 0, pending: 0, byCheck: EMPTY, notChecked: 0, failed: true };
        try {
          const report = buildIsoReport(await summariseLine(projectId, line));
          if (!report) return failed;
          const { all, info, pending, ...byCheck } = report.totals;
          return {
            lineNumber: line.lineNumber,
            revision: line.revision,
            errors: all,
            info,
            pending,
            byCheck,
            notChecked: report.drawings.reduce((n, d) => n + d.notChecked.length, 0),
            failed: false,
          };
        } catch {
          return failed;
        }
      })
    );
    out.push(...batch);
  }
  return out;
}
