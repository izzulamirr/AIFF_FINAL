import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { and, desc, eq, inArray } from "drizzle-orm";
import { documents, extractionJobs, extractedTags, projects } from "@easy/db";
import { comparePids, type ChangeStatus, type FieldChange, type TaggedChange } from "@easy/shared";
import { getDb } from "@/lib/db";
import { canReadOrganization } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert, Badge, EmptyState, Stat, type Tone } from "@/components/ui/primitives";
import { IconCompare } from "@/components/ui/icons";
import { DrawingDiff } from "./DrawingDiff";

export const metadata: Metadata = { title: "Compare P&IDs" };

// Two P&IDs side by side: an earlier issue and the one replacing it, and what
// changed between them -- lines, tagged valves and instruments, and the counts of
// untagged valves and fittings. See @easy/shared/pidCompare for what is matched
// to what.
//
// Both documents are already extracted, so this reads tags and changes nothing.
// The person picks which is the earlier one: the P&ID extraction does not read
// the REV box, and upload order is not revision order.
//
// P&IDs are Document Control's, like the rest of the library.

const uploaded = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

const STATUS: Record<ChangeStatus, { label: string; tone: Tone }> = {
  changed: { label: "Changed", tone: "warning" },
  added: { label: "Added", tone: "info" },
  removed: { label: "Removed", tone: "danger" },
};

const humanize = (key: string) => {
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function StatusBadge({ status }: { status: ChangeStatus }) {
  const s = STATUS[status];
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

// A change reads "Size 8" -> 10""; an addition or removal lists what it was read with.
function Changes({ status, changes }: { status: ChangeStatus; changes: FieldChange[] }) {
  if (changes.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
      {changes.map((c) => (
        <div key={c.field} className="contents">
          <dt className="text-muted-foreground">{humanize(c.field)}</dt>
          <dd className="break-words">
            {status === "changed" ? (
              <>
                <del className="text-danger">{c.before ?? "blank"}</del>
                <span className="mx-1.5 text-muted-foreground" aria-label="now">
                  &rarr;
                </span>
                <ins className="font-semibold text-link no-underline">{c.after ?? "blank"}</ins>
              </>
            ) : status === "removed" ? (
              <del className="text-muted-foreground">{c.before}</del>
            ) : (
              <span>{c.after}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Section({ title, count, description, children }: { title: string; count: number; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="card card-flush">
      <div className="card-header">
        <div>
          <h2 className="card-title">
            {title} <span className="font-normal text-muted-foreground">({count})</span>
          </h2>
          {description && <p className="card-description">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function ChangeTable({ rows, tagLabel }: { rows: TaggedChange[]; tagLabel: string }) {
  return (
    <div className="table-wrap">
      <table className="table table-top">
        <thead>
          <tr>
            <th className="w-28">Status</th>
            <th>{tagLabel}</th>
            <th>Sheet</th>
            <th>What changed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.status}:${r.tagType}:${r.tagNumber}`}>
              <td>
                <StatusBadge status={r.status} />
              </td>
              <td className="min-w-[16rem]">
                <span className="break-all font-mono text-[0.8125rem] font-medium">{r.tagNumber}</span>
                {r.tagType !== "line" && (
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge mono>{r.tagType}</Badge>
                    {r.lineNumber && <span className="break-all font-mono">{r.lineNumber}</span>}
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap font-mono text-xs text-muted-foreground">{r.sheet ?? "—"}</td>
              <td className="min-w-[18rem]">
                <Changes status={r.status} changes={r.changes} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
  if (!session.isDcc) redirect(`/projects/${id}`);

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
      description="Pick an earlier P&ID and the one replacing it to see every line, valve, instrument and fitting that changed. Both are already extracted, so this runs instantly and changes nothing."
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
            and wait for it to be read.
          </EmptyState>
        </div>
      </div>
    );
  }

  const sameDoc = before.id === after.id;
  const tags = sameDoc
    ? []
    : await db
        .select({
          documentId: extractedTags.documentId,
          tagType: extractedTags.tagType,
          tagNumber: extractedTags.tagNumber,
          sourcePage: extractedTags.sourcePage,
          attributes: extractedTags.attributes,
        })
        .from(extractedTags)
        .where(inArray(extractedTags.documentId, [before.id, after.id]));
  const beforeTags = tags.filter((t) => t.documentId === before.id);
  const afterTags = tags.filter((t) => t.documentId === after.id);

  const jobs = await db
    .select({ documentId: extractionJobs.documentId, status: extractionJobs.status, createdAt: extractionJobs.createdAt })
    .from(extractionJobs)
    .where(inArray(extractionJobs.documentId, [before.id, after.id]))
    .orderBy(desc(extractionJobs.createdAt));
  const statusOf = (docId: string) => jobs.find((j) => j.documentId === docId)?.status ?? null;
  const notRead = [before, after].filter((d) => statusOf(d.id) !== "succeeded");

  const result = sameDoc ? null : comparePids(beforeTags, afterTags);
  const sheetsChanged = result?.sheets.filter((s) => !s.inBefore || !s.inAfter || s.changeCount > 0).length ?? 0;

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

      {notRead.length > 0 && (
        <Alert tone="warning">
          {notRead.map((d) => d.fileName).join(" and ")} {notRead.length === 1 ? "has" : "have"} not finished being read, so{" "}
          {notRead.length === 1 ? "its" : "their"} tags may be missing or incomplete. Changes below are only as good as both readings.
        </Alert>
      )}

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

      {result && (
        <>
          <section className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="Sheets" value={result.sheets.length} hint={`${sheetsChanged} with changes`} />
            <Stat
              label="Lines changed"
              value={result.lines.filter((l) => l.status === "changed").length}
              tone={result.lines.some((l) => l.status === "changed") ? "warning" : "neutral"}
              hint={`${result.unchanged.lines} unchanged`}
            />
            <Stat label="Lines added" value={result.lines.filter((l) => l.status === "added").length} />
            <Stat label="Lines removed" value={result.lines.filter((l) => l.status === "removed").length} />
            <Stat label="Possibly renumbered" value={result.renumbered.length} />
            <Stat
              label="Valve / instrument changes"
              value={result.tagged.length + result.counts.length}
              hint={`${result.unchanged.tagged + result.unchanged.counts} unchanged`}
            />
          </section>

          <Section title="Sheets" count={result.sheets.length} description="Paired by the drawing number in each title block.">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Drawing number</th>
                    <th>Earlier</th>
                    <th>Latest</th>
                    <th>Changes</th>
                  </tr>
                </thead>
                <tbody>
                  {result.sheets.map((s) => (
                    <tr key={s.sheet}>
                      <td className="font-mono text-[0.8125rem]">{s.sheet}</td>
                      <td>{s.inBefore ? "Yes" : <span className="text-muted-foreground">Not on it</span>}</td>
                      <td>{s.inAfter ? "Yes" : <span className="text-muted-foreground">Not on it</span>}</td>
                      <td>
                        {!s.inAfter ? (
                          <Badge tone="danger">Sheet removed</Badge>
                        ) : !s.inBefore ? (
                          <Badge tone="info">New sheet</Badge>
                        ) : s.changeCount > 0 ? (
                          <Badge tone="warning">{plural(s.changeCount, "change")}</Badge>
                        ) : (
                          <Badge tone="success">No changes</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                  {result.sheets.length === 0 && (
                    <tr>
                      <td colSpan={4} className="text-muted-foreground">
                        No sheet numbers were read from either document.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Section>

          {result.renumbered.length > 0 && (
            <Section
              title="Possibly renumbered lines"
              count={result.renumbered.length}
              description="A line disappeared and another appeared with the same size, class and both ends. Confirm it is the same pipe, or treat it as one removed and one added."
            >
              <div className="table-wrap">
                <table className="table table-top">
                  <thead>
                    <tr>
                      <th>Earlier number</th>
                      <th>Latest number</th>
                      <th>Sheet</th>
                      <th>Also changed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.renumbered.map((r) => (
                      <tr key={`${r.before}:${r.after}`}>
                        <td className="break-all font-mono text-[0.8125rem] text-muted-foreground">
                          <del>{r.before}</del>
                        </td>
                        <td className="break-all font-mono text-[0.8125rem] font-medium">{r.after}</td>
                        <td className="whitespace-nowrap font-mono text-xs text-muted-foreground">{r.sheet ?? "—"}</td>
                        <td>
                          <Changes status="changed" changes={r.changes} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}

          <Section title="Lines" count={result.lines.length} description="Matched by line number.">
            {result.lines.length > 0 ? (
              <ChangeTable rows={result.lines} tagLabel="Line number" />
            ) : (
              <EmptyState title="No line changes" />
            )}
          </Section>

          <Section title="Tagged valves and instruments" count={result.tagged.length} description="Matched by tag.">
            {result.tagged.length > 0 ? <ChangeTable rows={result.tagged} tagLabel="Tag" /> : <EmptyState title="No tagged item changes" />}
          </Section>

          <Section
            title="Untagged valves and fittings"
            count={result.counts.length}
            description="These carry no tag, so they are compared as a count per line, symbol, size and class."
          >
            {result.counts.length > 0 ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="w-28">Status</th>
                      <th>Line</th>
                      <th>Item</th>
                      <th>Size</th>
                      <th>Class</th>
                      <th className="text-right">Earlier</th>
                      <th className="text-right">Latest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.counts.map((c) => (
                      <tr key={`${c.tagType}:${c.lineNumber}:${c.kind}:${c.size}:${c.specClass}`}>
                        <td>
                          <StatusBadge status={c.status} />
                        </td>
                        <td className="break-all font-mono text-xs">{c.lineNumber ?? "—"}</td>
                        <td>{c.kind}</td>
                        <td>{c.size ?? "—"}</td>
                        <td>{c.specClass ?? "—"}</td>
                        <td className="text-right tabular-nums text-muted-foreground">{c.before}</td>
                        <td className="text-right font-semibold tabular-nums">{c.after}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="No count changes" />
            )}
          </Section>

          <p className="text-xs text-muted-foreground">
            Each P&amp;ID is read by AI separately, so a difference here can occasionally be two readings of an unchanged drawing rather than a
            real revision. Check anything surprising against the drawings:{" "}
            <Link href={`/projects/${id}/documents/${before.id}`} className="link">
              {before.fileName}
            </Link>{" "}
            and{" "}
            <Link href={`/projects/${id}/documents/${after.id}`} className="link">
              {after.fileName}
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}
