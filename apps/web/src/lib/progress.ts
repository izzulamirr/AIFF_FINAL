import { desc, eq, inArray } from "drizzle-orm";
import { lineReviews, projectLineTotals } from "@easy/db";
import { needsRecheck } from "@easy/shared";
import { getDb } from "@/lib/db";
import { isoLinesOf } from "@/lib/isoLines";

// Line progress: how many of a project's lines have been checked, against the
// total Document Control says there are.
//
// It reads two tables that supabase/line-progress.sql creates. Until that has
// been run they do not exist, and Postgres answers every query with
// "undefined_table" -- which would take the dashboard down with it. So a missing
// table is reported as `null`, meaning "not set up yet", and the pages show a
// notice in its place. Any OTHER error is a real one and is thrown.

/** Postgres "undefined_table": the progress tables have not been created yet. */
export function isMissingTable(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "42P01" || e?.cause?.code === "42P01";
}

export interface LineReview {
  lineKey: string;
  /** As printed on the drawing. */
  lineNumber: string;
  reviewedByName: string | null;
  reviewedAt: Date;
  /** The drawing revision this check was made against. Null if it was not known at the time. */
  revision: string | null;
}

const toReview = (row: typeof lineReviews.$inferSelect): LineReview => ({
  lineKey: row.lineKey,
  lineNumber: row.lineNumber,
  reviewedByName: row.reviewedByName,
  reviewedAt: row.reviewedAt,
  revision: row.revision,
});

/**
 * How a line stands: checked against the drawing in force, checked against an
 * older one, or not checked.
 *
 * A revision does NOT erase the check. The tick stays, with who made it and
 * when, and the line is marked for RE-CHECK -- which is the honest state, since
 * somebody did review that line, just not this drawing.
 */
export type LineState = "done" | "recheck" | "open";

export function lineStateOf(review: LineReview | undefined, currentRevision: string | null): LineState {
  if (!review) return "open";
  return needsRecheck(review.revision, currentRevision) ? "recheck" : "done";
}

/** A review with the revision now in force beside the one it was made against. */
export interface ClassifiedReview extends LineReview {
  /** The revision in force for this line now. Null where it could not be read. */
  currentRevision: string | null;
  state: Exclude<LineState, "open">;
}

/**
 * Judge each review against the drawing now in force.
 *
 * A review whose line is no longer in the project -- its drawing was deleted --
 * has no current revision to compare with, so it stands. Absence of a drawing is
 * not evidence of a revision.
 */
export function classifyReviews(reviews: LineReview[], lines: Array<{ key: string; revision: string | null }>): ClassifiedReview[] {
  const revisionOf = new Map(lines.map((l) => [l.key, l.revision]));
  return reviews.map((review) => {
    const currentRevision = revisionOf.get(review.lineKey) ?? null;
    return { ...review, currentRevision, state: needsRecheck(review.revision, currentRevision) ? "recheck" : "done" };
  });
}

/**
 * Split a project's reviews by whether they still stand.
 *
 * Counted rather than folded into one number, because "40 of 40 checked" while
 * five of them were checked against superseded drawings is a figure that reads
 * as finished and is not.
 */
export function countProgress(reviews: LineReview[], lines: Array<{ key: string; revision: string | null }>) {
  const classified = classifyReviews(reviews, lines);
  return {
    done: classified.filter((r) => r.state === "done").length,
    recheck: classified.filter((r) => r.state === "recheck").length,
  };
}

/** One project: the total Document Control stated (null if it has not), and every line checked, newest first. */
export interface ProjectLineProgress {
  total: number | null;
  reviews: LineReview[];
}

/** Null when the progress tables have not been created yet. */
export async function progressOfProject(projectId: string): Promise<ProjectLineProgress | null> {
  try {
    const db = getDb();
    const [totalRow] = await db.select().from(projectLineTotals).where(eq(projectLineTotals.projectId, projectId)).limit(1);
    const rows = await db.select().from(lineReviews).where(eq(lineReviews.projectId, projectId)).orderBy(desc(lineReviews.reviewedAt));
    return { total: totalRow?.totalLines ?? null, reviews: rows.map(toReview) };
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

export interface ProjectProgress extends ProjectLineProgress {
  projectId: string;
  projectName: string;
  /** ISO lines uploaded so far -- usually fewer than the total, since drawings arrive over time. */
  uploaded: number;
  /** Checked against the drawing now in force. */
  done: number;
  /** Checked, but against a drawing a later revision has replaced. */
  recheck: number;
  /** Every review, each judged against the revision now in force. */
  classified: ClassifiedReview[];
}

/** Several projects at once, for the dashboard. Null when the progress tables have not been created yet. */
export async function progressOfProjects(projects: Array<{ id: string; name: string }>): Promise<ProjectProgress[] | null> {
  if (projects.length === 0) return [];
  const ids = projects.map((p) => p.id);
  // Not part of the tables that may be missing, so an error here is a real one.
  // The lines are kept, not just counted: each carries the revision now in force,
  // which is what says whether a check still stands.
  const linesOf = await Promise.all(projects.map((p) => isoLinesOf(p.id)));

  try {
    const db = getDb();
    const totals = await db.select().from(projectLineTotals).where(inArray(projectLineTotals.projectId, ids));
    const rows = await db.select().from(lineReviews).where(inArray(lineReviews.projectId, ids)).orderBy(desc(lineReviews.reviewedAt));
    const totalOf = new Map(totals.map((t) => [t.projectId, t.totalLines]));

    return projects.map((p, i) => {
      const reviews = rows.filter((r) => r.projectId === p.id).map(toReview);
      const classified = classifyReviews(reviews, linesOf[i]);
      return {
        projectId: p.id,
        projectName: p.name,
        total: totalOf.get(p.id) ?? null,
        uploaded: linesOf[i].length,
        reviews,
        classified,
        done: classified.filter((r) => r.state === "done").length,
        recheck: classified.filter((r) => r.state === "recheck").length,
      };
    });
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}
