import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { documents, projects } from "@easy/db";
import { getDb } from "@/lib/db";
import { canReadOrganization } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert, EmptyState } from "@/components/ui/primitives";
import { IconCompare } from "@/components/ui/icons";
import { DrawingDiff } from "./DrawingDiff";

export const metadata: Metadata = { title: "Compare P&IDs" };

// Two P&IDs laid over each other: an earlier issue and the one replacing it, with
// what differs on the DRAWINGS highlighted.
//
// This used to list changed lines, valves and fittings as well, from the two
// documents' AI readings. Each P&ID is read separately, so most of those
// "changes" were two readings of an unchanged sheet ("AC03N" against "AC03N-P", an
// equipment name against its drawing number) and buried the real ones. The overlay
// compares the drawings themselves, so what it marks is what changed.
//
// The person picks which is the earlier one: upload order is not revision order.
//
// P&IDs are Document Control's, like the rest of the library.

const uploaded = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default async function PidComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ before?: string; after?: string }>;
}) {
  const { id } = await params;
  const db = getDb();

  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return <p>Project not found.</p>;
  const session = await getSessionUser();
  if (!session) return null;
  if (!(await canReadOrganization(session, project.organizationId))) return <p>Project not found.</p>;

  const pids = await db
    .select()
    .from(documents)
    .where(and(eq(documents.projectId, id), eq(documents.docType, "pid")))
    .orderBy(desc(documents.uploadedAt));

  // Newest upload as the later one, the one before it as the earlier: a starting
  // point only, which the person changes with the two pickers.
  const query = await searchParams;
  const after = pids.find((d) => d.id === query.after) ?? pids[0];
  const before = pids.find((d) => d.id === query.before) ?? pids.find((d) => d.id !== after?.id);

  const header = (
    <PageHeader
      title="Compare P&IDs"
      back={{ href: `/projects/${id}`, label: project.name }}
      description="Pick an earlier P&ID and the one replacing it. The two drawings are laid over each other with what changed highlighted."
    />
  );

  if (pids.length < 2 || !before || !after) {
    return (
      <div className="flex flex-col gap-8">
        {header}
        <div className="card">
          <EmptyState icon={<IconCompare />} title="Two P&IDs are needed to compare">
            This project has {plural(pids.length, "P&ID")}. Upload the other issue in the{" "}
            <Link href={`/library?project=${id}`} className="link">
              library
            </Link>{" "}
            .
          </EmptyState>
        </div>
      </div>
    );
  }

  const sameDoc = before.id === after.id;

  const option = (d: (typeof pids)[number]) => (
    <option key={d.id} value={d.id}>
      {d.fileName} &middot; uploaded {uploaded.format(d.uploadedAt)}
    </option>
  );

  return (
    <div className="flex flex-col gap-8">
      {header}

      <section className="card">
        <form method="get" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] lg:items-end">
          <label className="min-w-0">
            <span className="field-label">Earlier P&amp;ID</span>
            <select name="before" defaultValue={before.id} className="input">
              {pids.map(option)}
            </select>
          </label>
          <span className="hidden pb-2.5 text-muted-foreground lg:block" aria-hidden="true">
            &rarr;
          </span>
          <label className="min-w-0">
            <span className="field-label">Latest P&amp;ID</span>
            <select name="after" defaultValue={after.id} className="input">
              {pids.map(option)}
            </select>
          </label>
          <button type="submit" className="btn btn-primary">
            <IconCompare size={16} />
            Compare
          </button>
        </form>
      </section>

      {sameDoc && <Alert tone="warning">The same P&amp;ID is picked on both sides. Pick two different documents.</Alert>}

      {!sameDoc && (
        <section className="card card-flush">
          <div className="card-header">
            <div>
              <h2 className="card-title">Drawing</h2>
              <p className="card-description">
                The two sheets laid over each other. Red is on the earlier P&amp;ID only, blue on the latest only. Click a numbered area to zoom to it.
              </p>
            </div>
          </div>
          <DrawingDiff
            projectId={id}
            before={{ id: before.id, fileName: before.fileName, pageCount: before.pageCount }}
            after={{ id: after.id, fileName: after.fileName, pageCount: after.pageCount }}
          />
        </section>
      )}
    </div>
  );
}
