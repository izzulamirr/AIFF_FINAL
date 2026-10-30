"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { lineCheckPrints, lineReviews, projectLineTotals } from "@easy/db";
import { getDb } from "@/lib/db";
import { checkPrintsOf, MAX_CHECK_PRINTS, nextStep } from "@/lib/checkPrints";
import { buildIsoReport } from "@/lib/isoReport";
import { findLine, isoLinesOf, lineKey } from "@/lib/isoLines";
import { sourcesOfLines } from "@/lib/lineSources";
import { summariseLine } from "@/lib/lineSummary";
import { getSessionUser } from "@/lib/session";
import { requireProjectMembership } from "./actions";

// Line progress -- who says how many lines there are, and who says one is done.
//
//   Document Control   states the TOTAL number of lines in a project.
//   A checker (user)   marks a line DONE once they have reviewed it, and can
//                      reopen it if that was a mistake.
//
// Document Control reviews lines too (at /review), but ONLY a checker's mark counts
// as progress -- so marking and reopening refuse Document Control outright, rather
// than trusting that it has no button.
//
// The buttons only appear for the right person, but these are what enforce it.

const CHECKERS_ONLY =
  "Only a checker can mark a line done or reopen it. Document Control can review a line, but that does not count toward progress.";

const MAX_TOTAL_LINES = 100_000;

async function requireSession() {
  const session = await getSessionUser();
  if (!session) throw new Error("Not authenticated.");
  return session;
}

function refresh(projectId: string) {
  revalidatePath("/dashboard");
  revalidatePath(`/projects/${projectId}`);
}

// Document Control enters how many lines the project holds. Blank clears it.
export async function setTotalLines(projectId: string, formData: FormData) {
  const session = await requireSession();
  if (!session.isDcc) throw new Error("Only Document Control (DCC) can set the total number of lines.");
  await requireProjectMembership(projectId, session.id);

  const raw = String(formData.get("total") ?? "").trim();
  const db = getDb();

  if (raw === "") {
    await db.delete(projectLineTotals).where(eq(projectLineTotals.projectId, projectId));
    return refresh(projectId);
  }

  const total = Number(raw);
  if (!Number.isInteger(total) || total < 0 || total > MAX_TOTAL_LINES) {
    throw new Error(`The total must be a whole number from 0 to ${MAX_TOTAL_LINES}.`);
  }

  await db
    .insert(projectLineTotals)
    .values({ projectId, totalLines: total, updatedBy: session.id })
    .onConflictDoUpdate({ target: projectLineTotals.projectId, set: { totalLines: total, updatedBy: session.id, updatedAt: new Date() } });
  refresh(projectId);
}

// A checker marks a line done. It has to be a real line of the project -- one an
// ISO actually carries -- so nothing can be marked that is not there.
//
// The REVISION in force is recorded with the check, which is what lets a later
// revision mark it for re-check instead of silently leaving a tick that says
// nothing about the current drawing.
//
// `onConflictDoUpdate`, not `doNothing`: re-marking a line that is IN RE-CHECK
// is the whole point of the re-check, and ignoring it would leave the line
// flagged forever. Re-marking a line already done at the same revision rewrites
// the same values, so it is harmless -- except that it moves `reviewedAt`, which
// is correct: somebody looked again.
export async function markLineReviewed(projectId: string, lineNumber: string) {
  const session = await requireSession();
  if (session.isDcc) throw new Error(CHECKERS_ONLY);

  const line = findLine(await isoLinesOf(projectId), lineNumber);
  if (!line) throw new Error("That line is not in this project.");

  const review = {
    reviewedBy: session.id,
    reviewedByName: session.name ?? session.email,
    reviewedAt: new Date(),
    revision: line.revision,
    // Everything the check was based on, so a later revision of any of it -- not
    // only of the ISO -- puts the line back to re-check.
    basis: (await sourcesOfLines(projectId, [line])).get(line.key) ?? [],
  };

  await getDb()
    .insert(lineReviews)
    .values({ projectId, lineKey: line.key, lineNumber: line.lineNumber, ...review })
    .onConflictDoUpdate({ target: [lineReviews.projectId, lineReviews.lineKey], set: review });
  refresh(projectId);
}

// ---- Check prints ----------------------------------------------------------
//
// The error count is worked out HERE, from the same report the designer is sent,
// not taken from the page: the page can be stale, and Final on a line that has
// gained an error would be a sign-off nobody checked.

async function lineErrorCount(projectId: string, line: NonNullable<ReturnType<typeof findLine>>): Promise<number> {
  const report = buildIsoReport(await summariseLine(projectId, line));
  if (!report) throw new Error("This line's checks could not be run, so it cannot be issued.");
  return report.totals.all;
}

async function recordCheckPrint(
  projectId: string,
  line: NonNullable<ReturnType<typeof findLine>>,
  session: Awaited<ReturnType<typeof requireSession>>,
  print: { kind: "cp" | "final"; seq: number; errorCount: number }
) {
  await getDb()
    .insert(lineCheckPrints)
    .values({
      projectId,
      lineKey: line.key,
      lineNumber: line.lineNumber,
      ...print,
      isoRevision: line.revision,
      isoDocumentIds: line.documentIds,
      issuedBy: session.id,
      issuedByName: session.name ?? session.email,
    });
}

// Issue the next check print -- CP-01 .. CP-03 -- on a line that still has errors.
export async function issueCheckPrint(projectId: string, lineNumber: string) {
  const session = await requireSession();
  if (session.isDcc) throw new Error(CHECKERS_ONLY);
  const line = findLine(await isoLinesOf(projectId), lineNumber);
  if (!line) throw new Error("That line is not in this project.");

  const errorCount = await lineErrorCount(projectId, line);
  const next = nextStep((await checkPrintsOf(projectId)) ?? [], line, errorCount);
  if (next.step === "final") throw new Error("This line has no errors -- issue it Final instead.");
  if (next.step === "waiting") throw new Error(`${next.label} was already issued on this ISO revision. Wait for the revised ISO.`);
  if (next.step === "blocked") throw new Error(`All ${MAX_CHECK_PRINTS} check prints have been issued. Final needs the remaining errors fixed.`);

  await recordCheckPrint(projectId, line, session, { kind: "cp", seq: Number(next.label.slice(3)), errorCount });
  refresh(projectId);
}

// Issue the line Final: only with zero errors, and it marks the line done.
export async function issueFinal(projectId: string, lineNumber: string) {
  const session = await requireSession();
  if (session.isDcc) throw new Error(CHECKERS_ONLY);
  const line = findLine(await isoLinesOf(projectId), lineNumber);
  if (!line) throw new Error("That line is not in this project.");

  const errorCount = await lineErrorCount(projectId, line);
  if (errorCount > 0) throw new Error(`Final needs zero errors; this line still has ${errorCount}.`);

  await recordCheckPrint(projectId, line, session, { kind: "final", seq: 0, errorCount: 0 });
  await markLineReviewed(projectId, lineNumber);
}

// Take a line back out of "done". Matched on the number alone, so a line whose
// drawing has since been removed can still be reopened.
export async function reopenLine(projectId: string, lineNumber: string) {
  const session = await requireSession();
  if (session.isDcc) throw new Error(CHECKERS_ONLY);

  await getDb()
    .delete(lineReviews)
    .where(and(eq(lineReviews.projectId, projectId), eq(lineReviews.lineKey, lineKey(lineNumber))));
  refresh(projectId);
}
