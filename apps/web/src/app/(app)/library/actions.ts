"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { libraryItems, projects } from "@easy/db";
import { getDb } from "@/lib/db";
import { createAdminClient } from "@/lib/supabase/admin";
import { extensionOf, isLibraryCategory, LIBRARY_EXTENSIONS, LIBRARY_PREFIX, canReadLibraryOf } from "@/lib/library";
import { getSessionUser } from "@/lib/session";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from "@/lib/uploadLimits";

// Adding to and removing from a library. Document Control's only: a checker reads
// the library and downloads from it, and changes nothing. The pages hide the
// controls from a checker; these are what refuse.

const STORAGE_BUCKET = "documents";

export interface UploadState {
  error?: string;
  /** Set on success, so the form can say what was added. */
  added?: string;
}

async function requireDcc() {
  const session = await getSessionUser();
  if (!session) throw new Error("Not authenticated.");
  if (!session.isDcc) throw new Error("Only Document Control (DCC) can change the library.");
  return session;
}

// The form reports its own problems in place, so a wrong file or a missing title
// is a message beside the button rather than the framework's error page.
export async function addLibraryItem(_previous: UploadState, formData: FormData): Promise<UploadState> {
  try {
    const session = await requireDcc();

    const organizationId = String(formData.get("organizationId") ?? "");
    const projectId = String(formData.get("projectId") ?? "") || null;
    const category = String(formData.get("category") ?? "");
    const description = String(formData.get("description") ?? "").trim() || null;
    const file = formData.get("file") as File | null;

    if (!organizationId) throw new Error("No organization chosen.");
    if (!(await canReadLibraryOf(session, organizationId))) throw new Error("You are not a member of this organization.");
    if (!isLibraryCategory(category)) throw new Error("Choose what kind of file this is.");
    if (!file || file.size === 0) throw new Error("No file selected.");
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`File is ${(file.size / 1024 / 1024).toFixed(1)} MB -- the upload limit is ${MAX_UPLOAD_MB} MB.`);
    }

    const extension = extensionOf(file.name);
    if (!(extension in LIBRARY_EXTENSIONS)) {
      throw new Error(`.${extension || "?"} files are not accepted. Use ${Object.keys(LIBRARY_EXTENSIONS).join(", ")}.`);
    }

    const db = getDb();
    // A project's library has to belong to the organization the form named, or a
    // crafted request could file a document under somebody else's project.
    if (projectId) {
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
        .limit(1);
      if (!project) throw new Error("That project is not in this organization.");
    }

    const title = String(formData.get("title") ?? "").trim() || file.name.replace(/\.[^.]+$/, "");
    // A random id in the path rather than a hash: two people can file the same
    // drawing under different titles, and neither should overwrite the other.
    const safeName = file.name.replace(/[^\w.\- ]+/g, "_");
    const storagePath = `${LIBRARY_PREFIX}/${organizationId}/${projectId ?? "all"}/${randomUUID()}-${safeName}`;

    // Membership is checked above; the admin client is the upload route for the
    // same reason as document uploads (see lib/supabase/admin.ts).
    const { error: uploadError } = await createAdminClient()
      .storage.from(STORAGE_BUCKET)
      .upload(storagePath, Buffer.from(await file.arrayBuffer()), { contentType: LIBRARY_EXTENSIONS[extension], upsert: false });
    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

    await db.insert(libraryItems).values({
      organizationId,
      projectId,
      category,
      title,
      description,
      fileName: file.name,
      storagePath,
      sizeBytes: file.size,
      contentType: LIBRARY_EXTENSIONS[extension],
      uploadedBy: session.id,
      uploadedByName: session.name ?? session.email,
    });

    revalidatePath("/library");
    return { added: title };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The upload failed." };
  }
}

export async function deleteLibraryItem(itemId: string) {
  const session = await requireDcc();
  const db = getDb();

  const [item] = await db.select().from(libraryItems).where(eq(libraryItems.id, itemId)).limit(1);
  if (!item) throw new Error("File not found.");
  if (!(await canReadLibraryOf(session, item.organizationId))) throw new Error("You are not a member of this organization.");

  // The stored file goes first, so a failure leaves the row and the file together
  // rather than a listing that points at nothing. A file already gone is fine.
  const { error } = await createAdminClient().storage.from(STORAGE_BUCKET).remove([item.storagePath]);
  if (error && !/not found/i.test(error.message)) throw new Error(`Storage delete failed: ${error.message}`);

  await db.delete(libraryItems).where(eq(libraryItems.id, itemId));
  revalidatePath("/library");
}
