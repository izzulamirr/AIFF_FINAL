import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { CollapsibleCard } from "@/components/ui/CollapsibleCard";
import { Badge, EmptyState, Stat } from "@/components/ui/primitives";
import { BomSheets, DesignBasisTable, FittingsMatchGroups, RoutingTable } from "@/components/checks/IsoCheckTables";
import { HookupResults } from "@/components/checks/HookupResults";
import { IconBox, IconChevronRight, IconClipboard, IconCompare, IconFile, IconGauge, IconLibrary, IconSpool, IconTable } from "@/components/ui/icons";
import { ProgressBar } from "@/components/progress/ProgressBar";
import { findLine, isoLinesOf } from "@/lib/isoLines";
import { summariseLine, type IsoDrawingChecks, type LineSummary } from "@/lib/lineSummary";
import { progressOfProject } from "@/lib/progress";
import { ContainerFit } from "../../containers/ContainerFit";
import { SpoolSheets } from "../../spooling/SpoolSheets";
import { ReviewControl } from "./ReviewControl";

// A project's ISO line numbers and, once one is chosen, every review of that line
// -- each folded to a head of status badges, with the full data one click inside.
// Nothing links away: the data is here.
//
// Two people use it:
//
//   A checker (plain user)  at /projects/[id]: step 3 and 4 of Organization ->
//                           Project -> LINE -> its reviews. They can mark a line done,
//                           and that is what counts as progress.
//   Document Control        at /review: the same reviews, to check the data itself.
//                           It sees who has marked a line done but cannot mark one
//                           itself -- what Document Control does here never counts
//                           toward progress, and the actions refuse it as well.
//
// A checker reads the ISOs; everything else in the project -- P&IDs, the line list,
// specs, the cutting drawings -- is Document Control's.

/** Where this view's own links go: the two routes it is shown on differ. */
export interface LineReviewLinks {
  /** The project's list of lines. */
  list: string;
  /** One line's page. */
  line: (lineNumber: string) => string;
  /** Back from the list, if there is anywhere to go. */
  back?: { href: string; label: string };
}

const Note = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>;

const UNAVAILABLE = "This could not be worked out. Try again in a moment.";

// A line carried by two drawings is reviewed in each, not added up -- the same item
// in a full set and a partial one would count twice. With one drawing there is
// nothing to label.
function Drawings({ items }: { items: Array<{ key: string; fileName: string; body: ReactNode }> }) {
  const many = items.length > 1;
  return (
    <div className="flex flex-col gap-8">
      {items.map((item) => (
        <div key={item.key} className="flex flex-col gap-4">
          {many && <p className="break-all border-b pb-2 text-sm font-semibold">{item.fileName}</p>}
          {item.body}
        </div>
      ))}
    </div>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const most = (values: number[]) => Math.max(0, ...values);

// ---- Spooling -------------------------------------------------------------
function SpoolingBadges({ spooling: s }: { spooling: LineSummary["spooling"] }) {
  if (!s) return null;
  const t = s.totals;
  if (t.spools === 0 && t.welds === 0) return <Badge>No data yet</Badge>;
  return (
    <>
      <Badge>{plural(t.spools, "spool")}</Badge>
      <Badge>{plural(t.welds, "weld")}</Badge>
      <Badge>{plural(t.sheets, "sheet")}</Badge>
      {t.disagreeing > 0 && (
        <Badge tone="warning" dot>
          {plural(t.disagreeing, "mismatch", "mismatches")} against the drawing
        </Badge>
      )}
      {t.unassigned > 0 && (
        <Badge tone="warning" dot>
          {t.unassigned} with no spool
        </Badge>
      )}
      {t.disagreeing === 0 && t.unassigned === 0 && (
        <Badge tone="success" dot>
          No mismatches
        </Badge>
      )}
    </>
  );
}

function SpoolingBody({ spooling: s }: { spooling: LineSummary["spooling"] }) {
  if (!s) return <Note>{UNAVAILABLE}</Note>;
  if (s.docs.length === 0) return <Note>No spool or weld data has been read for this line yet.</Note>;
  return (
    <div className="[&_.card]:shadow-none">
      <Drawings
        items={s.docs.map((d) => ({
          key: d.id,
          fileName: d.fileName,
          body: (
            <div className="flex flex-col gap-4">
              <SpoolSheets sheets={d.sheets} />
            </div>
          ),
        }))}
      />
    </div>
  );
}

// ---- Instrument Hookup ----------------------------------------------------
function HookupBadges({ hookup: h }: { hookup: LineSummary["hookup"] }) {
  if (!h) return null;
  if (h.typicals === 0) return <Badge>No hook-up typicals yet</Badge>;
  if (h.drawings.every((d) => d.instruments === 0)) return <Badge>No instruments on the ISO</Badge>;
  const withMissing = most(h.drawings.map((d) => d.withMissing));
  const noTypical = most(h.drawings.map((d) => d.noTypical));
  return (
    <>
      <Badge>{plural(most(h.drawings.map((d) => d.instruments)), "instrument")}</Badge>
      {withMissing > 0 && (
        <Badge tone="danger" dot>
          {withMissing} with items missing
        </Badge>
      )}
      {noTypical > 0 && (
        <Badge tone="warning" dot>
          {noTypical} with no typical
        </Badge>
      )}
      {withMissing === 0 && noTypical === 0 && (
        <Badge tone="success" dot>
          All matched
        </Badge>
      )}
    </>
  );
}

function HookupBody({ hookup: h }: { hookup: LineSummary["hookup"] }) {
  if (!h) return <Note>{UNAVAILABLE}</Note>;
  if (h.typicals === 0) return <Note>No hook-up typicals are available for this project yet, so this line cannot be checked.</Note>;
  if (h.drawings.length === 0) return <Note>There is no ISO drawing for this line to check.</Note>;
  return (
    <Drawings
      items={h.drawings.map((d) => ({
        key: d.documentId,
        fileName: d.fileName,
        body:
          d.verification.results.length > 0 ? (
            <HookupResults {...d.verification} />
          ) : (
            <Note>No instruments in this ISO&apos;s bill of material, so there is no hook-up to check.</Note>
          ),
      }))}
    />
  );
}

// ---- Container check ------------------------------------------------------
function ContainersBadges({ containers: c }: { containers: LineSummary["containers"] }) {
  if (!c) return null;
  const f = c.fit;
  if (f.total === 0) return <Badge>No spools yet</Badge>;
  // The container page's own header lumps a near miss in with "will not ship"; so does this.
  const wontShip = f.noFit + f.nearMiss;
  return (
    <>
      <Badge>{plural(f.total, "spool")}</Badge>
      {f.sized === 0 ? (
        <Badge>No sizes read</Badge>
      ) : wontShip === 0 ? (
        <Badge tone="success" dot>
          All ship in a 20ft
        </Badge>
      ) : (
        <Badge tone="danger" dot>
          {wontShip} will not ship
        </Badge>
      )}
      {f.marginal > 0 && (
        <Badge tone="warning" dot>
          {f.marginal} marginal
        </Badge>
      )}
      {f.withFieldWelds > 0 && (
        <Badge tone="warning" dot>
          {f.withFieldWelds} with a field weld
        </Badge>
      )}
      {f.total - f.sized > 0 && f.sized > 0 && <Badge>{f.total - f.sized} size not read</Badge>}
    </>
  );
}

function ContainersBody({ containers: c }: { containers: LineSummary["containers"] }) {
  if (!c) return <Note>{UNAVAILABLE}</Note>;
  if (c.docs.length === 0) return <Note>No spools have been read for this line yet.</Note>;
  return (
    <div className="[&_.card]:shadow-none">
      <Drawings items={c.docs.map((d) => ({ key: d.id, fileName: d.fileName, body: <ContainerFit spools={d.spools} /> }))} />
    </div>
  );
}

// ---- ISO vs PLL -----------------------------------------------------------
function PllBadges({ drawings }: { drawings: IsoDrawingChecks[] }) {
  if (drawings.every((d) => d.pll.state === "none")) return <Badge>No PLL yet</Badge>;
  if (drawings.some((d) => d.pll.state === "notFound")) {
    return (
      <Badge tone="danger" dot>
        Not in the PLL
      </Badge>
    );
  }
  const mismatch = most(drawings.map((d) => d.pll.rows.filter((r) => r.status === "mismatch").length));
  return mismatch > 0 ? (
    <Badge tone="danger" dot>
      {plural(mismatch, "mismatch", "mismatches")}
    </Badge>
  ) : (
    <Badge tone="success" dot>
      All match
    </Badge>
  );
}

function PllBody({ drawings }: { drawings: IsoDrawingChecks[] }) {
  return (
    <Drawings
      items={drawings.map((d) => ({
        key: d.documentId,
        fileName: d.fileName,
        body:
          d.pll.state === "none" ? (
            <Note>No line list (PLL) has been extracted for this project yet, so this line cannot be compared.</Note>
          ) : d.pll.state === "notFound" ? (
            <div>
              <Badge tone="danger" dot>
                This line is not in the line list (PLL)
              </Badge>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {d.pll.against && <p className="text-xs text-muted-foreground">Compared against {d.pll.against}</p>}
              <DesignBasisTable rows={d.pll.rows} />
            </div>
          ),
      }))}
    />
  );
}

// ---- ISO vs P&ID ----------------------------------------------------------
function PidBadges({ drawings }: { drawings: IsoDrawingChecks[] }) {
  if (drawings.every((d) => d.pid.state === "none")) return <Badge>No P&amp;ID yet</Badge>;
  if (drawings.some((d) => d.pid.state === "notFound")) {
    return (
      <Badge tone="danger" dot>
        Not on any P&amp;ID
      </Badge>
    );
  }
  const routingMismatch = most(drawings.map((d) => d.pid.routing.mismatch));
  const onlyOne = most(drawings.map((d) => d.pid.fittings.isoOnly + d.pid.fittings.pidOnly));
  const countMismatch = most(drawings.map((d) => d.pid.fittings.countMismatch));
  return (
    <>
      {routingMismatch > 0 && (
        <Badge tone="danger" dot>
          {plural(routingMismatch, "routing mismatch", "routing mismatches")}
        </Badge>
      )}
      {onlyOne > 0 && (
        <Badge tone="danger" dot>
          {onlyOne} on one document only
        </Badge>
      )}
      {countMismatch > 0 && (
        <Badge tone="warning" dot>
          {plural(countMismatch, "count mismatch", "count mismatches")}
        </Badge>
      )}
      {routingMismatch === 0 && onlyOne === 0 && countMismatch === 0 && (
        <Badge tone="success" dot>
          All match
        </Badge>
      )}
    </>
  );
}

function PidBody({ drawings }: { drawings: IsoDrawingChecks[] }) {
  return (
    <Drawings
      items={drawings.map((d) => ({
        key: d.documentId,
        fileName: d.fileName,
        body:
          d.pid.state === "none" ? (
            <Note>No P&amp;ID has been extracted for this project yet, so this line cannot be compared.</Note>
          ) : d.pid.state === "notFound" ? (
            <div>
              <Badge tone="danger" dot>
                This line is not found on any P&amp;ID
              </Badge>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {d.pid.against.length > 0 && <p className="text-xs text-muted-foreground">Compared against {d.pid.against.join(", ")}</p>}
              <div>
                <p className="eyebrow mb-3">Routing &amp; fittings</p>
                <RoutingTable rows={d.pid.routingRows} />
              </div>
              <div>
                <p className="eyebrow mb-3">Fittings match</p>
                {d.pid.fittingGroups.length > 0 ? <FittingsMatchGroups groups={d.pid.fittingGroups} /> : <Note>No in-line components to pair.</Note>}
              </div>
            </div>
          ),
      }))}
    />
  );
}

// ---- BOM vs admin specs: a TEMPLATE ---------------------------------------
// The admin specs are not in the app yet, so there is nothing to check the bill of
// material against. This shows the shape the result will take -- greyed, dashed,
// no figures -- and, so the card is not just empty, the BOM as extracted, which
// is what will be checked.
function BomBody({ drawings }: { drawings: IsoDrawingChecks[] }) {
  const withBom = drawings.filter((d) => d.bom.sheets > 0);
  return (
    <div className="flex flex-col gap-6">
      <p className="callout max-w-3xl">
        Admin specs have not been added to the app yet. Once they are, every BOM item on this line will be checked against the spec for its
        material class, and the result will appear here.
      </p>

      {/* What the result will look like. Placeholders, not data. */}
      <div aria-hidden="true" className="flex flex-wrap gap-4 opacity-60 [&_.stat]:border-dashed [&_.stat]:shadow-none">
        <Stat label="BOM items checked" value="—" />
        <Stat label="Match the spec" value="—" />
        <Stat label="Deviations" value="—" />
        <Stat label="Not in the spec" value="—" />
      </div>

      <div>
        <p className="eyebrow mb-3">This line&apos;s BOM, as extracted</p>
        {withBom.length === 0 ? (
          <Note>No bill of material has been read for this line yet.</Note>
        ) : (
          <Drawings items={withBom.map((d) => ({ key: d.documentId, fileName: d.fileName, body: <BomSheets sheets={d.bom.sheetData} /> }))} />
        )}
      </div>
    </div>
  );
}

export async function LineReviewView({
  projectId,
  projectName,
  requestedLine,
  links,
  canMark,
}: {
  projectId: string;
  projectName: string;
  requestedLine: string | undefined;
  links: LineReviewLinks;
  /** Whether this person can mark a line done. Only a checker can; it is what counts as progress. */
  canMark: boolean;
}) {
  const lines = await isoLinesOf(projectId);
  const line = findLine(lines, requestedLine);
  // Which lines are done, and the total Document Control stated. Null until the
  // progress tables exist (see lib/progress.ts): the controls are then left off
  // rather than shown to fail.
  const progress = await progressOfProject(projectId);

  if (line) {
    const summary = await summariseLine(projectId, line);
    const checks = summary.checks;

    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title={<span className="break-all font-mono text-xl">{line.lineNumber}</span>}
          back={{ href: links.list, label: projectName }}
          description="Every review for this line. Open one to see all of its data."
          actions={
            progress ? (
              <ReviewControl
                projectId={projectId}
                lineNumber={line.lineNumber}
                review={progress.reviews.find((r) => r.lineKey === line.key)}
                readOnly={!canMark}
              />
            ) : undefined
          }
          meta={
            <>
              <Badge>{plural(line.sheets, "sheet")}</Badge>
              {summary.drawings.length > 1 && <Badge>{summary.drawings.length} drawings</Badge>}
            </>
          }
        />

        {summary.drawings.length > 1 && (
          <p className="callout max-w-4xl">
            This line is carried by {summary.drawings.length} drawings ({summary.drawings.map((d) => d.fileName).join(", ")}). Each review
            shows the drawings one after the other; the counts in a heading are for the drawing with the most.
          </p>
        )}

        {/* The order a line is reviewed in: what its own title block says against the
            line list, what it is made of (the MTO), how it sits against the P&IDs, then
            its instruments, its spools, and whether they ship. ISO vs PLL is open --
            the check a reader wants to see field by field before anything else. */}
        <CollapsibleCard
          defaultOpen
          icon={IconTable}
          title="ISO vs PLL"
          text="The design basis in this line's title block against the line list."
          badges={checks ? <PllBadges drawings={checks} /> : undefined}
        >
          {checks ? <PllBody drawings={checks} /> : <Note>{UNAVAILABLE}</Note>}
        </CollapsibleCard>

        <CollapsibleCard
          icon={IconClipboard}
          title="MTO (admin specs vs BOM)"
          text="This line's bill of material checked against the admin piping specs."
          status={<Badge tone="info">Template</Badge>}
          badges={
            checks && checks.some((d) => d.bom.items > 0) ? <Badge>{plural(most(checks.map((d) => d.bom.items)), "BOM item")}</Badge> : undefined
          }
        >
          {checks ? <BomBody drawings={checks} /> : <Note>{UNAVAILABLE}</Note>}
        </CollapsibleCard>

        <CollapsibleCard
          icon={IconCompare}
          title="ISO vs P&ID"
          text="This line's routing and in-line components against the project's P&IDs."
          badges={checks ? <PidBadges drawings={checks} /> : undefined}
        >
          {checks ? <PidBody drawings={checks} /> : <Note>{UNAVAILABLE}</Note>}
        </CollapsibleCard>

        <CollapsibleCard
          icon={IconGauge}
          title="Instrument Hookup"
          text="This line's instruments checked against the project's hook-up typicals."
          badges={<HookupBadges hookup={summary.hookup} />}
        >
          <HookupBody hookup={summary.hookup} />
        </CollapsibleCard>

        <CollapsibleCard
          icon={IconSpool}
          title="Spooling"
          text="The spools and welds read off this line's isometric."
          badges={<SpoolingBadges spooling={summary.spooling} />}
        >
          <SpoolingBody spooling={summary.spooling} />
        </CollapsibleCard>

        <CollapsibleCard
          icon={IconBox}
          title="Container check"
          text="Whether each of this line's spools ships in a 20ft container."
          badges={<ContainersBadges containers={summary.containers} />}
        >
          <ContainersBody containers={summary.containers} />
        </CollapsibleCard>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={projectName}
        back={links.back}
        description="Choose a line number to review its spools, hook-up and container check."
        actions={
          <Link href={`/library?project=${projectId}`} className="btn btn-secondary">
            <IconLibrary size={16} />
            Library
          </Link>
        }
      />

      {/* How far through the project the checkers are -- against the total Document
          Control stated, or, if it has not stated one, the lines uploaded so far. */}
      {progress && lines.length > 0 && (
        <div className="card flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium">Progress</p>
            <p className="text-sm text-muted-foreground">
              {progress.reviews.length} of {progress.total ?? lines.length} {progress.total == null ? "uploaded " : ""}lines checked
            </p>
          </div>
          <ProgressBar value={progress.reviews.length} max={progress.total ?? lines.length} label="Lines checked" />
        </div>
      )}

      {lines.length === 0 ? (
        <div className="card">
          <EmptyState icon={<IconFile />} title="No line numbers yet">
            Document Control has not uploaded any isometrics to this project, or they are still being read.
          </EmptyState>
        </div>
      ) : (
        <section className="card card-flush">
          <div className="card-header">
            <h2 className="card-title">
              Line numbers <span className="font-normal text-muted-foreground">({lines.length})</span>
            </h2>
          </div>
          <ul className="divide-y divide-border">
            {lines.map((l) => (
              <li key={l.key}>
                <Link
                  href={links.line(l.lineNumber)}
                  className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-muted/60"
                >
                  <IconFile size={17} className="flex-none text-muted-foreground" />
                  <span className="break-all font-mono text-[0.8125rem] font-medium">{l.lineNumber}</span>
                  <Badge>{plural(l.sheets, "sheet")}</Badge>
                  {progress?.reviews.some((r) => r.lineKey === l.key) && (
                    <Badge tone="success" dot>
                      Done
                    </Badge>
                  )}
                  <IconChevronRight size={16} className="ml-auto flex-none text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
