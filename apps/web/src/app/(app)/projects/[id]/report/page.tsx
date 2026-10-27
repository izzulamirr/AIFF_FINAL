import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { lineReviews, projects } from "@easy/db";
import { getDb } from "@/lib/db";
import { canReadOrganization } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { findLine, isoLinesOf } from "@/lib/isoLines";
import { summariseLine } from "@/lib/lineSummary";
import { buildIsoReport, reportSections, type DrawingReport, type Finding } from "@/lib/isoReport";
import { Badge } from "@/components/ui/primitives";
import { BRAND_FULL_NAME, BRAND_NAME, BrandLockup } from "@/components/ui/Brand";
import { IconArrowLeft } from "@/components/ui/icons";
import { HOLD_LABEL } from "@/lib/pending";
import { isMissingTable } from "@/lib/progress";
import { markLineReviewed } from "../progressActions";
import { PrintButton } from "./PrintButton";

// The errors found on one ISO line, laid out to be handed to the designer: print it
// or save it as a PDF from the browser. Only what is wrong is listed -- what agreed
// is one line at the end, and what could not be checked is said so, since "no
// errors" means something different when nothing was compared.
//
// Reached from a line's own page. Same access rule as the project page: an account
// reads the organizations it is a member of and no others.

// The checker's mark on this line, if there is one. Null as well where the
// progress tables have not been created yet (see lib/progress.ts).
async function reviewOf(projectId: string, key: string) {
  try {
    const [row] = await getDb()
      .select({ reviewedByName: lineReviews.reviewedByName, reviewedAt: lineReviews.reviewedAt, revision: lineReviews.revision })
      .from(lineReviews)
      .where(and(eq(lineReviews.projectId, projectId), eq(lineReviews.lineKey, key)))
      .limit(1);
    return row ?? null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    throw err;
  }
}

const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 14mm; }
  .report { font-size: 10.5px; }
  .report h2 { break-after: avoid; }
  .report tr { break-inside: avoid; }
  .report thead { display: table-header-group; }
  .report section { break-inside: auto; }
}
`;

// `reference` names the master document the ISO was checked against. Said once per
// section, so every finding under it reads as the ISO's to correct, never as two
// documents disagreeing with nobody responsible.
function Section({
  n,
  title,
  count,
  info = 0,
  reference,
  children,
}: {
  n: number;
  title: string;
  count: number;
  info?: number;
  reference?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 flex items-baseline gap-2 border-b border-foreground/40 pb-1.5 text-sm font-semibold uppercase tracking-[0.04em]">
        <span className="tabular-nums text-muted-foreground">{n}.</span>
        {title}
        <span className="font-normal normal-case tracking-normal text-muted-foreground">
          &middot; {count} {count === 1 ? "issue" : "issues"}
          {info > 0 ? ` · ${info} for information` : ""}
        </span>
      </h2>
      {reference && (
        <p className="mb-2 text-xs text-muted-foreground">
          Checked against the <span className="font-medium text-foreground">{reference}</span>. Fixes are for the piping designer, on the ISO.
        </p>
      )}
      {children}
    </section>
  );
}

// Every finding in the same five columns: what it is about, what the reference
// requires, what is wrong on the ISO, and who does what about it. A finding shown
// for information keeps its place, greyed, with the reason in place of an action.
function FindingTable({ n, findings }: { n: number; findings: Finding[] }) {
  return (
    <table className="table table-compact w-full text-xs">
      <thead>
        <tr>
          <th className="w-12">Ref</th>
          <th className="w-[26%]">Item</th>
          <th className="w-[22%]">Should be</th>
          <th className="w-[24%]">Problem</th>
          <th>Fix</th>
        </tr>
      </thead>
      <tbody>
        {findings.map((f, i) => (
          <tr key={i} className={`align-top ${f.info ? "text-muted-foreground" : ""}`}>
            <td className="tabular-nums text-muted-foreground">
              {n}.{i + 1}
            </td>
            <td>
              <span className={f.info ? "" : "font-medium"}>{f.item}</span>
              {/* One line per item: a cell the drawing crams several items into
                  reads as a list, not as one description twice as long. */}
              {f.itemParts && f.itemParts.length > 1 ? (
                <ol className="mt-0.5 list-decimal pl-4">
                  {f.itemParts.map((p, k) => (
                    <li key={k}>{p}</li>
                  ))}
                </ol>
              ) : (
                f.itemParts?.[0] && <span className="block">{f.itemParts[0]}</span>
              )}
              {f.itemDetail && <span className="block text-muted-foreground">{f.itemDetail}</span>}
            </td>
            <td>{f.requirement}</td>
            <td className={f.info ? "" : "text-danger"}>{f.discrepancy}</td>
            <td>
              {f.info ? <span className="italic">Info only: {f.info}</span> : (f.action ?? "-")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Drawing({ d, showName }: { d: DrawingReport; showName: boolean }) {
  let n = 0;
  return (
    <div className="mt-6 first:mt-0">
      {showName && <p className="rounded bg-muted/60 px-3 py-1.5 font-mono text-xs">{d.fileName}</p>}

      {d.issueCount === 0 && (
        <p className="mt-4 rounded-lg border border-success/30 bg-success-soft px-4 py-3 text-sm text-success">
          No errors found.
          {d.infoCount > 0 && ` ${d.infoCount} info-only note${d.infoCount > 1 ? "s" : ""} below.`}
        </p>
      )}

      {/* FIRST, ahead of the errors: what this report is issued without. These
          are not faults on the drawing -- they are waiting on the client or a
          vendor -- so the report goes out with them noted per sheet rather than
          being held back for them. */}
      {d.pending.length > 0 && (
        <section className="mt-5 rounded-lg border border-info-border bg-info-soft/40 px-4 py-3">
          <h2 className="text-sm font-semibold">
            On hold <span className="font-normal text-muted-foreground">&middot; {d.pending.length} · not errors</span>
          </h2>
          <table className="table table-compact mt-2 w-full text-xs">
            <thead>
              <tr>
                <th className="w-24">Sheet</th>
                <th className="w-20">Status</th>
                <th>Item</th>
                <th>Remark</th>
              </tr>
            </thead>
            <tbody>
              {d.pending.map((p, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap font-medium">{p.sheet}</td>
                  <td className="whitespace-nowrap">{HOLD_LABEL[p.status]}</td>
                  <td>{p.what}</td>
                  <td>
                    {p.remark}
                    {p.markedBy && <span className="text-muted-foreground"> &middot; marked by {p.markedBy}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {reportSections(d).map((s) => {
        const sectionNo = ++n;
        const errors = s.findings.filter((f) => !f.info).length;
        return (
          <Section key={s.title} n={sectionNo} title={s.title} count={errors} info={s.findings.length - errors} reference={s.reference ?? undefined}>
            <FindingTable n={sectionNo} findings={s.findings} />
          </Section>
        );
      })}
      {(d.clear.length > 0 || d.notChecked.length > 0) && (
        <div className="mt-6 border-t pt-3 text-xs text-muted-foreground">
          {d.clear.length > 0 && (
            <p>
              <span className="font-medium text-foreground">No errors:</span> {d.clear.join(" · ")}
            </p>
          )}
          {d.notChecked.length > 0 && (
            <div className="mt-1">
              <span className="font-medium text-foreground">Not checked:</span>
              <ul className="ml-4 list-disc">
                {d.notChecked.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default async function IsoReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ line?: string }>;
}) {
  const { id } = await params;
  const { line: requestedLine } = await searchParams;
  const db = getDb();

  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return <p>Project not found.</p>;

  const session = await getSessionUser();
  if (!session) return null;
  if (!(await canReadOrganization(session, project.organizationId))) return <p>Project not found.</p>;

  const line = findLine(await isoLinesOf(id), requestedLine);
  if (!line) return <p>Line not found.</p>;

  const [summary, review] = await Promise.all([summariseLine(id, line), reviewOf(id, line.key)]);
  const report = buildIsoReport(summary);
  // A checker's print marks the line done (see PrintButton); Document Control's
  // does not, because only a checker's mark counts as progress.
  const canMark = !session.isDcc;
  // Who signed the line off. A checker about to print is about to become that
  // person; anyone else sees the recorded mark, or a blank box to sign by hand.
  const checkedBy = review
    ? `${review.reviewedByName ?? "—"} · ${review.reviewedAt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}${review.revision ? ` · REV ${review.revision}` : ""}`
    : canMark
      ? (session.name ?? session.email)
      : "";
  const back = session.isDcc ? `/review?project=${id}&line=${encodeURIComponent(line.lineNumber)}` : `/projects/${id}?line=${encodeURIComponent(line.lineNumber)}`;
  const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <Link href={back} className="inline-flex items-center gap-1.5 text-[0.8125rem] font-medium text-muted-foreground hover:text-foreground">
          <IconArrowLeft size={14} />
          Back to the line
        </Link>
        {report && <PrintButton markDone={canMark ? markLineReviewed.bind(null, id, line.lineNumber) : undefined} />}
      </div>

      <article className="report card">
        <header className="border-b-2 border-foreground pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <BrandLockup size={30} full />
            <p className="text-right text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">ISO Check Report</p>
          </div>
          <p className="mt-5 text-xs uppercase tracking-[0.12em] text-muted-foreground">Line number</p>
          <h1 className="mt-1 break-all font-mono text-xl font-semibold">{line.lineNumber}</h1>
          {/* The title block of the report itself: what a reader filing it needs
              without reading on. */}
          <dl className="mt-4 grid grid-cols-2 border text-xs sm:grid-cols-5">
            {[
              ["Project", project.name],
              ["Revision", line.revision ? `REV ${line.revision}` : "Not read"],
              ["Sheets", String(line.sheets)],
              ["Date", today],
              ["Checked by", checkedBy || "—"],
            ].map(([label, value]) => (
              <div key={label} className="border-b border-r px-3 py-2 last:border-r-0 sm:border-b-0">
                <dt className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 break-words font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </header>

        {!report ? (
          <p className="mt-5 text-sm text-muted-foreground">The checks for this line could not be run, so there is nothing to report.</p>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Badge tone={report.totals.all > 0 ? "danger" : "success"} dot>
                {report.totals.all} {report.totals.all === 1 ? "issue" : "issues"}
              </Badge>
              {report.totals.pending > 0 && (
                <Badge tone="info" dot>
                  {report.totals.pending} pending
                </Badge>
              )}
              {report.totals.info > 0 && <Badge>{report.totals.info} for information</Badge>}
              {report.totals.designBasis > 0 && <Badge>Design basis {report.totals.designBasis}</Badge>}
              {report.totals.bom > 0 && <Badge>Bill of material {report.totals.bom}</Badge>}
              {report.totals.pid > 0 && <Badge>P&amp;ID {report.totals.pid}</Badge>}
              {report.totals.hookup > 0 && <Badge>Hook-up {report.totals.hookup}</Badge>}
              {report.totals.spooling > 0 && <Badge>Spooling {report.totals.spooling}</Badge>}
              {report.totals.containers > 0 && <Badge>Container {report.totals.containers}</Badge>}
            </div>

            {report.drawings.map((d) => (
              <Drawing key={d.documentId} d={d} showName={report.drawings.length > 1} />
            ))}

            {/* Sign-off: the checks narrow the review; a person still signs the drawing. */}
            <section className="mt-8 grid grid-cols-1 border text-xs sm:grid-cols-3" aria-label="Sign-off">
              {[
                ["Checked by", checkedBy],
                ["Reviewed by", ""],
                ["Approved by", ""],
              ].map(([role, name]) => (
                <div key={role} className="border-b px-3 py-2 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
                  <p className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{role}</p>
                  <p className="mt-0.5 min-h-[1.25rem] font-medium">{name}</p>
                  <div className="mt-6 flex justify-between gap-4 border-t pt-1 text-[10px] text-muted-foreground">
                    <span>Signature</span>
                    <span>Date</span>
                  </div>
                </div>
              ))}
            </section>
          </>
        )}

        <footer className="mt-6 border-t pt-3 text-[11px] leading-relaxed text-muted-foreground">
          <p>
            Prepared with {BRAND_NAME} ({BRAND_FULL_NAME}). Quote the Ref (e.g. 2.3) when replying. &ldquo;Info only&rdquo; rows are not errors. This
            report supports the checker&apos;s review; it does not replace it.
          </p>
        </footer>
      </article>
    </div>
  );
}
