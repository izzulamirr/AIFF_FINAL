import type { Metadata } from "next";
import Link from "next/link";
import { projects } from "@easy/db";
import { getSessionUser } from "@/lib/session";
import { visibleOrganizations } from "@/lib/access";
import { getDb } from "@/lib/db";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { IconBuilding, IconChevronRight, IconFolder, IconPlus } from "@/components/ui/icons";
import { createProject } from "../actions";

export const metadata: Metadata = { title: "Projects" };

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: orgFilter } = await searchParams;
  const session = await getSessionUser();
  if (!session) return null;

  const db = getDb();

  const orgs = await visibleOrganizations(session);
  // Step 3 of a checker's path (client -> PROJECT -> the line) arrives with
  // ?org=<id> from the client card just clicked, and shows only that client.
  // Without it -- Document Control's sidebar link -- every client it belongs to
  // is listed, as before.
  const scopedOrgs = orgFilter ? orgs.filter((o) => o.id === orgFilter) : orgs;

  const projectRows = await db.select().from(projects);
  const projectsByOrg = scopedOrgs.map((organization) => ({
    organization,
    projects: projectRows.filter((p) => p.organizationId === organization.id),
  }));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={orgFilter ? (scopedOrgs[0]?.name ?? "Projects") : "Projects"}
        description={orgFilter ? "Choose a project to open its drawings, ISO checking and cutting plan." : "Every project, grouped by client."}
        back={orgFilter ? { href: "/clients", label: "Clients" } : undefined}
      />

      {orgFilter && scopedOrgs.length === 0 && (
        <div className="card">
          <EmptyState icon={<IconBuilding />} title="Client not found">
            It may have been removed, or you may not have access to it.
          </EmptyState>
        </div>
      )}

      {projectsByOrg.map(({ organization, projects: orgProjects }) => (
        <section key={organization.id} className="card card-flush">
          {/* Scoped to one client, the page title already names it -- a
              second heading here would just repeat it. */}
          {!orgFilter && (
            <div className="card-header">
              <div className="flex items-center gap-2.5">
                <IconBuilding size={17} className="text-muted-foreground" />
                <h2 className="card-title">{organization.name}</h2>
                <Badge>
                  {orgProjects.length} project{orgProjects.length === 1 ? "" : "s"}
                </Badge>
              </div>
            </div>
          )}

          {orgProjects.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">No projects yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {orgProjects.map((project) => (
                <li key={project.id}>
                  <Link
                    href={`/projects/${project.id}`}
                    className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-muted/60"
                  >
                    <IconFolder size={17} className="text-muted-foreground" />
                    <span className="font-medium">{project.name}</span>
                    <IconChevronRight size={16} className="ml-auto text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {session.isDcc && (
            <form action={createProject} className="flex flex-col gap-2 border-t bg-muted/40 px-5 py-4 sm:flex-row sm:items-center">
              <input type="hidden" name="organizationId" value={organization.id} />
              <input name="name" placeholder="New project name" required aria-label="New project name" className="input sm:max-w-xs" />
              <button className="btn btn-primary">
                <IconPlus size={16} />
                Create project
              </button>
            </form>
          )}
        </section>
      ))}

      {!orgFilter && orgs.length === 0 && (
        <div className="card">
          {session.isDcc ? (
            <EmptyState
              icon={<IconBuilding />}
              title="You need a client first"
              action={
                <Link href="/clients" className="btn btn-primary btn-sm mt-1">
                  Choose or create one
                </Link>
              }
            >
              Projects belong to a client.
            </EmptyState>
          ) : (
            <EmptyState icon={<IconBuilding />} title="You're not assigned to a client yet">
              Projects belong to a client, and you see the clients you have been added to. Ask Document Control to add you to yours.
            </EmptyState>
          )}
        </div>
      )}
    </div>
  );
}
