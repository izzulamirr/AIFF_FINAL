import { desc, eq, inArray } from "drizzle-orm";
import { lineReviews, projectLineTotals } from "@easy/db";
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
}

const toReview = (row: typeof lineReviews.$inferSelect): LineReview => ({
  lineKey: row.lineKey,
  lineNumber: row.lineNumber,
  reviewedByName: row.reviewedByName,
  reviewedAt: row.reviewedAt,
});

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
}

/** Several projects at once, for the dashboard. Null when the progress tables have not been created yet. */
export async function progressOfProjects(projects: Array<{ id: string; name: string }>): Promise<ProjectProgress[] | null> {
  if (projects.length === 0) return [];
  const ids = projects.map((p) => p.id);
  // Not part of the tables that may be missing, so an error here is a real one.
  const uploaded = await Promise.all(projects.map(async (p) => (await isoLinesOf(p.id)).length));

  try {
    const db = getDb();
    const totals = await db.select().from(projectLineTotals).where(inArray(projectLineTotals.projectId, ids));
    const rows = await db.select().from(lineReviews).where(inArray(lineReviews.projectId, ids)).orderBy(desc(lineReviews.reviewedAt));
    const totalOf = new Map(totals.map((t) => [t.projectId, t.totalLines]));

    return projects.map((p, i) => ({
      projectId: p.id,
      projectName: p.name,
      total: totalOf.get(p.id) ?? null,
      uploaded: uploaded[i],
      reviews: rows.filter((r) => r.projectId === p.id).map(toReview),
    }));
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}
