import { and, desc, eq, inArray } from "drizzle-orm";
import { documents, extractedTags, extractionJobs, lineReviews, projectLineTotals } from "@easy/db";
import { currentDocuments, needsRecheck, normalizeTagNumber } from "@easy/shared";
import { getDb } from "@/lib/db";
import { isoLinesOf } from "@/lib/isoLines";
import { CHANGED, compareSources, sourcesOfLines, type LineSource, type SourceComparison } from "@/lib/lineSources";

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
  /** Every document the check was based on. Null for a check made before sources were tracked. */
  basis: LineSource[] | null;
}

const toReview = (row: typeof lineReviews.$inferSelect): LineReview => ({
  lineKey: row.lineKey,
  lineNumber: row.lineNumber,
  reviewedByName: row.reviewedByName,
  reviewedAt: row.reviewedAt,
  revision: row.revision,
  basis: Array.isArray(row.basis) ? (row.basis as LineSource[]) : null,
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

export function lineStateOf(review: LineReview | undefined, currentRevision: string | null, currentSources?: LineSource[]): LineState {
  if (!review) return "open";
  if (needsRecheck(review.revision, currentRevision)) return "recheck";
  // Any document the check was based on having changed since -- a P&ID revision,
  // a new line list row, a newer spec -- means it no longer stands either.
  return currentSources && compareSources(review.basis, currentSources, review.reviewedAt).some((c) => CHANGED.has(c.status)) ? "recheck" : "done";
}

/** A review with the revision now in force beside the one it was made against. */
export interface ClassifiedReview extends LineReview {
  /** The revision in force for this line now. Null where it could not be read. */
  currentRevision: string | null;
  state: Exclude<LineState, "open">;
  /** The basis as checked against as it is now, one entry per document. Empty where none was recorded. */
  sources: SourceComparison[];
}

/**
 * Judge each review against the drawing now in force.
 *
 * A review whose line is no longer in the project -- its drawing was deleted --
 * has no current revision to compare with, so it stands. Absence of a drawing is
 * not evidence of a revision.
 */
export function classifyReviews(
  reviews: LineReview[],
  lines: Array<{ key: string; revision: string | null }>,
  currentSources?: Map<string, LineSource[]>
): ClassifiedReview[] {
  const revisionOf = new Map(lines.map((l) => [l.key, l.revision]));
  return reviews.map((review) => {
    const currentRevision = revisionOf.get(review.lineKey) ?? null;
    // A line no longer in the project has no sources now; that is not a change.
    const now = revisionOf.has(review.lineKey) ? currentSources?.get(review.lineKey) : undefined;
    const sources = now ? compareSources(review.basis, now, review.reviewedAt) : [];
    const state = needsRecheck(review.revision, currentRevision) || sources.some((c) => CHANGED.has(c.status)) ? "recheck" : "done";
    return { ...review, currentRevision, state, sources };
  });
}

/**
 * Split a project's reviews by whether they still stand.
 *
 * Counted rather than folded into one number, because "40 of 40 checked" while
 * five of them were checked against superseded drawings is a figure that reads
 * as finished and is not.
 */
export function countProgress(
  reviews: LineReview[],
  lines: Array<{ key: string; revision: string | null }>,
  currentSources?: Map<string, LineSource[]>
) {
  const classified = classifyReviews(reviews, lines, currentSources);
  return {
    // Every line a checker has marked done counts as done -- a document changing
    // afterwards does not undo the work. Those it applies to are counted again
    // in `recheck`, a SUBSET of `done`, so they can be flagged without vanishing.
    done: classified.length,
    recheck: classified.filter((r) => r.state === "recheck").length,
  };
}

// HOW MANY LINES A PROJECT HAS comes from its line list. The current PLL lists
// every line the project will have, so its count is the total -- worked out, not
// typed in, and it follows the PLL when a new revision of it is uploaded. A figure
// Document Control typed in is only used where no line list has been read yet.

/** The project's line list as a total: its distinct line numbers, and which file they came from. */
export interface LineListTotal {
  count: number;
  fileName: string;
}

/** Each project's current, read line list, counted. A project with none is absent from the map. */
export async function lineListTotals(projectIds: string[]): Promise<Map<string, LineListTotal>> {
  const out = new Map<string, LineListTotal>();
  if (projectIds.length === 0) return out;
  const db = getDb();
  const plls = await db.select().from(documents).where(and(inArray(documents.projectId, projectIds), eq(documents.docType, "pll")));
  if (plls.length === 0) return out;

  const jobs = await db
    .select({ documentId: extractionJobs.documentId, status: extractionJobs.status, createdAt: extractionJobs.createdAt })
    .from(extractionJobs)
    .where(inArray(extractionJobs.documentId, plls.map((d) => d.id)));
  const latest = new Map<string, (typeof jobs)[number]>();
  for (const j of jobs) {
    const seen = latest.get(j.documentId);
    if (!seen || j.createdAt > seen.createdAt) latest.set(j.documentId, j);
  }
  // Only a line list that has been read, and only the revision in force -- an
  // older upload of it would count lines the new one dropped.
  const read = plls.filter((d) => latest.get(d.id)?.status === "succeeded");
  const inForce = projectIds.flatMap((p) => currentDocuments(read.filter((d) => d.projectId === p)));
  if (inForce.length === 0) return out;

  const rows = await db
    .select({ documentId: extractedTags.documentId, tagNumber: extractedTags.tagNumber })
    .from(extractedTags)
    .where(and(inArray(extractedTags.documentId, inForce.map((d) => d.id)), eq(extractedTags.tagType, "line")));
  for (const p of projectIds) {
    const docs = inForce.filter((d) => d.projectId === p);
    const ids = new Set(docs.map((d) => d.id));
    // Distinct numbers: a line printed on two sheets of the list is one line.
    const keys = new Set(rows.filter((r) => ids.has(r.documentId)).map((r) => normalizeTagNumber(r.tagNumber)).filter(Boolean));
    if (keys.size > 0) out.set(p, { count: keys.size, fileName: docs.map((d) => d.fileName).join(", ") });
  }
  return out;
}

/** One project: how many lines it has (null if neither a line list nor a typed figure says), and every line checked, newest first. */
export interface ProjectLineProgress {
  total: number | null;
  /** Where the total came from: the line list, counted (null where it was typed in, or there is none). */
  lineList: LineListTotal | null;
  reviews: LineReview[];
}

/** Null when the progress tables have not been created yet. */
export async function progressOfProject(projectId: string): Promise<ProjectLineProgress | null> {
  try {
    const db = getDb();
    const [totalRow] = await db.select().from(projectLineTotals).where(eq(projectLineTotals.projectId, projectId)).limit(1);
    const rows = await db.select().from(lineReviews).where(eq(lineReviews.projectId, projectId)).orderBy(desc(lineReviews.reviewedAt));
    const lineList = (await lineListTotals([projectId])).get(projectId) ?? null;
    return { total: lineList?.count ?? totalRow?.totalLines ?? null, lineList, reviews: rows.map(toReview) };
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
  /** Marked done by a checker -- including those that now need a re-check. */
  done: number;
  /** Of those, how many were checked against a document that has since changed. A subset of `done`. */
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
  const sourcesOf = await Promise.all(projects.map((p, i) => sourcesOfLines(p.id, linesOf[i])));
  const lineLists = await lineListTotals(ids);

  try {
    const db = getDb();
    const totals = await db.select().from(projectLineTotals).where(inArray(projectLineTotals.projectId, ids));
    const rows = await db.select().from(lineReviews).where(inArray(lineReviews.projectId, ids)).orderBy(desc(lineReviews.reviewedAt));
    const totalOf = new Map(totals.map((t) => [t.projectId, t.totalLines]));

    return projects.map((p, i) => {
      const reviews = rows.filter((r) => r.projectId === p.id).map(toReview);
      const classified = classifyReviews(reviews, linesOf[i], sourcesOf[i]);
      return {
        projectId: p.id,
        projectName: p.name,
        total: lineLists.get(p.id)?.count ?? totalOf.get(p.id) ?? null,
        lineList: lineLists.get(p.id) ?? null,
        uploaded: linesOf[i].length,
        reviews,
        classified,
        done: classified.length,
        recheck: classified.filter((r) => r.state === "recheck").length,
      };
    });
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}
