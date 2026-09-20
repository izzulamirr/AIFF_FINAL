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
  // Step 2 of a User's guided path (Organization -> Project -> Features)
  // arrives with ?org=<id> from the organization card just clicked, and shows
  // only that one. Without it -- Document Control's sidebar link -- every
  // organization it belongs to is listed, as before.
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
        description={orgFilter ? "Choose a project to open its documents and review tools." : "Drawings and their extraction results, grouped by project."}
        back={orgFilter ? { href: "/organizations", label: "Organizations" } : undefined}
      />

      {orgFilter && scopedOrgs.length === 0 && (
        <div className="card">
          <EmptyState icon={<IconBuilding />} title="Organization not found">
            It may have been removed, or you may not have access to it.
          </EmptyState>
        </div>
      )}

      {projectsByOrg.map(({ organization, projects: orgProjects }) => (
        <section key={organization.id} className="card card-flush">
          {/* Scoped to one organization, the page title already names it -- a
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
              title="You need an organization first"
              action={
                <Link href="/organizations" className="btn btn-primary btn-sm mt-1">
                  Choose or create one
                </Link>
              }
            >
              Projects belong to an organization.
            </EmptyState>
          ) : (
            <EmptyState icon={<IconBuilding />} title="No projects yet">
              Document Control creates the projects and uploads the drawings. They will appear here once there are some.
            </EmptyState>
          )}
        </div>
      )}
    </div>
  );
}
