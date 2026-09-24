import Link from "next/link";
import { eq } from "drizzle-orm";
import { projects } from "@easy/db";
import { getDb } from "@/lib/db";
import { canReadOrganization } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { findLine, isoLinesOf } from "@/lib/isoLines";
import { summariseLine } from "@/lib/lineSummary";
import { buildIsoReport, type DrawingReport } from "@/lib/isoReport";
import { Badge } from "@/components/ui/primitives";
import { IconArrowLeft } from "@/components/ui/icons";
import { PrintButton } from "./PrintButton";

// The errors found on one ISO line, laid out to be handed to the designer: print it
// or save it as a PDF from the browser. Only what is wrong is listed -- what agreed
// is one line at the end, and what could not be checked is said so, since "no
// errors" means something different when nothing was compared.
//
// Reached from a line's own page. Same access rule as the project page: an account
// reads the organizations it is a member of and no others.

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

function Section({ n, title, count, info = 0, children }: { n: number; title: string; count: number; info?: number; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="mb-2 flex items-baseline gap-2 border-b pb-1.5 text-sm font-semibold">
        <span className="tabular-nums text-muted-foreground">{n}.</span>
        {title}
        <span className="font-normal text-muted-foreground">
          &middot; {count} {count === 1 ? "issue" : "issues"}
          {info > 0 ? ` · ${info} for information` : ""}
        </span>
      </h2>
      {children}
    </section>
  );
}

function Drawing({ d, showName }: { d: DrawingReport; showName: boolean }) {
  let n = 0;
  return (
    <div className="mt-6 first:mt-0">
      {showName && <p className="rounded bg-muted/60 px-3 py-1.5 font-mono text-xs">{d.fileName}</p>}

      {d.issueCount === 0 && (
        <p className="mt-4 rounded-lg border border-success/30 bg-success-soft px-4 py-3 text-sm text-success">
          No errors found in the checks that were run.
          {d.infoCount > 0 && ` ${d.infoCount} finding${d.infoCount > 1 ? "s are" : " is"} listed below for information.`}
        </p>
      )}

      {d.designBasis.issues.length > 0 && (
        <Section n={++n} title="Design basis: drawing vs line list" count={d.designBasis.issues.length}>
          <table className="table table-compact w-full text-xs">
            <thead>
              <tr>
                <th className="w-12">Ref</th>
                <th>Field</th>
                <th>Drawing says</th>
                <th>Line list says</th>
              </tr>
            </thead>
            <tbody>
              {d.designBasis.issues.map((r, i) => (
                <tr key={r.field}>
                  <td className="tabular-nums text-muted-foreground">
                    {n}.{i + 1}
                  </td>
                  <td className="font-medium">{r.field}</td>
                  <td>{r.iso}</td>
                  <td>{r.pll}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {d.bom.length > 0 && (
        <Section
          n={++n}
          title="Bill of material vs admin item list"
          count={d.bom.filter((b) => b.kind !== "notChecked").length}
          info={d.bom.filter((b) => b.kind === "notChecked").length}
        >
          <table className="table table-compact w-full text-xs">
            <thead>
              <tr>
                <th className="w-12">Ref</th>
                <th className="w-20">Sheet / class</th>
                <th className="w-10">Item</th>
                <th className="w-16">Size</th>
                <th>BOM item</th>
                <th>Problem</th>
              </tr>
            </thead>
            <tbody>
              {d.bom.map((r, i) => (
                <tr key={i} className={r.kind === "notChecked" ? "text-muted-foreground" : ""}>
                  <td className="tabular-nums text-muted-foreground">
                    {n}.{i + 1}
                  </td>
                  <td className="whitespace-nowrap">
                    {r.sheet}
                    <br />
                    <span className="text-muted-foreground">{r.specClass}</span>
                  </td>
                  <td className="tabular-nums">{r.itemNo}</td>
                  <td className="whitespace-nowrap">{r.size}</td>
                  <td>
                    {r.description}
                    <span className="text-muted-foreground"> &middot; qty {r.quantity}</span>
                  </td>
                  <td>
                    {r.kind === "notChecked" ? (
                      <span className="italic">For information: {r.problem}</span>
                    ) : (
                      <>
                        <span className={r.kind === "missing" ? "font-medium text-danger" : "font-medium text-warning"}>
                          {r.kind === "missing" ? "Not in admin list" : "Differs from admin list"}
                        </span>
                        <br />
                        {r.problem}
                      </>
                    )}
                    {r.adminLine && r.kind === "deviation" && <span className="block text-muted-foreground">Admin: {r.adminLine}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {d.routing.length + d.fittings.length > 0 && (
        <Section
          n={++n}
          title="Drawing vs P&ID"
          count={d.routing.length + d.fittings.filter((f) => f.note == null).length}
          info={d.fittings.filter((f) => f.note != null).length}
        >
          {d.routing.length > 0 && (
            <table className="table table-compact mb-3 w-full text-xs">
              <thead>
                <tr>
                  <th className="w-12">Ref</th>
                  <th>Item</th>
                  <th>Drawing says</th>
                  <th>P&amp;ID says</th>
                  <th>Problem</th>
                </tr>
              </thead>
              <tbody>
                {d.routing.map((r, i) => (
                  <tr key={r.field}>
                    <td className="tabular-nums text-muted-foreground">
                      {n}.{i + 1}
                    </td>
                    <td className="font-medium">{r.field}</td>
                    <td>{r.iso}</td>
                    <td>{r.pid}</td>
                    <td>{r.problem}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {d.fittings.length > 0 && (
            <table className="table table-compact w-full text-xs">
              <thead>
                <tr>
                  <th className="w-12">Ref</th>
                  <th>In-line component</th>
                  <th className="w-16">Size</th>
                  <th className="w-24">Class</th>
                  <th className="w-14">Drawing</th>
                  <th className="w-14">P&amp;ID</th>
                  <th>Problem</th>
                </tr>
              </thead>
              <tbody>
                {d.fittings.map((r, i) => (
                  <tr key={i} className={r.note ? "text-muted-foreground" : ""}>
                    <td className="tabular-nums text-muted-foreground">
                      {n}.{d.routing.length + i + 1}
                    </td>
                    <td className={r.note ? "" : "font-medium"}>{r.component}</td>
                    <td className="whitespace-nowrap">{r.size}</td>
                    <td>{r.specClass}</td>
                    <td className="tabular-nums">{r.isoCount}</td>
                    <td className="tabular-nums">{r.pidCount}</td>
                    <td>
                      {r.problem}
                      {r.note && <span className="block italic">For information: {r.note}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}

      {d.hookup.length > 0 && (
        <Section
          n={++n}
          title="Instrument hook-up"
          count={d.hookup.filter((h) => h.noTypical == null).reduce((c, h) => c + Math.max(h.missing.length, 1), 0)}
          info={d.hookup.filter((h) => h.noTypical != null).length}
        >
          <table className="table table-compact w-full text-xs">
            <thead>
              <tr>
                <th className="w-12">Ref</th>
                <th>Instrument</th>
                <th>Required by the hook-up typical, not found on the drawing</th>
                <th className="w-16">Size</th>
                <th className="w-12">Qty</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                let ref = 0;
                return d.hookup.flatMap((h) => {
                  if (h.noTypical != null) {
                    ref += 1;
                    return [
                      <tr key={h.instrument} className="text-muted-foreground">
                        <td className="tabular-nums">
                          {n}.{ref}
                        </td>
                        <td>
                          <span className="font-mono">{h.instrument}</span>
                          <br />
                          {h.label}
                        </td>
                        <td colSpan={3} className="italic">
                          For information: {h.noTypical}
                        </td>
                      </tr>,
                    ];
                  }
                  return (h.missing.length > 0 ? h.missing : [{ item: "-", description: "Piping items missing", size: "-", quantity: "-" }]).map((m, mi) => {
                    ref += 1;
                    return (
                      <tr key={`${h.instrument}-${mi}`}>
                        <td className="tabular-nums text-muted-foreground">
                          {n}.{ref}
                        </td>
                        <td>
                          {mi === 0 && (
                            <>
                              <span className="font-mono font-medium">{h.instrument}</span>
                              <br />
                              <span className="text-muted-foreground">{h.label}</span>
                            </>
                          )}
                        </td>
                        <td>{m.description}</td>
                        <td className="whitespace-nowrap">{m.size}</td>
                        <td className="tabular-nums">{m.quantity}</td>
                      </tr>
                    );
                  });
                });
              })()}
            </tbody>
          </table>
        </Section>
      )}

      {d.spooling.length > 0 && (
        <Section n={++n} title="Spooling" count={d.spooling.length}>
          <table className="table table-compact w-full text-xs">
            <thead>
              <tr>
                <th className="w-12">Ref</th>
                <th className="w-20">Sheet</th>
                <th className="w-16">Weld</th>
                <th className="w-24">Type</th>
                <th className="w-16">Size</th>
                <th>Problem</th>
              </tr>
            </thead>
            <tbody>
              {d.spooling.map((r, i) => (
                <tr key={i}>
                  <td className="tabular-nums text-muted-foreground">
                    {n}.{i + 1}
                  </td>
                  <td className="whitespace-nowrap">{r.sheet}</td>
                  <td className="tabular-nums font-medium">{r.weld}</td>
                  <td>{r.weldType}</td>
                  <td className="whitespace-nowrap">{r.size}</td>
                  <td>{r.problem}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {d.containers.length > 0 && (
        <Section
          n={++n}
          title="Container check (20ft)"
          count={d.containers.filter((c) => c.note == null).length}
          info={d.containers.filter((c) => c.note != null).length}
        >
          <table className="table table-compact w-full text-xs">
            <thead>
              <tr>
                <th className="w-12">Ref</th>
                <th className="w-20">Sheet</th>
                <th className="w-20">Spool</th>
                <th>Size read from the drawing (mm)</th>
                <th>Problem</th>
              </tr>
            </thead>
            <tbody>
              {d.containers.map((r, i) => (
                <tr key={i} className={r.note ? "text-muted-foreground" : ""}>
                  <td className="tabular-nums text-muted-foreground">
                    {n}.{i + 1}
                  </td>
                  <td className="whitespace-nowrap">{r.sheet}</td>
                  <td className={r.note ? "" : "font-medium"}>{r.spool}</td>
                  <td>{r.size}</td>
                  <td>
                    {r.problem}
                    {r.note && <span className="block italic">For information: {r.note}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {(d.clear.length > 0 || d.notChecked.length > 0) && (
        <div className="mt-6 border-t pt-3 text-xs text-muted-foreground">
          {d.clear.length > 0 && (
            <p>
              <span className="font-medium text-foreground">Checked, no errors:</span> {d.clear.join(" · ")}
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

  const summary = await summariseLine(id, line);
  const report = buildIsoReport(summary);
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
        {report && <PrintButton />}
      </div>

      <article className="report card">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
          <div className="min-w-0">
            <p className="eyebrow">ISO check report</p>
            <h1 className="mt-1 break-all font-mono text-lg font-semibold">{line.lineNumber}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {project.name}
              {line.revision ? ` · REV ${line.revision}` : ""}
            </p>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            <dt className="text-muted-foreground">Date</dt>
            <dd>{today}</dd>
            <dt className="text-muted-foreground">Checked by</dt>
            <dd>{session.name ?? session.email}</dd>
            <dt className="text-muted-foreground">Sheets</dt>
            <dd>{line.sheets}</dd>
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

            <p className="mt-6 border-t pt-3 text-[11px] text-muted-foreground">
              Generated from the drawing&apos;s extracted data. Refs (e.g. 2.3) identify each finding for the designer&apos;s reply. Rows marked &ldquo;for information&rdquo; are shown because the checks flag them, but are not counted as errors.
            </p>
          </>
        )}
      </article>
    </div>
  );
}
