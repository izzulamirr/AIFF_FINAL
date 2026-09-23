import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { activeProjectsOf } from "@/lib/access";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/primitives";
import { IconFolder } from "@/components/ui/icons";
import { LineReviewView } from "../projects/[id]/LineReviewView";

export const metadata: Metadata = { title: "ISO checking" };

// ISO checking: Document Control checking the data itself, the same line-by-line
// reviews a checker gets. Every check on an ISO lives here -- design basis, bill
// of material, P&ID, hook-up, spooling and the container fit.
//
// THE PROJECT IS NOT CHOSEN HERE. It arrives as `?project=` from the project you
// opened, which is the step before this one in the flow:
//
//   login -> client -> dashboard -> PROJECT -> ISO checking
//
// There used to be a project dropdown at the top. It asked a question that had
// already been answered one screen earlier, and it made it possible to be on a
// page headed with one project's name while looking at another's lines. A bare
// /review with no project still falls back to the client's first project, so a
// typed URL or an old bookmark lands somewhere sensible rather than on an error.
//
// What it does here does NOT count toward progress. Progress is checkers marking
// lines done, and this page shows where each line stands but has no button to
// change it -- the actions refuse Document Control as well (see progressActions).
//
// The route stays `/review`: it is the same page, and a rename would break every
// link already saved to it.
export default async function ReviewPage({ searchParams }: { searchParams: Promise<{ project?: string; line?: string }> }) {
  const params = await searchParams;
  const session = await getSessionUser();
  if (!session) return null;
  if (!session.isDcc) redirect("/clients");

  const clientProjects = await activeProjectsOf(session);
  // The project asked for if it is one of this client's, else the first.
  const project = clientProjects.find((p) => p.id === params.project) ?? clientProjects[0];

  if (!project) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="ISO checking" />
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
            Create a project and upload an isometric to check its lines.
          </EmptyState>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* No callout and no Library button. Both said something true and neither
          was worth the room: the callout explained a button that is not on this
          page (Document Control has no "Mark as done" -- each line shows its
          state read-only, which says the same thing where it matters), and the
          library is already in the sidebar and on the project page.
          `back` goes to the PROJECT -- the step this page was opened from, and
          where the rest of the work on it is -- so the title names the FEATURE
          rather than printing the project's name twice. */}
      <LineReviewView
        projectId={project.id}
        projectName={project.name}
        listTitle="ISO checking"
        requestedLine={params.line}
        canMark={false}
        links={{
          list: `/review?project=${project.id}`,
          line: (lineNumber) => `/review?project=${project.id}&line=${encodeURIComponent(lineNumber)}`,
          back: { href: `/projects/${project.id}`, label: project.name },
        }}
      />
    </div>
  );
}
