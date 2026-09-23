import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, eq, inArray } from "drizzle-orm";
import { documents, extractionJobs, organizations, projects } from "@easy/db";
import { activeOrganization } from "@/lib/access";
import { getDb } from "@/lib/db";
import { isLibraryDocument, labelForDocument } from "@/lib/docTypes";
import { canReadLibraryOf, libraryItemsOf } from "@/lib/library";
import { getSessionUser } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert, Badge, EmptyState, JobStatus } from "@/components/ui/primitives";
import { IconFile, IconFolder } from "@/components/ui/icons";
import { uploadDocument } from "../projects/[id]/actions";
import { LibraryTable } from "./LibraryTable";
import { LibraryUploadForm } from "./LibraryUploadForm";
import { ReferenceUploadCard } from "./ReferenceUploadCard";

export const metadata: Metadata = { title: "Library" };

// ONE PROJECT'S library, and nothing to switch it to.
//
// This used to carry its own picker -- "All projects" plus a button per
// project of the client -- so the library could be browsed for a project other
// than the one you had open, or for none at all. That fought the rest of the
// app: everywhere else the project is chosen once (dashboard -> project) and
// everything from there on is scoped to it without asking again. Reaching this
// page by a link that named a DIFFERENT project than the one you were just
// looking at was the one way to end up reviewing the wrong project's reference
// without meaning to -- exactly what happened when a project shared a name with
// its own client.
//
// So there is no picker. `?project=` says which project, exactly as it does for
// ISO checking and the Cutting Plan; without one (the sidebar's bare
// `/library`), it falls back to the client's first project, the same silent
// fallback those two use.
//
// Reference material still comes in two kinds:
//
//   THIS PROJECT'S reference   its P&ID, legend, line list -- read by the app
//   THE CLIENT'S library       standards, client specs, templates -- kept, not
//                              read, and shared by every project of the client
//
// Everybody can read and download; only Document Control adds and removes.
export default async function LibraryPage({ searchParams }: { searchParams: Promise<{ project?: string; org?: string }> }) {
  const session = await getSessionUser();
  if (!session) return null;

  const { project: requestedProject, org: requestedOrg } = await searchParams;
  const db = getDb();

  // The client. Document Control's is the one it chose to work for; a checker
  // has no such choice remembered, so it comes from the project they followed
  // the link from, or from `?org=` for the sidebar-less bare case.
  let organizationId: string | null = null;
  let organizationName = "";
  if (session.isDcc) {
    const active = await activeOrganization(session);
    if (!active) redirect("/clients");
    organizationId = active.id;
    organizationName = active.name;
  } else {
    let orgId = requestedOrg ?? null;
    if (!orgId && requestedProject) {
      const [p] = await db.select({ organizationId: projects.organizationId }).from(projects).where(eq(projects.id, requestedProject)).limit(1);
      orgId = p?.organizationId ?? null;
    }
    if (!orgId) redirect("/clients");
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org) redirect("/clients");
    organizationId = org.id;
    organizationName = org.name;
  }
  if (!(await canReadLibraryOf(session, organizationId))) redirect("/clients");

  // The client's projects, ordered stably so "the first one" means the same
  // project on every visit -- the same reasoning /cutting and /review use.
  const clientProjects = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.organizationId, organizationId))
    .orderBy(asc(projects.createdAt), asc(projects.id));

  // The project asked for, if it is one of the client's, else the first.
  const project = clientProjects.find((p) => p.id === requestedProject) ?? clientProjects[0];

  if (!project) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Library" meta={<Badge>{organizationName}</Badge>} />
        <div className="card">
          <EmptyState
            icon={<IconFolder />}
            title="No projects yet"
            action={
              session.isDcc ? (
                <Link href="/projects" className="btn btn-primary btn-sm mt-1">
                  Create one
                </Link>
              ) : undefined
            }
          >
            Library reference belongs to a project, and this client has none yet.
          </EmptyState>
        </div>
      </div>
    );
  }

  const overall = await libraryItemsOf(organizationId, null);
  const own = await libraryItemsOf(organizationId, project.id);

  // The reference this project's checks are read FROM -- P&ID, legend, line
  // list, H&MB, PFD, GA. These are `documents` and they ARE extracted; the
  // library is where they are uploaded and managed, not a different kind of
  // storage. See lib/docTypes.ts for the rule that decides which types these are.
  const referenceDocs = (await db.select().from(documents).where(eq(documents.projectId, project.id))).filter((d) =>
    isLibraryDocument(d.docType, d.fileName)
  );

  // The latest job per document, for the status column -- the same shape the
  // project page builds, since a reference document is read exactly like any
  // other and its progress is worth seeing.
  const referenceJobs = referenceDocs.length
    ? await db.select().from(extractionJobs).where(inArray(extractionJobs.documentId, referenceDocs.map((d) => d.id)))
    : [];
  const latestJob = new Map<string, (typeof referenceJobs)[number]>();
  for (const job of referenceJobs) {
    const existing = latestJob.get(job.documentId);
    if (!existing || job.createdAt > existing.createdAt) latestJob.set(job.documentId, job);
  }

  async function handleReferenceUpload(formData: FormData) {
    "use server";
    await uploadDocument(project!.id, formData);
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Library"
        back={{ href: `/projects/${project.id}`, label: project.name }}
        meta={<Badge>{organizationName}</Badge>}
        description={`What ${project.name}'s checks are made against. Its own reference is read by the app; ${organizationName}'s specifications and standards, shared by every project, are kept and handed back.`}
      />

      {(overall === null || own === null) && (
        <Alert tone="warning">
          The library has not been set up in the database yet. Run <code>supabase/library.sql</code> in the Supabase SQL editor, then reload.
        </Alert>
      )}

      {/* READ BY THE APP, and said so plainly. The library holds two kinds
          of thing and the difference matters: a file in the section below is
          kept and handed back, while one in this section changes what every
          check on this project's ISOs concludes. Somebody deciding whether a
          P&ID is "in" needs to see its extraction status, not just its file
          name. */}
      <section className="card card-flush">
        <div className="card-header">
          <div>
            <h2 className="card-title">Read by the app</h2>
            <p className="card-description">
              What {project.name}&apos;s checks are made against. Each one is extracted, and the P&amp;ID legend should go in before this
              project&apos;s P&amp;IDs.
            </p>
          </div>
          {referenceDocs.length > 0 && <Badge className="ml-auto">{referenceDocs.length}</Badge>}
        </div>

        {referenceDocs.length === 0 ? (
          <EmptyState icon={<IconFile />} title="No reference for this project yet">
            {session.isDcc
              ? "Add the P&ID legend, the line list and this project's P&IDs below."
              : "Document Control has not added any reference for this project."}
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Type</th>
                  <th>Pages</th>
                  <th>Extraction status</th>
                </tr>
              </thead>
              <tbody>
                {referenceDocs.map((doc) => {
                  const job = latestJob.get(doc.id);
                  return (
                    <tr key={doc.id}>
                      <td>
                        <span className="flex items-center gap-2.5">
                          <IconFile size={16} className="flex-none text-muted-foreground" />
                          {session.isDcc && job?.status === "succeeded" ? (
                            <Link href={`/projects/${project.id}/documents/${doc.id}`} className="link break-all font-medium">
                              {doc.fileName}
                            </Link>
                          ) : (
                            <span className="break-all font-medium">{doc.fileName}</span>
                          )}
                        </span>
                      </td>
                      <td>
                        <Badge tone="info">{labelForDocument(doc.docType, doc.fileName)}</Badge>
                      </td>
                      <td className="tabular-nums text-muted-foreground">{doc.pageCount ?? "-"}</td>
                      <td>
                        <JobStatus job={job} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {session.isDcc && <ReferenceUploadCard action={handleReferenceUpload} />}

      <section className="card card-flush">
        <div className="card-header">
          <h2 className="card-title">Kept for reference</h2>
          <p className="card-description">Files for {project.name} that the app stores and hands back, but does not read.</p>
        </div>
        {own !== null && (
          <LibraryTable
            items={own}
            canEdit={session.isDcc}
            emptyText={session.isDcc ? "Add a file below." : "Document Control has not added anything for this project."}
          />
        )}
      </section>

      {session.isDcc && own !== null && (
        <LibraryUploadForm
          organizationId={organizationId}
          projectId={project.id}
          heading={`Add to ${project.name}`}
          description="Kept with this project only."
        />
      )}

      {overall !== null && (
        <section className="card card-flush">
          <div className="card-header">
            <h2 className="card-title">{organizationName}&apos;s library</h2>
            <p className="card-description">
              Shared by every project in {organizationName} &mdash; the client&apos;s own piping specifications, standards and templates.
              Stored and handed back, never read.
            </p>
          </div>
          <LibraryTable
            items={overall}
            canEdit={session.isDcc}
            emptyText={session.isDcc ? "Add standards, client specifications or templates below." : "Document Control has not added anything yet."}
          />
        </section>
      )}

      {session.isDcc && overall !== null && (
        <LibraryUploadForm
          organizationId={organizationId}
          heading={`Add to ${organizationName}'s library`}
          description={`Available to every project in ${organizationName}, not just ${project.name}.`}
        />
      )}
    </div>
  );
}
