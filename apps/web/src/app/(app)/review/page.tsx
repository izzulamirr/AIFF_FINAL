import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { activeProjectsOf, projectOptions } from "@/lib/access";
import { ProjectPicker } from "@/components/project/ProjectPicker";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/primitives";
import { IconFolder } from "@/components/ui/icons";
import { LineReviewView } from "../projects/[id]/LineReviewView";

export const metadata: Metadata = { title: "Line review" };

// Document Control checking the data itself: the same line-by-line reviews a
// checker gets, for the project chosen here.
//
// What it does here does NOT count toward progress. Progress is checkers marking
// lines done, and this page shows where each line stands but has no button to
// change it -- the actions refuse Document Control as well (see progressActions).
export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ project?: string; line?: string }> }) {
  const params = await searchParams;
  const session = await getSessionUser();
  if (!session) return null;
  if (!session.isDcc) redirect("/organizations");

  const organizationProjects = await activeProjectsOf(session);
  // The project asked for if it is one of this organization's, else the first.
  const project = organizationProjects.find((p) => p.id === params.project) ?? organizationProjects[0];

  if (!project) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Line review" />
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
            Create a project and upload an isometric to review its lines.
          </EmptyState>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <ProjectPicker basePath="/review" projectId={project.id} projects={projectOptions(organizationProjects)} />

      <p className="callout max-w-3xl">
        Check a line here the way a checker does. Nothing you do on this page counts toward progress &mdash; only a checker marking a line
        done does.
      </p>

      <LineReviewView
        projectId={project.id}
        projectName={project.name}
        requestedLine={params.line}
        canMark={false}
        links={{
          list: `/review?project=${project.id}`,
          line: (lineNumber) => `/review?project=${project.id}&line=${encodeURIComponent(lineNumber)}`,
        }}
      />
    </div>
  );
}
