"use server";

import { revalidatePath } from "next/cache";
import { createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { documents, extractionJobs, projects, organizationMembers } from "@easy/db";
import { DOC_TYPES, type DocType } from "@easy/shared";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getDb } from "@/lib/db";
import { getQueue, EXTRACT_DOCUMENT_QUEUE } from "@/lib/queue";

const STORAGE_BUCKET = "documents";

export async function requireProjectMembership(projectId: string, userId: string) {
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
}

export async function uploadDocument(projectId: string, formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated.");
  await requireProjectMembership(projectId, user.id);

  const file = formData.get("file") as File | null;
  const docType = String(formData.get("docType") ?? "") as DocType;
  if (!file || file.size === 0) throw new Error("No file selected.");
  if (!DOC_TYPES.includes(docType)) throw new Error("Invalid document type.");

  const lowerName = file.name.toLowerCase();
  const isCsv = lowerName.endsWith(".csv");
  const isXlsx = lowerName.endsWith(".xlsx");
  const isPdf = lowerName.endsWith(".pdf");
  if (!isCsv && !isPdf && !isXlsx) throw new Error("Only PDF, CSV, and XLSX files are supported.");

  const buffer = Buffer.from(await file.arrayBuffer());
  const fileHash = createHash("sha256").update(buffer).digest("hex");
  const storagePath = `${projectId}/${fileHash}-${file.name}`;

  // Membership is already verified above -- use the admin client to bypass
  // storage.objects' currently-broken authenticated-role RLS path (see
  // lib/supabase/admin.ts).
  const adminStorage = createAdminClient();
  const { error: uploadError } = await adminStorage.storage.from(STORAGE_BUCKET).upload(storagePath, buffer, {
    contentType: isCsv ? "text/csv" : isXlsx ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf",
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
