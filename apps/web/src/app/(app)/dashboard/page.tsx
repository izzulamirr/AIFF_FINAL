import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { activeOrganization, activeProjectsOf, projectOptions } from "@/lib/access";
import { progressOfProjects } from "@/lib/progress";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { IconArrowRight, IconBox, IconBuilding, IconClipboard, IconFolder, IconGauge, IconNest, IconSpool } from "@/components/ui/icons";
import { ProjectPicker } from "@/components/project/ProjectPicker";
import { ProgressSection } from "./ProgressSection";

export const metadata: Metadata = { title: "Dashboard" };

// Every tool opens on THIS project, not on whichever one it would default to.
const toolsFor = (projectId: string) => [
  { href: `/projects/${projectId}`, title: "Project documents", text: "Upload drawings and review what was extracted from them.", icon: IconFolder },
  { href: `/review?project=${projectId}`, title: "Line review", text: "Check a line's reviews yourself. It does not count toward progress.", icon: IconClipboard },
  { href: `/hookup?project=${projectId}`, title: "Instrument Hookup", text: "Check an ISO against the project's instrument hook-up typicals.", icon: IconGauge },
  { href: `/spooling?project=${projectId}`, title: "Spooling", text: "See the spools and welds read off each isometric.", icon: IconSpool },
  { href: `/containers?project=${projectId}`, title: "Container check", text: "Find out whether each spool ships in a 20ft container.", icon: IconBox },
  { href: `/cutting?project=${projectId}`, title: "Cutting Plan", text: "Nest cutting-plate parts onto stock plate.", icon: IconNest },
];

// Document Control's home, and it is about ONE PROJECT: how far the checkers are
// through that project's lines, and the tools for it. The project is chosen here;
// the organization was chosen before the sidebar existed, on the picker. A plain
// user never uses this page: their path is Organization -> Project -> Line, and it
// is there that they mark a line done.
export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const params = await searchParams;
  const session = await getSessionUser();
  if (!session) return null;
  if (!session.isDcc) redirect("/organizations");

  const organization = await activeOrganization(session);
  const organizationProjects = await activeProjectsOf(session);

  // The project asked for if it is one of this organization's, else the first.
  const project = organizationProjects.find((p) => p.id === params.project) ?? organizationProjects[0];
  const progress = project ? await progressOfProjects([project]) : null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Dashboard"
        description="How far each project's lines have been checked, and the tools to work on it."
        meta={
          organization && (
            <Badge>
              <IconBuilding size={13} />
              {organization.name}
            </Badge>
          )
        }
      />

      {!project ? (
        <div className="card">
          <EmptyState
            icon={<IconFolder />}
            title="No projects yet"
            action={
              <Link href="/projects" className="btn btn-primary btn-sm mt-1">
                Create one
              </Link>
            }
          >
            Create a project, enter how many lines it holds, and the checkers&apos; progress appears here.
          </EmptyState>
        </div>
      ) : (
        <>
          <ProjectPicker basePath="/dashboard" projectId={project.id} projects={projectOptions(organizationProjects)} />

          {/* null means the progress tables do not exist yet (see lib/progress.ts). */}
          <ProgressSection progress={progress ? progress[0] : null} />

          <section className="flex flex-col gap-4">
            <h2 className="section-title">
              Engineering tools <span className="font-normal text-muted-foreground">&middot; {project.name}</span>
            </h2>
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {toolsFor(project.id).map(({ href, title, text, icon: Icon }) => (
                <li key={href}>
                  <Link href={href} className="card group flex h-full flex-col gap-3 transition hover:border-border-strong hover:shadow-md">
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-soft text-link">
                      <Icon />
                    </span>
                    <div>
                      <p className="flex items-center gap-1.5 font-medium">
                        {title}
                        <IconArrowRight size={15} className="text-muted-foreground opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
                      </p>
                      <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">{text}</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
