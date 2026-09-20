"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { lineReviews, projectLineTotals } from "@easy/db";
import { getDb } from "@/lib/db";
import { findLine, isoLinesOf, lineKey } from "@/lib/isoLines";
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
// ISO actually carries -- so nothing can be marked that is not there. Marking a
// line that is already done leaves the first review as it was.
export async function markLineReviewed(projectId: string, lineNumber: string) {
  const session = await requireSession();
  if (session.isDcc) throw new Error(CHECKERS_ONLY);

  const line = findLine(await isoLinesOf(projectId), lineNumber);
  if (!line) throw new Error("That line is not in this project.");

  await getDb()
    .insert(lineReviews)
    .values({ projectId, lineKey: line.key, lineNumber: line.lineNumber, reviewedBy: session.id, reviewedByName: session.name ?? session.email })
    .onConflictDoNothing();
  refresh(projectId);
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
