import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { boardOf, CHECK_LABEL, DOC_LABEL, namesOf, overviewOf, type ProjectOverview } from "@/lib/dashboardData";
import { MonitoringBoard } from "@/components/dashboard/MonitoringBoard";
import { getSessionUser } from "@/lib/session";
import { activeOrganization, activeProjectsOf, hiddenProjectsOf } from "@/lib/access";
import { progressOfProjects, type ProjectProgress } from "@/lib/progress";
import { ProgressBar } from "@/components/progress/ProgressBar";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert, Badge, EmptyState } from "@/components/ui/primitives";
import { IconBuilding, IconChevronRight, IconDownload, IconFolder, IconLibrary, IconPlus } from "@/components/ui/icons";
import { createProject } from "../actions";
import { TotalLinesForm } from "../projects/[id]/TotalLinesForm";
import { DeleteProjectButton, HideProjectButton } from "../projects/DeleteProjectButton";

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
//
// The same page also shows ONE project's figures (`?project=<id>`, the scope
// picker): the client view compares projects, a project view is the same board
// over that project alone. Looking at a project here is not opening it -- the
// "Open project" button does that.

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

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

/** Every line that has errors, worst first, each opening its error report. */
function LinesNeedingAttention({ overview, showProject }: { overview: ProjectOverview[]; showProject: boolean }) {
  const rows = overview
    .flatMap((o) => o.results.map((r) => ({ ...r, projectId: o.id, project: o.name })))
    .filter((r) => r.errors > 0)
    .sort((a, b) => b.errors - a.errors)
    .slice(0, 12);
  if (rows.length === 0) return null;
  return (
    <section className="card card-flush">
      <div className="card-header">
        <h2 className="card-title">Lines with errors</h2>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Line</th>
              {showProject && <th>Project</th>}
              <th>Rev</th>
              <th>Where the errors are</th>
              <th className="w-24 text-right">Errors</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.projectId}-${r.lineNumber}-${i}`}>
                <td>
                  <Link
                    href={`/projects/${r.projectId}/report?line=${encodeURIComponent(r.lineNumber)}`}
                    className="font-mono text-xs font-medium underline-offset-2 hover:underline"
                  >
                    {r.lineNumber}
                  </Link>
                </td>
                {showProject && <td>{r.project}</td>}
                <td className="tabular-nums">{r.revision ?? "-"}</td>
                <td className="text-xs text-muted-foreground">
                  {CHECK_LABEL.filter(([k]) => r.byCheck[k] > 0)
                    .map(([k, label]) => `${label} ${r.byCheck[k]}`)
                    .join(" · ")}
                </td>
                <td className="text-right">
                  <Badge tone="danger" dot>
                    {r.errors}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Hidden projects, kept out of everything above but listed here so they can be
// brought back -- a hide with no way to undo it would just be a slower delete.
function HiddenProjects({ projects, className = "" }: { projects: Array<{ id: string; name: string }>; className?: string }) {
  if (projects.length === 0) return null;
  return (
    <div className={`flex flex-col gap-2 px-5 py-4 text-sm ${className}`}>
      <span className="text-xs font-medium text-muted-foreground">Hidden projects ({projects.length})</span>
      <ul className="flex flex-col gap-1.5">
        {projects.map((p) => (
          <li key={p.id} className="flex items-center gap-2">
            <IconFolder size={15} className="flex-none text-muted-foreground" />
            <Link href={`/projects/${p.id}`} className="truncate text-muted-foreground hover:text-foreground">
              {p.name}
            </Link>
            <span className="ml-auto flex items-center gap-2">
              <HideProjectButton projectId={p.id} name={p.name} hidden />
              <DeleteProjectButton projectId={p.id} name={p.name} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OverviewRow({ project }: { project: ProjectOverview }) {
  const errorLines = project.results.filter((r) => r.errors > 0).length;
  return (
    <li className="flex flex-col gap-2 px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/projects/${project.id}`} className="group flex min-w-0 items-center gap-2 font-medium">
          <IconFolder size={17} className="flex-none text-muted-foreground" />
          <span className="truncate">{project.name}</span>
          <IconChevronRight size={16} className="flex-none text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </Link>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {errorLines > 0 && (
            <Badge tone="danger" dot>
              {errorLines} line{errorLines === 1 ? "" : "s"} with errors
            </Badge>
          )}
          <Badge tone={project.isoLines === 0 ? "warning" : errorLines === 0 ? "success" : "neutral"} dot={project.isoLines > 0 && errorLines === 0}>
            {project.isoLines} ISO line{project.isoLines === 1 ? "" : "s"} read
          </Badge>
          <HideProjectButton projectId={project.id} name={project.name} />
          <DeleteProjectButton projectId={project.id} name={project.name} />
        </span>
      </div>
      {project.isoLines > 0 && <ProgressBar value={project.isoLines - errorLines} max={project.isoLines} label={`${project.name} lines with no errors`} />}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {project.byType.length > 0 ? (
          project.byType.map(([type, n]) => (
            <span key={type}>
              {n} {DOC_LABEL[type] ?? type}
            </span>
          ))
        ) : (
          <span>no documents uploaded yet</span>
        )}
        {project.lastUpload && <span className="ml-auto">last upload {when.format(project.lastUpload)}</span>}
      </div>
    </li>
  );
}

/** Headline numbers across the projects in view -- the "where does the job stand" answer. */
function MonitoringSummary({ progress, scope }: { progress: ProjectProgress[]; scope: "client" | "project" }) {
  const done = progress.reduce((n, p) => n + p.done, 0);
  const recheck = progress.reduce((n, p) => n + p.recheck, 0);
  const lines = progress.reduce((n, p) => n + (p.total ?? p.uploaded), 0);
  const uploaded = progress.reduce((n, p) => n + p.uploaded, 0);
  const pct = lines > 0 ? Math.min(100, Math.round((done / lines) * 100)) : 0;
  const tiles = [
    { label: "Lines checked", value: `${done} / ${lines}`, hint: `${pct}% of the ${scope === "project" ? "project" : "client"}'s lines`, tone: "" },
    { label: "To re-check", value: String(recheck), hint: "checked against a replaced drawing", tone: recheck > 0 ? "text-warning" : "" },
    { label: "Not yet checked", value: String(Math.max(0, lines - done - recheck)), hint: "still to review", tone: "" },
    {
      label: "ISO lines read",
      value: String(uploaded),
      hint: scope === "project" ? "from this project's drawings" : `across ${progress.length} project${progress.length === 1 ? "" : "s"}`,
      tone: "",
    },
  ];
  return (
    <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="card flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{t.label}</span>
          <span className={`text-2xl font-semibold tabular-nums ${t.tone}`}>{t.value}</span>
          <span className="text-xs text-muted-foreground">{t.hint}</span>
        </div>
      ))}
    </section>
  );
}

/**
 * The latest checks across every project: who ticked which line, when, and whether
 * it still stands. Each opens the line's report -- the page the checker issued.
 */
function RecentChecks({ progress }: { progress: ProjectProgress[] }) {
  const recent = progress
    .flatMap((p) => p.classified.map((r) => ({ ...r, project: p.projectName, projectId: p.projectId })))
    .sort((a, b) => b.reviewedAt.getTime() - a.reviewedAt.getTime())
    .slice(0, 8);
  if (recent.length === 0) return null;
  return (
    <section className="card card-flush">
      <div className="card-header">
        <h2 className="card-title">Recent checks</h2>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Line</th>
              <th>Project</th>
              <th>Checked by</th>
              <th>When</th>
              <th className="w-32">Status</th>
              <th className="w-px">
                <span className="sr-only">Report</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r, i) => {
              const report = `/projects/${r.projectId}/report?line=${encodeURIComponent(r.lineNumber)}`;
              return (
              <tr key={`${r.project}-${r.lineKey}-${i}`}>
                <td>
                  <Link href={report} className="font-mono text-xs font-medium text-link underline-offset-2 hover:underline">
                    {r.lineNumber}
                  </Link>
                </td>
                <td>{r.project}</td>
                <td>{r.reviewedByName ?? "-"}</td>
                <td className="whitespace-nowrap text-xs text-muted-foreground">{when.format(r.reviewedAt)}</td>
                <td>
                  {r.state === "recheck" ? (
                    <Badge tone="warning" dot title={`Checked against revision ${r.revision ?? "?"}; now ${r.currentRevision ?? "?"}`}>
                      Re-check
                    </Badge>
                  ) : (
                    <Badge tone="success" dot>
                      Checked
                    </Badge>
                  )}
                </td>
                <td className="text-right">
                  <Link href={report} className="btn btn-secondary btn-xs whitespace-nowrap">
                    View report
                    <IconChevronRight size={13} />
                  </Link>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// A project's view of the dashboard: just how far through its lines it is. The
// project's name is already in the header and the picker, and its total lines are
// set on the project's own page, so the card the client view uses would only
// repeat them. Without the progress tables, the lines the checks have run on
// stand in for the lines marked checked -- the same fallback the client view uses.
function ProjectProgressStrip({ progress, overview }: { progress: ProjectProgress | null; overview: ProjectOverview | undefined }) {
  const done = progress ? progress.done : (overview?.results.filter((r) => !r.failed).length ?? 0);
  const total = progress ? (progress.total ?? progress.uploaded) : (overview?.isoLines ?? 0);
  const recheck = progress?.recheck ?? 0;
  return (
    <section className="card flex flex-col gap-3" aria-label="Project progress">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <span className="font-semibold tabular-nums">
            {done} of {total}
          </span>
          <span className="text-muted-foreground"> {progress && progress.total == null ? "uploaded " : ""}lines checked</span>
        </p>
        {recheck > 0 && (
          <Badge tone="warning" dot title="Checked against a drawing a later revision has replaced">
            {recheck} to re-check
          </Badge>
        )}
      </div>
      <ProgressBar value={done} max={Math.max(total, 1)} label="Lines checked in this project" />
    </section>
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
          <HideProjectButton projectId={project.projectId} name={project.projectName} />
          <DeleteProjectButton projectId={project.projectId} name={project.projectName} />
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

// Which projects the page is about: the whole client, or one of its projects.
//
// Every figure below is built from this one list, so the client view and a
// project's view are the same sums over different projects and cannot disagree.
// The project comes from the URL, so it is checked against the client's own
// projects -- an id from another client, or a stale one, falls back to the client
// view rather than showing anything it should not.
function ScopePicker({ projects, selected }: { projects: Array<{ id: string; name: string }>; selected: string | null }) {
  const item = (href: string, label: string, active: boolean, key: string) => (
    <li key={key}>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors ${
          active ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
        }`}
      >
        {label}
      </Link>
    </li>
  );
  return (
    <nav aria-label="Dashboard scope" className="flex flex-col gap-2">
      <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">Show</p>
      <ul className="flex flex-wrap gap-2">
        {item("/dashboard", "All projects", selected === null, "all")}
        <li aria-hidden="true" className="mx-1 w-px self-stretch bg-border" />
        {projects.map((p) => item(`/dashboard?project=${p.id}`, p.name, selected === p.id, p.id))}
      </ul>
    </nav>
  );
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const session = await getSessionUser();
  if (!session) return null;
  if (!session.isDcc) redirect("/clients");

  const [client, clientProjects, hiddenProjects, query] = await Promise.all([
    activeOrganization(session),
    activeProjectsOf(session),
    hiddenProjectsOf(session),
    searchParams,
  ]);
  const focus = clientProjects.find((p) => p.id === query.project) ?? null;
  const inScope = focus ? [focus] : clientProjects;
  // Independent of each other, so fetched together rather than one after the other.
  // Null progress means the progress tables do not exist yet (see lib/progress.ts);
  // the overview still shows what is really there without them.
  const [progress, overview] = await Promise.all([progressOfProjects(inScope), overviewOf(inScope)]);
  const names = await namesOf([...new Set(overview.flatMap((o) => o.uploaders.map((u) => u.userId)))]);

  const totals = (progress ?? []).reduce(
    (acc, p) => ({ done: acc.done + p.done, recheck: acc.recheck + p.recheck, lines: acc.lines + (p.total ?? p.uploaded) }),
    { done: 0, recheck: 0, lines: 0 }
  );

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={focus ? "Project overview" : "Client overview"}
        description={
          focus
            ? `Where ${focus.name} stands: its lines, the errors found on them, and what it holds.`
            : "Where every project of this client stands. Choose a project below to see it on its own."
        }
        meta={
          <>
            {client && (
              <Badge>
                <IconBuilding size={13} />
                {client.name}
              </Badge>
            )}
            {focus && (
              <Badge tone="info">
                <IconFolder size={13} />
                {focus.name}
              </Badge>
            )}
          </>
        }
        actions={
          // The client-wide roll-up (every P&ID, spec and template this
          // client holds, across all of its projects) used to render here in
          // full -- too much detail for a page meant to answer "where does
          // the job stand" at a glance. Kept off the hub and reached by a
          // click instead, the same move already made for ISO checking and
          // the Cutting Plan.
          <div className="flex flex-wrap items-center gap-2">
            {/* A plain link, not next/link: it downloads a file rather than opening a page. */}
            <a href={focus ? `/dashboard/export?project=${focus.id}` : "/dashboard/export"} className="btn btn-secondary">
              <IconDownload size={16} />
              Export to Excel
            </a>
            {focus ? (
              <Link href={`/projects/${focus.id}`} className="btn btn-primary">
                <IconFolder size={16} />
                Open project
              </Link>
            ) : (
              <Link href="/dashboard/libraries" className="btn btn-secondary">
                <IconLibrary size={16} />
                Overall libraries
              </Link>
            )}
          </div>
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
          <HiddenProjects projects={hiddenProjects} className="border-t px-0" />
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
              safe to run more than once. Until then the figures below come from the checks themselves (what each ISO line&apos;s error report finds), and every project opens.
            </Alert>
          )}

          <ScopePicker projects={clientProjects} selected={focus?.id ?? null} />

          {/* PROJECTS FIRST. Opening a project is what most visits are for, so
              the list is the first thing on the page; the monitoring below it
              is the detail behind those rows. A project's view has only its
              progress bar here. */}
          {focus ? (
            <ProjectProgressStrip progress={progress?.[0] ?? null} overview={overview[0]} />
          ) : (
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
                  : overview.map((o) => <OverviewRow key={o.id} project={o} />)}
              </ul>

              {/* Creating a project is the other half of what the removed
                  "Projects" nav link used to be for -- kept here, at the foot of
                  the list it adds to, rather than on a page of its own. */}
              {client && <NewProjectForm organizationId={client.id} className="border-t bg-muted/40" />}
              <HiddenProjects projects={hiddenProjects} className="border-t" />
            </section>
          )}

          {progress !== null && <MonitoringSummary progress={progress} scope={focus ? "project" : "client"} />}
          <MonitoringBoard data={boardOf(overview, progress, names)} scope={focus ? "project" : "client"} />
          <LinesNeedingAttention overview={overview} showProject={!focus} />

          {progress !== null && <RecentChecks progress={progress} />}
        </>
      )}
    </div>
  );
}
