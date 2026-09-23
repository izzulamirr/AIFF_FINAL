import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { activeOrganization, activeProjectsOf } from "@/lib/access";
import { progressOfProjects, type ProjectProgress } from "@/lib/progress";
import { ProgressBar } from "@/components/progress/ProgressBar";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert, Badge, EmptyState } from "@/components/ui/primitives";
import { IconBuilding, IconChevronRight, IconFolder, IconLibrary, IconPlus } from "@/components/ui/icons";
import { createProject } from "../actions";
import { TotalLinesForm } from "../projects/[id]/TotalLinesForm";

export const metadata: Metadata = { title: "Dashboard" };

// STEP 3 of the flow: EVERY project of the client, side by side.
//
//   login -> client -> DASHBOARD (every project) -> project -> its work
//
// It used to be about ONE project, picked from a dropdown at the top, with the
// tools for it underneath. That made the dashboard a worse version of the
// project page and gave the picker two jobs -- choosing what to look at AND
// choosing what to work on. Choosing what to work on is a step of its own now
// (open the project), so this page has only the first job and can do it for
// every project at once, which is the thing a dashboard is for: where does the
// job stand.
//
// Nothing opens from here except a project. The work -- uploading, ISO checking,
// the cutting plan -- is inside one, because all of it is scoped to one.

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

/**
 * A project with no progress data to show -- the tables in
 * supabase/line-progress.sql have not been run yet. Still a real row: opening a
 * project cannot depend on a migration that has nothing to do with reaching it,
 * and the alert above already says why the numbers are missing.
 */
function ProjectRow({ project }: { project: { id: string; name: string } }) {
  return (
    <li className="px-5 py-4">
      <Link href={`/projects/${project.id}`} className="group flex items-center gap-2 font-medium">
        <IconFolder size={17} className="flex-none text-muted-foreground" />
        <span className="truncate">{project.name}</span>
        <IconChevronRight size={16} className="flex-none text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </Link>
    </li>
  );
}

/** Create a project for this client, without leaving Dashboard. */
function NewProjectForm({ organizationId, className = "" }: { organizationId: string; className?: string }) {
  return (
    <form action={createProject} className={`flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center ${className}`}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input name="name" placeholder="New project name" required aria-label="New project name" className="input sm:max-w-xs" />
      <button className="btn btn-primary">
        <IconPlus size={16} />
        Create project
      </button>
    </form>
  );
}

function ProjectProgressRow({ project }: { project: ProjectProgress }) {
  // Against the total Document Control stated, or -- until it has stated one --
  // the lines read off the drawings so far, which at least measures something.
  const max = project.total ?? project.uploaded;
  const complete = project.total != null && project.total > 0 && project.done >= project.total && project.recheck === 0;

  return (
    <li className="flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/projects/${project.projectId}`} className="group flex min-w-0 items-center gap-2 font-medium">
          <IconFolder size={17} className="flex-none text-muted-foreground" />
          <span className="truncate">{project.projectName}</span>
          <IconChevronRight size={16} className="flex-none text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </Link>

        <span className="ml-auto flex flex-wrap items-center gap-2">
          {project.recheck > 0 && (
            <Badge tone="warning" dot title="Checked against a drawing a later revision has replaced">
              {project.recheck} to re-check
            </Badge>
          )}
          <Badge tone={complete ? "success" : "neutral"} dot={complete}>
            {project.done} of {project.total ?? project.uploaded} {project.total == null ? "uploaded " : ""}lines checked
          </Badge>
        </span>
      </div>

      <ProgressBar value={project.done} max={max} label={`${project.projectName} lines checked`} />

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <span>{project.uploaded} ISO lines read from the drawings</span>
        {project.reviews[0] && <span>last checked {when.format(project.reviews[0].reviewedAt)}</span>}

        {/* Every percentage on this page is measured against this figure, so it
            is set where the percentages are compared. Also on the project's own
            page, from the same component. */}
        <TotalLinesForm projectId={project.projectId} total={project.total} className="ml-auto" />
      </div>
    </li>
  );
}

export default async function DashboardPage() {
  const session = await getSessionUser();
  if (!session) return null;
  if (!session.isDcc) redirect("/clients");

  const client = await activeOrganization(session);
  const clientProjects = await activeProjectsOf(session);
  // Null means the progress tables do not exist yet (see lib/progress.ts).
  const progress = await progressOfProjects(clientProjects);

  const totals = (progress ?? []).reduce(
    (acc, p) => ({ done: acc.done + p.done, recheck: acc.recheck + p.recheck, lines: acc.lines + (p.total ?? p.uploaded) }),
    { done: 0, recheck: 0, lines: 0 }
  );

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Dashboard"
        description="Where every project of this client stands. Open one to upload drawings, check its ISOs and plan its cutting."
        meta={
          client && (
            <Badge>
              <IconBuilding size={13} />
              {client.name}
            </Badge>
          )
        }
        actions={
          // The client-wide roll-up (every P&ID, spec and template this
          // client holds, across all of its projects) used to render here in
          // full -- too much detail for a page meant to answer "where does
          // the job stand" at a glance. Kept off the hub and reached by a
          // click instead, the same move already made for ISO checking and
          // the Cutting Plan.
          <Link href="/dashboard/libraries" className="btn btn-secondary">
            <IconLibrary size={16} />
            Overall libraries
          </Link>
        }
      />

      {clientProjects.length === 0 ? (
        <div className="card flex flex-col gap-4">
          <EmptyState icon={<IconFolder />} title="No projects yet">
            Create a project, enter how many lines it holds, and its progress appears here.
          </EmptyState>
          {/* Inline, not a link to a separate page -- Dashboard is the one place
              a project is created or opened, so there is nowhere else this
              should send you. */}
          {client && <NewProjectForm organizationId={client.id} />}
        </div>
      ) : (
        <>
          {/* Missing progress tables is a reason the NUMBERS are absent, not a
              reason the project list should be. Opening a project is how you
              reach the whole job (upload, ISO checking, the cutting plan) -- it
              must not wait on a migration it does not need. */}
          {progress === null && (
            <Alert tone="warning">
              Progress tracking needs a one-time database update before it can store anything. Run{" "}
              <span className="font-mono">supabase/line-progress.sql</span> in the Supabase SQL editor; it only adds two tables and is
              safe to run more than once. Every project below still opens.
            </Alert>
          )}

          <section className="card card-flush">
            <div className="card-header">
              <h2 className="card-title">
                Projects <span className="font-normal text-muted-foreground">({clientProjects.length})</span>
              </h2>
              {progress !== null && (
                <span className="flex flex-wrap items-center gap-2">
                  {totals.recheck > 0 && (
                    <Badge tone="warning" dot>
                      {totals.recheck} to re-check
                    </Badge>
                  )}
                  <Badge>
                    {totals.done} of {totals.lines} lines checked across this client
                  </Badge>
                </span>
              )}
            </div>
            <ul className="divide-y divide-border">
              {progress !== null
                ? progress.map((p) => <ProjectProgressRow key={p.projectId} project={p} />)
                : clientProjects.map((p) => <ProjectRow key={p.id} project={p} />)}
            </ul>

            {/* Creating a project is the other half of what the removed
                "Projects" nav link used to be for -- kept here, at the foot of
                the list it adds to, rather than on a page of its own. */}
            {client && <NewProjectForm organizationId={client.id} className="border-t bg-muted/40" />}
          </section>
        </>
      )}
    </div>
  );
}
