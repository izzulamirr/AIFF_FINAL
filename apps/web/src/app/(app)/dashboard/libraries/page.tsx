import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { inArray } from "drizzle-orm";
import { documents, extractionJobs } from "@easy/db";
import { resolveDocumentVersions, type DocumentVersion } from "@easy/shared";
import { getDb } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { activeOrganization, activeProjectsOf } from "@/lib/access";
import { isLibraryDocument } from "@/lib/docTypes";
import { libraryItemsOfClient } from "@/lib/library";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { IconLibrary } from "@/components/ui/icons";
import { KeptLibrarySection, ReferenceLibrarySection, type LibraryItemEntry, type ReferenceDocEntry } from "../ClientLibrary";

export const metadata: Metadata = { title: "Overall libraries" };

// The reverse cut from the Dashboard's own project rows: not "what does
// YAMAMA hold", but "what does this client hold, of each kind" -- across
// every project at once, grouped by type. No single project's own Library
// page can show this, since each of those is scoped to one project.
//
// This used to render inline on the Dashboard, and it was too much: a long,
// business-detail-heavy listing sitting under what is meant to be a quick
// "where does the job stand" overview. Dashboard now carries one button to
// here instead -- the same move already made for ISO checking and the
// Cutting Plan, kept off the hub and reached by a click.
//
// Read-only, same as before: uploading, deleting and moving a document stay
// on the page each file actually belongs to (a project's own page, or its
// Library page).
export default async function OverallLibrariesPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const { type: requestedType } = await searchParams;
  const session = await getSessionUser();
  if (!session) return null;
  if (!session.isDcc) redirect("/clients");

  const client = await activeOrganization(session);
  const clientProjects = await activeProjectsOf(session);

  if (!client || clientProjects.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Overall libraries" back={{ href: "/dashboard", label: "Dashboard" }} />
        <div className="card">
          <EmptyState icon={<IconLibrary />} title="No projects yet">
            Reference belongs to a project, and this client has none yet.
          </EmptyState>
        </div>
      </div>
    );
  }

  const db = getDb();
  const projectIds = clientProjects.map((p) => p.id);
  const projectNameOf = new Map(clientProjects.map((p) => [p.id, p.name]));

  const allProjectDocs = await db.select().from(documents).where(inArray(documents.projectId, projectIds));
  const referenceDocRows = allProjectDocs.filter((d) => isLibraryDocument(d.docType, d.fileName));

  const referenceJobs = referenceDocRows.length
    ? await db.select().from(extractionJobs).where(inArray(extractionJobs.documentId, referenceDocRows.map((d) => d.id)))
    : [];
  const latestJobByDoc = new Map<string, (typeof referenceJobs)[number]>();
  for (const job of referenceJobs) {
    const existing = latestJobByDoc.get(job.documentId);
    if (!existing || job.createdAt > existing.createdAt) latestJobByDoc.set(job.documentId, job);
  }

  // Revisions per PROJECT: two projects can each hold a file of the same name,
  // and those are two documents, not one replacing the other.
  const versions = new Map<string, DocumentVersion>();
  for (const projectId of projectIds) {
    for (const [docId, v] of resolveDocumentVersions(referenceDocRows.filter((d) => d.projectId === projectId))) versions.set(docId, v);
  }

  const referenceDocs: ReferenceDocEntry[] = referenceDocRows.map((d) => ({
    id: d.id,
    fileName: d.fileName,
    docType: d.docType,
    pageCount: d.pageCount,
    projectId: d.projectId,
    projectName: projectNameOf.get(d.projectId) ?? "Unknown project",
    job: latestJobByDoc.get(d.id),
    uploadedAt: d.uploadedAt,
    version: versions.get(d.id) ?? null,
  }));

  // Null means the library tables do not exist yet (see lib/library.ts).
  const clientLibraryItems = await libraryItemsOfClient(client.id);
  const libraryItemEntries: LibraryItemEntry[] | null =
    clientLibraryItems && clientLibraryItems.map((item) => ({ ...item, projectName: item.projectId ? (projectNameOf.get(item.projectId) ?? "Unknown project") : null }));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Overall libraries"
        back={{ href: "/dashboard", label: "Dashboard" }}
        description={`Every P&ID, spec and template ${client.name} holds, across all of its projects, grouped by type.`}
        meta={<Badge>{client.name}</Badge>}
      />

      <ReferenceLibrarySection clientName={client.name} docs={referenceDocs} activeType={requestedType ?? null} basePath="/dashboard/libraries" />
      <KeptLibrarySection clientName={client.name} items={libraryItemEntries} />
    </div>
  );
}
