import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { libraryItems } from "@easy/db";
import { getDb } from "@/lib/db";
import { canReadLibraryOf } from "@/lib/library";
import { getSessionUser } from "@/lib/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { isMissingTable } from "@/lib/progress";

// Hands a library file to someone allowed to read it.
//
// The bucket is private, so a file has no public address. This checks who is
// asking, then redirects to a signed link that stops working after a minute --
// long enough to start the download, too short to be passed around.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionUser();
  if (!session) return new NextResponse("Not signed in.", { status: 401 });

  const { id } = await params;
  // Not a uuid: no row could match, and Postgres would answer with an error.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return new NextResponse("File not found.", { status: 404 });
  }

  let item: typeof libraryItems.$inferSelect | undefined;
  try {
    [item] = await getDb().select().from(libraryItems).where(eq(libraryItems.id, id)).limit(1);
  } catch (err) {
    if (isMissingTable(err)) return new NextResponse("File not found.", { status: 404 });
    throw err;
  }
  // The same answer for "no such file" and "not yours", so ids cannot be probed.
  if (!item || !(await canReadLibraryOf(session, item.organizationId))) {
    return new NextResponse("File not found.", { status: 404 });
  }

  const { data, error } = await createAdminClient()
    .storage.from("documents")
    .createSignedUrl(item.storagePath, 60, { download: item.fileName });
  if (error || !data) return new NextResponse("The file could not be retrieved.", { status: 502 });

  return NextResponse.redirect(data.signedUrl);
}
