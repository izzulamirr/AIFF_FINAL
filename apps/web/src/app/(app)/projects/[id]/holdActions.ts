"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { documents, itemHolds } from "@easy/db";
import { getDb } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { requireProjectMembership } from "./actions";

// Marking a BOM item ON HOLD or PENDING by hand -- for a hold the drawing does not
// print: client data promised by email, a vendor datasheet not yet in, a decision
// still open. See lib/pending.ts.
//
// Anyone who can work in the project can mark one, checker or Document Control:
// it is the checker who finds the item cannot be checked yet. A remark is
// required, because a bare "pending" in a report issued to the client answers
// nothing.

const MAX_REMARK = 500;

async function authorise(projectId: string, documentId: string) {
  const session = await getSessionUser();
  if (!session) throw new Error("Not authenticated.");
  await requireProjectMembership(projectId, session.id);
  // The document has to belong to the project named -- otherwise a project you
  // are in could be used to write against a document in one you are not.
  const [doc] = await getDb()
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.projectId, projectId)))
    .limit(1);
  if (!doc) throw new Error("That document is not in this project.");
  return session;
}

function refresh(projectId: string) {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/report`);
  revalidatePath("/review");
}

export async function setItemHold(projectId: string, documentId: string, itemKey: string, formData: FormData) {
  const session = await authorise(projectId, documentId);

  const status = String(formData.get("status") ?? "");
  if (status !== "pending" && status !== "hold") throw new Error("Choose Pending or On hold.");
  const remark = String(formData.get("remark") ?? "")
    .trim()
    .slice(0, MAX_REMARK);
  if (!remark) throw new Error("Say what it is waiting on -- the remark goes into the report.");

  const values = { status, remark, markedBy: session.id, markedByName: session.name ?? session.email, markedAt: new Date() };
  await getDb()
    .insert(itemHolds)
    .values({ documentId, itemKey, projectId, ...values })
    .onConflictDoUpdate({ target: [itemHolds.documentId, itemHolds.itemKey], set: values });
  refresh(projectId);
}

export async function clearItemHold(projectId: string, documentId: string, itemKey: string) {
  await authorise(projectId, documentId);
  await getDb()
    .delete(itemHolds)
    .where(and(eq(itemHolds.documentId, documentId), eq(itemHolds.itemKey, itemKey)));
  refresh(projectId);
}
