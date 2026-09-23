"use server";

import { revalidatePath } from "next/cache";
import { createHash, randomUUID } from "node:crypto";
import { eq, and, or } from "drizzle-orm";
import { documents, extractionJobs, findings, libraryItems, projects, organizationMembers } from "@easy/db";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertDcc } from "@/lib/roles";
import { getDb } from "@/lib/db";
import { getQueue, EXTRACT_DOCUMENT_QUEUE } from "@/lib/queue";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from "@/lib/uploadLimits";
import { contentTypeOf, extensionOfFile, formatMismatch, kindByKey, kindOfDocument, labelForDocument, uploadFormatProblem } from "@/lib/docTypes";
import { LIBRARY_PREFIX } from "@/lib/libraryKinds";

const STORAGE_BUCKET = "documents";

/** Throws unless this account belongs to the project's organization; returns that organization's id. */
export async function requireProjectMembership(projectId: string, userId: string): Promise<string> {
  const db = getDb();
  const [row] = await db
    .select({ organizationId: projects.organizationId })
    .from(projects)
    .innerJoin(
      organizationMembers,
      and(eq(organizationMembers.organizationId, projects.organizationId), eq(organizationMembers.userId, userId))
    )
    .where(eq(projects.id, projectId));
  if (!row) throw new Error("Not a member of this project's organization.");
  return row.organizationId;
}

// Deletes a document and everything derived from it. document_pages,
// extraction_jobs, extraction_results and extracted_tags cascade from
// documents, but findings do NOT: findings.doc_a_id/doc_b_id are plain
// references with no ON DELETE, so a document that has raised any finding
// cannot be deleted until those rows go first. They are derived data --
// re-running Verify regenerates them -- so removing them here is safe.
// The Storage object also has to go by hand, or every deleted document
// leaves its file orphaned in the bucket forever.
export async function deleteDocument(projectId: string, documentId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated.");
  assertDcc(user, "delete documents");
  await requireProjectMembership(projectId, user.id);

  const db = getDb();
  const [document] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!document) throw new Error("Document not found.");
  // Membership is checked against the URL's project, so a document belonging
  // to a different project must not be deletable through it.
  if (document.projectId !== projectId) throw new Error("Document does not belong to this project.");

  const adminStorage = createAdminClient();
  const { error: removeError } = await adminStorage.storage.from(STORAGE_BUCKET).remove([document.storagePath]);
  // A missing object is fine -- some documents were seeded without a file --
  // but a real storage failure should not leave the row behind, so surface it.
  if (removeError && !/not found/i.test(removeError.message)) {
    throw new Error(`Storage delete failed: ${removeError.message}`);
  }

  await db.delete(findings).where(or(eq(findings.docAId, documentId), eq(findings.docBId, documentId)));
  await db.delete(documents).where(eq(documents.id, documentId));
  revalidatePath(`/projects/${projectId}`);
}

export async function uploadDocument(projectId: string, formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated.");
  assertDcc(user, "upload documents");
  await requireProjectMembership(projectId, user.id);

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) throw new Error("No file selected.");

  // An upload KIND, not a document type: two kinds store as `spec_sheet` and
  // are told apart by format (see lib/docTypes.ts), so the form has to say which
  // one it meant rather than leaving the server to guess from the file.
  const kind = kindByKey(String(formData.get("uploadKind") ?? ""));
  if (!kind) throw new Error("Invalid document type.");
  const docType = kind.docType;
  // Checked explicitly so an oversized file reports its own size instead of
  // surfacing the framework's generic body-limit error. Must stay in step
  // with next.config.ts's serverActions.bodySizeLimit.
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File is ${(file.size / 1024 / 1024).toFixed(1)} MB -- the upload limit is ${MAX_UPLOAD_MB} MB.`);
  }

  // What format this KIND arrives in, from the same table the upload inputs use
  // for their `accept`. A browser's accept can be switched off in the file
  // dialog, so this is the check that actually decides.
  const problem = uploadFormatProblem(kind, file.name);
  if (problem) throw new Error(problem);

  const buffer = Buffer.from(await file.arrayBuffer());
  const fileHash = createHash("sha256").update(buffer).digest("hex");
  const storagePath = `${projectId}/${fileHash}-${file.name}`;

  // Membership is already verified above -- use the admin client to bypass
  // storage.objects' currently-broken authenticated-role RLS path (see
  // lib/supabase/admin.ts).
  const adminStorage = createAdminClient();
  const { error: uploadError } = await adminStorage.storage.from(STORAGE_BUCKET).upload(storagePath, buffer, {
    contentType: contentTypeOf(file.name),
    upsert: false,
  });
  // Ignore "already exists" -- same dedup-by-hash idea as AIFF's
  // client_spec_documents.file_hash; a re-upload of an identical file is a
  // safe no-op on the Storage side, the documents.unique(project,hash)
  // constraint below is what actually enforces dedup at the data layer.
  if (uploadError && !uploadError.message.includes("already exists")) {
    throw new Error(`Storage upload failed: ${uploadError.message}`);
  }

  const db = getDb();
  let [document] = await db
    .insert(documents)
    .values({
      projectId,
      docType,
      fileName: file.name,
      fileHash,
      storagePath,
      uploadedBy: user.id,
    })
    .onConflictDoNothing({ target: [documents.projectId, documents.fileHash] })
    .returning();

  if (!document) {
    // Already uploaded (unique constraint hit) -- re-uploading the same
    // file is how a user retries a failed extraction, so enqueue a fresh
    // job for the existing document instead of silently doing nothing.
    [document] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.projectId, projectId), eq(documents.fileHash, fileHash)));
    if (!document) throw new Error("Document lookup failed after duplicate upload.");
  }

  const [job] = await db.insert(extractionJobs).values({ documentId: document.id }).returning();

  const queueConnectionString = process.env.DATABASE_URL!;
  const boss = await getQueue(queueConnectionString);
  await boss.send(EXTRACT_DOCUMENT_QUEUE, { documentId: document.id, extractionJobId: job.id });

  revalidatePath(`/projects/${projectId}`);
}

/**
 * Move a document into its project's library.
 *
 * For the one case the format rule creates: a document stored as a type it does
 * not fit. A pipe spec that arrived as a PDF is the CLIENT's document --
 * reference to keep, not a spec table to check a bill of material against --
 * and uploading one is now refused (see lib/docTypes.ts). The ones already
 * stored before that rule existed need somewhere to go, and deleting them
 * throws away a file somebody uploaded on purpose.
 *
 * Deliberately NARROW: only a document that FAILS its type's format rule can be
 * moved. It is a correction, not a general way to take a document out of the
 * checks -- a valid ISO cannot be quietly turned into an inert file this way.
 *
 * ORDER MATTERS. The file is COPIED first, then the row is written, then the
 * original document and its object are removed. A failure at any step leaves
 * either the document intact or both copies present -- never a library row
 * pointing at a file that has been deleted. The two rows never share a storage
 * path, because deleting either one removes its object and would strand the
 * other.
 */
export async function moveDocumentToLibrary(projectId: string, documentId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated.");
  assertDcc(user, "move documents to the library");
  const organizationId = await requireProjectMembership(projectId, user.id);

  const db = getDb();
  const [document] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!document) throw new Error("Document not found.");
  if (document.projectId !== projectId) throw new Error("Document does not belong to this project.");

  // Only a file that fits NO kind of its type. A spec PDF is not one of these:
  // it is a Client Pipe Spec, it is read, and its extracted data is what the
  // admin-versus-client comparison needs -- moving it here would delete that.
  const problem = formatMismatch(document.docType, document.fileName);
  if (!problem) {
    throw new Error(`${document.fileName} is a valid ${labelForDocument(document.docType, document.fileName)}, so it stays where it is.`);
  }

  const admin = createAdminClient();
  const safeName = document.fileName.replace(/[^\w.\- ]+/g, "_");
  const storagePath = `${LIBRARY_PREFIX}/${organizationId}/${projectId}/${randomUUID()}-${safeName}`;

  const { error: copyError } = await admin.storage.from(STORAGE_BUCKET).copy(document.storagePath, storagePath);
  if (copyError) throw new Error(`Could not copy the file: ${copyError.message}`);

  const extension = extensionOfFile(document.fileName);
  await db.insert(libraryItems).values({
    organizationId,
    projectId,
    // A pipe spec is a specification whoever wrote it; anything else moved this
    // way is reference material with no better home.
    category: kindOfDocument(document.docType, document.fileName)?.docType === "spec_sheet" ? "specification" : "other",
    title: document.fileName.replace(/\.[^.]+$/, ""),
    description: `Moved from this project's documents: a ${extension.toUpperCase()} is not read as ${labelForDocument(document.docType, document.fileName)}.`,
    fileName: document.fileName,
    storagePath,
    // The size is not on the documents row. Zero would read as an empty file, so
    // the real size is asked of Storage and only falls back if it cannot answer.
    sizeBytes: await sizeOfStoredFile(admin, storagePath),
    contentType: contentTypeOf(document.fileName),
    uploadedBy: user.id,
    uploadedByName: null,
  });

  // Now the document goes, exactly as deleteDocument does it -- findings first,
  // since they do not cascade, then the row, then the original object.
  await db.delete(findings).where(or(eq(findings.docAId, documentId), eq(findings.docBId, documentId)));
  await db.delete(documents).where(eq(documents.id, documentId));
  const { error: removeError } = await admin.storage.from(STORAGE_BUCKET).remove([document.storagePath]);
  if (removeError && !/not found/i.test(removeError.message)) {
    // The move succeeded; a leftover object is untidy, not wrong, and throwing
    // here would report a failure for work that is done.
    console.warn(`Moved ${document.fileName} to the library but could not remove the original: ${removeError.message}`);
  }

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/library");
}

/** A stored object's size in bytes, or 0 where Storage will not say. */
async function sizeOfStoredFile(admin: ReturnType<typeof createAdminClient>, storagePath: string): Promise<number> {
  const slash = storagePath.lastIndexOf("/");
  const { data } = await admin.storage
    .from(STORAGE_BUCKET)
    .list(storagePath.slice(0, slash), { search: storagePath.slice(slash + 1), limit: 1 });
  const size = data?.[0]?.metadata?.size;
  return typeof size === "number" ? size : 0;
}
