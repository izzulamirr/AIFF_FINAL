import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { documents, organizations, projects } from "@easy/db";
import { activeOrganization, projectOptions } from "@/lib/access";
import { getDb } from "@/lib/db";
import { canReadLibraryOf, libraryItemsOf } from "@/lib/library";
import { getSessionUser } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert, Badge } from "@/components/ui/primitives";
import { IconFile } from "@/components/ui/icons";
import { LibraryTable } from "./LibraryTable";
import { LibraryUploadForm } from "./LibraryUploadForm";

export const metadata: Metadata = { title: "Library" };

// Reference material, in two places:
//
//   the OVERALL library   what every project of the organization draws on --
//                         standards, client specifications, templates
//   a PROJECT library     what belongs to one project -- its legend, its datasheets
//
// Everybody can read and download; only Document Control adds and removes.
//
// Which organization? Document Control's is the one it chose to work in. A checker
// has no such choice remembered, so it comes from the project they followed the
// link from, or from `?org=` -- and is then checked against their memberships by
// `canReadLibraryOf`, which is what stops a typed `?org=` reaching another one.
export default async function LibraryPage({ searchParams }: { searchParams: Promise<{ project?: string; org?: string }> }) {
  const session = await getSessionUser();
  if (!session) return null;

  const { project: requestedProject, org: requestedOrg } = await searchParams;
  const db = getDb();

  // The organization and, if one was asked for, the project inside it.
  let organizationId: string | null = null;
  let organizationName = "";
  if (session.isDcc) {
    const active = await activeOrganization(session);
    if (!active) redirect("/organizations");
    organizationId = active.id;
    organizationName = active.name;
  } else {
    let orgId = requestedOrg ?? null;
    if (!orgId && requestedProject) {
      const [p] = await db.select({ organizationId: projects.organizationId }).from(projects).where(eq(projects.id, requestedProject)).limit(1);
      orgId = p?.organizationId ?? null;
    }
    if (!orgId) redirect("/organizations");
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org) redirect("/organizations");
    organizationId = org.id;
    organizationName = org.name;
  }
  if (!(await canReadLibraryOf(session, organizationId))) redirect("/organizations");

  const orgProjects = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.organizationId, organizationId))
    .orderBy(asc(projects.createdAt), asc(projects.id));
  const options = projectOptions(orgProjects);
  // An id that is not one of this organization's projects is no choice at all,
  // so the page falls back to the overall library.
  const project = requestedProject ? orgProjects.find((p) => p.id === requestedProject) ?? null : null;

  const overall = await libraryItemsOf(organizationId, null);
  const own = project ? await libraryItemsOf(organizationId, project.id) : null;

  // The legend the extraction actually reads lives with the project's documents,
  // not here. Shown so the project library is the whole answer to "what
  // reference material does this project have", without moving anything.
  const legendsInUse = project
    ? await db
        .select()
        .from(documents)
        .where(and(eq(documents.projectId, project.id), eq(documents.docType, "pid_legend")))
    : [];

  const scopeHref = (id?: string) => (id ? `/library?project=${id}` : `/library${session.isDcc ? "" : `?org=${organizationId}`}`);
  const back = !session.isDcc && project ? { href: `/projects/${project.id}`, label: project.name } : undefined;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Library"
        back={back}
        meta={<Badge>{organizationName}</Badge>}
        description="Legends, specifications, standards and templates. The overall library is shared by every project; each project also keeps its own."
      />

      {/* Which library. Every project is one link, so switching is a click, not a form. */}
      <nav aria-label="Library" className="flex flex-wrap gap-2">
        {[{ id: undefined as string | undefined, label: "All projects" }, ...options].map(({ id, label }) => {
          const active = (project?.id ?? undefined) === id;
          return (
            <Link
              key={id ?? "all"}
              href={scopeHref(id)}
              aria-current={active ? "page" : undefined}
              className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                active ? "border-transparent bg-primary-soft text-link" : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      {(overall === null || (project && own === null)) && (
        <Alert tone="warning">
          The library has not been set up in the database yet. Run <code>supabase/library.sql</code> in the Supabase SQL editor, then reload.
        </Alert>
      )}

      {project && (
        <>
          <section className="card card-flush">
            <div className="card-header">
              <h2 className="card-title">{project.name} library</h2>
              <p className="card-description">Only for this project.</p>
            </div>
            {legendsInUse.length > 0 && (
              <ul className="border-b">
                {legendsInUse.map((doc) => (
                  <li key={doc.id} className="flex flex-wrap items-center gap-2.5 px-5 py-3 text-sm">
                    <IconFile size={15} className="flex-none text-muted-foreground" />
                    <span className="break-all font-medium">{doc.fileName}</span>
                    <Badge tone="info">P&amp;ID legend</Badge>
                    <span className="text-xs text-muted-foreground">read by this project&apos;s P&amp;ID extraction</span>
                    {session.isDcc && (
                      <Link href={`/projects/${project.id}/documents/${doc.id}`} className="link ml-auto text-xs">
                        Open
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {own !== null && (
              <LibraryTable
                items={own}
                canEdit={session.isDcc}
                emptyText={session.isDcc ? "Add a file below, or upload the P&ID legend on the project page." : "Document Control has not added anything for this project."}
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
        </>
      )}

      {overall !== null && (
        <section className="card card-flush">
          <div className="card-header">
            <h2 className="card-title">Overall library</h2>
            <p className="card-description">Shared by every project in {organizationName}.</p>
          </div>
          <LibraryTable
            items={overall}
            canEdit={session.isDcc && !project}
            emptyText={session.isDcc ? "Add standards, client specifications or templates below." : "Document Control has not added anything yet."}
          />
          {session.isDcc && project && (
            <p className="border-t px-5 py-3 text-sm text-muted-foreground">
              <Link href={scopeHref()} className="link">
                Open the overall library
              </Link>{" "}
              to add or remove files here.
            </p>
          )}
        </section>
      )}

      {session.isDcc && !project && overall !== null && (
        <LibraryUploadForm
          organizationId={organizationId}
          heading="Add to the overall library"
          description={`Available to every project in ${organizationName}.`}
        />
      )}
    </div>
  );
}
