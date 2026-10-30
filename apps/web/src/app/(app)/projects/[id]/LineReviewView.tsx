import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { CollapsibleCard } from "@/components/ui/CollapsibleCard";
import { Alert, Badge, EmptyState, Stat } from "@/components/ui/primitives";
import { BomSheets, DesignBasisTable, FittingsMatchGroups, MtoSheets, RoutingTable } from "@/components/checks/IsoCheckTables";
import { HookupResults } from "@/components/checks/HookupResults";
import { IconBox, IconChevronRight, IconClipboard, IconCompare, IconFile, IconGauge, IconLibrary, IconSpool, IconSupport, IconTable } from "@/components/ui/icons";
import { supportProblems } from "@/lib/supports";
import { ProgressBar } from "@/components/progress/ProgressBar";
import { findLine, isoLinesOf, type IsoLine } from "@/lib/isoLines";
import { summariseLine, type IsoDrawingChecks, type LineSummary } from "@/lib/lineSummary";
import { countProgress, lineStateOf, progressOfProject } from "@/lib/progress";
import {
  CHANGED,
  changeSummary,
  compareSources,
  sourcesOfLines,
  type LineSource,
  type SourceComparison,
  type SourceKind,
} from "@/lib/lineSources";
import { CheckedAgainst } from "./CheckedAgainst";
import { CheckPrints } from "./CheckPrints";
import { checkPrintLabel, checkPrintsOf, nextStep, printsOfLine, printsOfRevision } from "@/lib/checkPrints";
import { buildIsoReport } from "@/lib/isoReport";
import { documentFamily } from "@easy/shared";
import { ContainerFit } from "../../containers/ContainerFit";
import { SpoolSheets } from "../../spooling/SpoolSheets";
import { SupportSheets } from "../../supports/SupportSheets";
import { MarkingNotSetUp, MarkingNotSetUpBadge, ReviewControl } from "./ReviewControl";

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
  /**
   * This project's library, if this route should offer one.
   *
   * The CALLER decides, because the two routes are not in the same position. A
   * checker has no sidebar at all, so on their route this button is their only
   * way to the library and has to be here. Document Control reaches it from the
   * sidebar and from the project page, so on `/review` it was a third copy
   * sitting in the corner of a page about lines.
   */
  library?: string;
}

const Note = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>;

const UNAVAILABLE = "This could not be worked out. Try again in a moment.";

const uploaded = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

// A document's revision as a register writes it: the letter or number from its
// file name, or -- where it carries none -- the date it was uploaded.
const revLabel = (s: LineSource) => s.revision ?? uploaded.format(new Date(s.uploadedAt));

// The documents a line is checked against, as one quiet strip under its number.
// Most of the time every one of them is unchanged, and then it reads as plain
// reference text. Only a revision that has moved on since the line was checked --
// or, on a line nobody has checked yet, one issued after an earlier revision --
// is lifted out as an amber "D → E", so the eye goes straight to what changed.
// A kind of document the line does not use is left out rather than listed empty.
const STRIP_KINDS: Array<{ kinds: SourceKind[]; label: string }> = [
  { kinds: ["iso"], label: "ISO" },
  { kinds: ["pid"], label: "P&ID" },
  { kinds: ["pll"], label: "Line list" },
  { kinds: ["client_spec"], label: "Client spec" },
  { kinds: ["hookup"], label: "Hook-up" },
  { kinds: ["legend"], label: "Legend" },
];

function DocumentStrip({
  now,
  comparisons,
  state,
  checkedAt,
}: {
  now: LineSource[];
  comparisons: SourceComparison[];
  state: "open" | "done" | "recheck";
  checkedAt?: Date;
}) {
  const items = STRIP_KINDS.flatMap(({ kinds, label }) => {
    const docs = now.filter((s) => kinds.includes(s.kind));
    const moved = comparisons.find((c) => kinds.includes(c.kind) && CHANGED.has(c.status));
    const current = [...new Set(docs.map(revLabel))];
    const files = docs.map((d) => d.fileName).join("\n");

    if (moved) {
      const was = moved.was ? revLabel(moved.was) : checkedAt ? `before ${uploaded.format(checkedAt)}` : "earlier";
      const to = moved.now ? revLabel(moved.now) : "removed";
      const hint =
        moved.status === "rowChanged"
          ? "A new line list was issued and this line's row in it changed."
          : `Checked at ${was}; ${to} has been issued since.`;
      return [{ label, text: moved.status === "rowChanged" ? "row changed" : `${was} → ${to}`, changed: true, hint }];
    }
    if (docs.length === 0) return [];
    // Never checked, but already revised: the first revision is the one it was
    // issued against, and the current one has come after it.
    const first =
      state === "open"
        ? docs
            .flatMap((d) => (d.earlier ?? []).slice(0, 1))
            .map((e) => e.revision ?? uploaded.format(new Date(e.uploadedAt)))
            .find((rev) => !current.includes(rev))
        : undefined;
    if (first) {
      return [{ label, text: `${first} → ${current.join(", ")}`, changed: true, hint: `${first} was issued first and never checked; ${current.join(", ")} has been issued since.` }];
    }
    return [{ label, text: current.join(", "), changed: false, hint: files }];
  });

  return (
    <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
      {items.map((item) =>
        item.changed ? (
          <li
            key={item.label}
            title={item.hint}
            className="inline-flex items-center gap-1.5 rounded-full border border-warning-border bg-warning-soft px-2.5 py-0.5 font-medium text-warning"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-warning-solid" aria-hidden="true" />
            <span className="text-foreground">{item.label}</span>
            {item.text}
          </li>
        ) : (
          <li key={item.label} title={item.hint} className="text-muted-foreground">
            <span className="font-medium text-foreground/80">{item.label}</span> {item.text}
          </li>
        )
      )}
    </ul>
  );
}

// Earlier revisions of this line, and -- the case that matters more -- a warning
// when the revisions could NOT be read.
//
// Nothing is deleted when a drawing is superseded: its extraction cost real
// money to produce, and comparing what changed between two revisions is a normal
// thing to want. It is only excluded from the checks, which is what "current"
// means. So each one stays one click away.
//
// Where the REV boxes could not be read or ordered, EVERY drawing is left in
// force (see lib/isoLines.ts) and this says so. That is the safe direction --
// showing an extra drawing beats hiding the real one -- but silently merging two
// revisions' spools and BOM is exactly the confusion this feature exists to end,
// so it must not be quiet about it.
function SupersededDrawings({ line, hrefOf }: { line: IsoLine; hrefOf: (documentId: string) => string }) {
  const multipleUnordered = !line.revisionKnown && line.documentIds.length > 1;
  if (line.superseded.length === 0 && !multipleUnordered) return null;

  if (multipleUnordered) {
    return (
      <Alert tone="warning">
        <strong>This line is carried by {line.documentIds.length} drawings and their revisions could not be read.</strong> Every one of
        them is being checked, so a superseded drawing&apos;s spools and bill of material may be mixed in with the current one&apos;s. Check
        the REV box on each drawing&apos;s title block.
      </Alert>
    );
  }

  return (
    <section className="card card-flush">
      <div className="card-header">
        <h2 className="card-title">Earlier revisions</h2>
        <Badge>{plural(line.superseded.length, "drawing")}</Badge>
      </div>
      <ul className="divide-y divide-border">
        {line.superseded.map((d) => (
          <li key={d.documentId}>
            <Link
              href={hrefOf(d.documentId)}
              className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-muted/60"
            >
              <IconFile size={17} className="flex-none text-muted-foreground" />
              <Badge>REV {d.revision}</Badge>
              <span className="min-w-0 truncate text-sm">{d.fileName}</span>
              <span className="ml-auto flex flex-none items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  {plural(d.sheets, "sheet")} &middot; uploaded {uploaded.format(d.uploadedAt)}
                </span>
                <IconChevronRight size={16} className="text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="border-t px-5 py-3 text-xs text-muted-foreground">
        Superseded by rev {line.revision}. These are kept for comparison and are left out of every check on this page.
      </p>
    </section>
  );
}

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
        <Badge tone="info" dot>
          {noTypical} pending vendor data
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

// ---- Pipe supports --------------------------------------------------------
// Counted the way the line's error report counts them (lib/isoReport.ts): a
// breach of the span standard is an error, a "check" is for a person to look
// at, and a drawing whose supports have not been located yet is not judged.
function SupportsBadges({ supports: s }: { supports: LineSummary["supports"] }) {
  if (!s) return null;
  if (s.docs.length === 0) return <Badge>No pipe in the BOM</Badge>;
  const read = s.docs.filter((d) => d.read);
  if (read.length === 0) return <Badge>Not read off the drawing yet</Badge>;
  const sheets = read.flatMap((d) => d.sheets);
  const problems = sheets.flatMap((sheet) => supportProblems(sheet));
  const errors = problems.filter((p) => p.severity === "error").length;
  const checks = problems.length - errors;
  const located = sheets.reduce((n, sheet) => n + sheet.points.length, 0);
  return (
    <>
      <Badge>{plural(located, "support")} on the drawing</Badge>
      {errors === 0 ? (
        <Badge tone="success" dot>
          Within the span standard
        </Badge>
      ) : (
        <Badge tone="danger" dot>
          {plural(errors, "problem")}
        </Badge>
      )}
      {checks > 0 && (
        <Badge tone="warning" dot>
          {checks} to check
        </Badge>
      )}
      {read.length < s.docs.length && <Badge>{s.docs.length - read.length} drawing not read yet</Badge>}
    </>
  );
}

function SupportsBody({ supports: s }: { supports: LineSummary["supports"] }) {
  if (!s) return <Note>{UNAVAILABLE}</Note>;
  if (s.docs.length === 0) return <Note>This line&apos;s bill of material has no pipe, so there is nothing to support.</Note>;
  return (
    <Drawings
      items={s.docs.map((d) => ({
        key: d.id,
        fileName: d.fileName,
        body: d.read ? (
          <SupportSheets sheets={d.sheets} />
        ) : (
          <Note>The BOM calls for supports, but they have not been located on this drawing yet, so the spans between them are not checked.</Note>
        ),
      }))}
    />
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
function PidBadges({ drawings, upRev }: { drawings: IsoDrawingChecks[]; upRev?: string }) {
  if (drawings.every((d) => d.pid.state === "none")) return <Badge>No P&amp;ID yet</Badge>;
  // Against a P&ID issued after the ISO, a difference is the ISO being behind, not
  // wrong: one amber count of the P&ID's changes instead of red error badges.
  if (upRev) {
    const changes = most(drawings.map((d) => d.pid.routing.mismatch + d.pid.fittings.isoOnly + d.pid.fittings.pidOnly + d.pid.fittings.countMismatch));
    return changes > 0 ? (
      <Badge tone="warning" dot>
        {`${plural(changes, "change")} in P&ID ${upRev} — ISO not revised yet`}
      </Badge>
    ) : (
      <Badge tone="success" dot>
        Matches P&amp;ID {upRev}
      </Badge>
    );
  }
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

/** Which revisions the ISO vs P&ID comparison is between, and the choices of each. */
interface PidContext {
  isoChoices: Array<{ label: string; note?: string; href: string; active: boolean }>;
  families: Array<{ name: string; choices: Array<{ label: string; note?: string; href: string; active: boolean }> }>;
  /** Set when the P&ID compared was issued after the one the ISO was drawn against. */
  upRev?: string;
  baseline?: string;
  baselineHref?: string;
}

function RevisionPicker({ context }: { context: PidContext }) {
  const chip = (c: { label: string; note?: string; href: string; active: boolean }) => (
    <Link key={c.href} href={c.href} scroll={false} className={`btn btn-xs ${c.active ? "btn-primary" : "btn-secondary"}`} aria-current={c.active ? "true" : undefined}>
      {c.label}
      {c.note && <span className="opacity-70">&middot; {c.note}</span>}
    </Link>
  );
  return (
    <div className={`flex flex-col gap-2.5 rounded-lg border px-4 py-3 ${context.upRev ? "border-warning-border bg-warning-soft" : "bg-muted/30"}`}>
      <p className="text-sm font-medium">Comparing these revisions</p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="w-16 text-muted-foreground">ISO</span>
        {context.isoChoices.map(chip)}
      </div>
      {context.families.map((f) => (
        <div key={f.name} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="w-16 text-muted-foreground" title={f.name}>
            P&amp;ID
          </span>
          {f.choices.map(chip)}
          <span className="break-all text-xs text-muted-foreground">{f.name}</span>
        </div>
      ))}
      {context.upRev && (
        <p className="text-xs">
          <strong>This ISO was drawn against P&amp;ID {context.baseline}.</strong> P&amp;ID {context.upRev} was issued after it, so the
          differences below are changes in the P&amp;ID that the ISO has not been revised to yet, not errors in the ISO.{" "}
          {context.baselineHref && (
            <Link href={context.baselineHref} scroll={false} className="link font-medium">
              Compare with P&amp;ID {context.baseline} instead
            </Link>
          )}
        </p>
      )}
    </div>
  );
}

function PidBody({ drawings, context }: { drawings: IsoDrawingChecks[]; context?: PidContext }) {
  return (
    <div className="flex flex-col gap-5">
    {context && (context.families.some((f) => f.choices.length > 1) || context.isoChoices.length > 1) && <RevisionPicker context={context} />}
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
                <RoutingTable rows={d.pid.routingRows} upRev={context?.upRev} />
              </div>
              <div>
                <p className="eyebrow mb-3">Fittings match</p>
                {d.pid.fittingGroups.length > 0 ? (
                  <FittingsMatchGroups groups={d.pid.fittingGroups} upRev={context?.upRev} />
                ) : (
                  <Note>No in-line components to pair.</Note>
                )}
              </div>
            </div>
          ),
      }))}
    />
    </div>
  );
}

// ---- MTO: BOM vs admin item list ------------------------------------------
// Real once an admin item list has been uploaded to the project (see
// lib/isoChecks.ts's mtoAdminAvailable) -- until then this is the shape the
// result will take, greyed and dashed, plus the BOM as extracted so the card is
// not just empty.
function MtoBody({ drawings, projectId }: { drawings: IsoDrawingChecks[]; projectId: string }) {
  const available = drawings.some((d) => d.mto.available);
  const withBom = drawings.filter((d) => d.bom.sheets > 0);
  const withMto = drawings.filter((d) => d.mto.sheetData.length > 0);

  const totals = drawings.reduce(
    (acc, d) => ({
      items: acc.items + d.mto.items,
      match: acc.match + d.mto.match,
      deviations: acc.deviations + d.mto.deviations,
      notInList: acc.notInList + d.mto.notInList,
      notChecked: acc.notChecked + d.mto.notChecked,
      pending: acc.pending + d.mto.pending,
    }),
    { items: 0, match: 0, deviations: 0, notInList: 0, notChecked: 0, pending: 0 }
  );

  if (!available) {
    return (
      <div className="flex flex-col gap-6">
        <p className="callout max-w-3xl">
          No admin item list has been uploaded for this project yet. Once one is added, every BOM item on this line will be looked up in it
          under the class it belongs to, and the result will appear here.
        </p>

        {/* What the result will look like. Placeholders, not data. */}
        <div aria-hidden="true" className="flex flex-wrap gap-4 opacity-60 [&_.stat]:border-dashed [&_.stat]:shadow-none">
          <Stat label="BOM items" value="—" />
          <Stat label="Match" value="—" />
          <Stat label="Wrong spec" value="—" />
          <Stat label="Not in spec" value="—" />
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

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-4">
        <Stat label="BOM items" value={totals.items} />
        <Stat label="Match" value={totals.match} tone={totals.match > 0 ? "good" : "neutral"} />
        {/* Counts wrong spec AND wrong class: both are a BOM item not to the spec it should be. */}
        <Stat label="Wrong spec" value={totals.deviations} tone={totals.deviations > 0 ? "danger" : "neutral"} />
        <Stat label="Not in spec" value={totals.notInList} tone={totals.notInList > 0 ? "danger" : "neutral"} />
        <Stat label="Not checked" value={totals.notChecked} />
        {/* Waiting on the client or a vendor -- not an error, and listed per sheet in the report. */}
        <Stat label="Pending / on hold" value={totals.pending} />
      </div>

      {withMto.length === 0 ? (
        <Note>No bill of material has been read for this line yet.</Note>
      ) : (
        <Drawings
          items={withMto.map((d) => ({
            key: d.documentId,
            fileName: d.fileName,
            body: <MtoSheets sheets={d.mto.sheetData} marking={d.mto.holdsEditable ? { projectId, documentId: d.documentId } : undefined} />,
          }))}
        />
      )}
    </div>
  );
}

export async function LineReviewView({
  projectId,
  projectName,
  listTitle,
  requestedLine,
  requestedDrawing,
  requestedPid,
  links,
  canMark,
}: {
  projectId: string;
  projectName: string;
  /**
   * What to head the list of lines with. Defaults to the project's name, which
   * is right where the back link goes somewhere ELSE -- a checker's "Projects".
   * Where the back link goes to the project itself, the name would be printed
   * twice, once as the way back and once as the title, so `/review` passes the
   * name of the feature instead.
   */
  listTitle?: string;
  requestedLine: string | undefined;
  /** An EARLIER revision of the line to show instead of the current one (`?rev=<documentId>`). */
  requestedDrawing?: string;
  /** A P&ID revision to compare against instead of the latest (`?pid=<documentId>`). */
  requestedPid?: string;
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
  // Every check print in the project -- null until the table exists.
  const prints = await checkPrintsOf(projectId);
  // What each line's checks are based on now -- the ISO, its P&IDs, its line list
  // row, its specs -- so a "Done" made against something since replaced shows as
  // needing a re-check, here and on every line.
  const sources = await sourcesOfLines(projectId, lines);
  const counts = countProgress(progress?.reviews ?? [], lines, sources);

  // Each line's state, and in a few words what changed where it needs a re-check.
  const rows = lines.map((line) => {
    const review = progress?.reviews.find((r) => r.lineKey === line.key);
    const state = progress ? lineStateOf(review, line.revision, sources.get(line.key)) : "open";
    const isoMoved = Boolean(state === "recheck" && review?.revision && line.revision && review.revision !== line.revision);
    const now = sources.get(line.key) ?? [];
    // Only a line still standing as done is compared: an open line has nothing
    // to have changed since, and a re-check is what the comparison is for.
    const comparisons = review && state !== "open" ? compareSources(review.basis, now, review.reviewedAt) : [];
    // The check print out on the revision now in force -- a new revision starts at CP-01.
    const lastPrint = printsOfRevision(prints ?? [], line).filter((p) => p.kind === "cp").pop();
    return { line, review, state, isoMoved, comparisons, now, lastPrint };
  });

  if (line) {
    // An earlier revision is reviewed exactly as the current one is -- same cards,
    // same checks -- just run on that drawing alone. Marking it done is not
    // offered: progress belongs to the revision in force.
    const earlier = requestedDrawing ? line.superseded.find((d) => d.documentId === requestedDrawing) : undefined;
    const viewed: IsoLine = earlier
      ? { ...line, documentIds: [earlier.documentId], current: [earlier], sheets: earlier.sheets, revision: earlier.revision, superseded: [] }
      : line;
    const currentHref = links.line(line.lineNumber);
    const drawingHref = (documentId: string) => `${currentHref}&rev=${encodeURIComponent(documentId)}`;
    const review = progress?.reviews.find((r) => r.lineKey === line.key);
    // WHICH P&ID REVISION this ISO is compared against, and which it was drawn
    // against. Each P&ID the line is on can be compared at any of its revisions
    // (?pid=); the latest is the default. The "drawn against" revision is the one
    // the line was checked against where that was recorded, otherwise the one in
    // force when the ISO was uploaded. Comparing with a revision issued after it
    // turns the differences into P&ID changes the ISO is behind on, not ISO errors.
    const isoUploadedAt = viewed.current[0]?.uploadedAt;
    const pidFamilies = (sources.get(line.key) ?? [])
      .filter((s) => s.kind === "pid")
      .map((cur) => {
        const revisions = [...(cur.earlier ?? []), { documentId: cur.documentId, fileName: cur.fileName, revision: cur.revision, uploadedAt: cur.uploadedAt }];
        const family = documentFamily("pid", cur.fileName);
        const recorded = review?.basis?.find((b) => b.kind === "pid" && documentFamily("pid", b.fileName) === family);
        const inForceAtIso = isoUploadedAt ? revisions.filter((r) => new Date(r.uploadedAt) <= isoUploadedAt).pop() : undefined;
        const baseline = (recorded && revisions.find((r) => r.documentId === recorded.documentId)) ?? inForceAtIso ?? null;
        const compared = revisions.find((r) => r.documentId === requestedPid) ?? revisions[revisions.length - 1];
        const ahead = Boolean(baseline && compared.documentId !== baseline.documentId && new Date(compared.uploadedAt) > new Date(baseline.uploadedAt));
        return { cur, revisions, baseline, compared, ahead };
      });
    const chosenPid = pidFamilies.some((f) => f.revisions.some((r) => r.documentId === requestedPid)) ? requestedPid : undefined;
    const pidRevLabel = (r: { revision: string | null; uploadedAt: string }) => (r.revision ? `Rev ${r.revision}` : uploaded.format(new Date(r.uploadedAt)));
    const aheadFamily = pidFamilies.find((f) => f.ahead);
    const lineHref = (opts: { rev?: string; pid?: string }) =>
      `${currentHref}${opts.rev ? `&rev=${encodeURIComponent(opts.rev)}` : ""}${opts.pid ? `&pid=${encodeURIComponent(opts.pid)}` : ""}`;
    const pidContext: PidContext = {
      isoChoices: [
        { label: `REV ${line.revision ?? "?"}`, note: "latest", href: lineHref({ pid: chosenPid }), active: !earlier },
        ...line.superseded.map((d) => ({ label: `REV ${d.revision ?? "?"}`, href: lineHref({ rev: d.documentId, pid: chosenPid }), active: earlier?.documentId === d.documentId })),
      ],
      families: pidFamilies.map((f) => ({
        name: f.cur.fileName,
        choices: f.revisions.map((r, i) => ({
          label: pidRevLabel(r),
          note: [i === f.revisions.length - 1 ? "latest" : "", f.baseline?.documentId === r.documentId ? "ISO drawn against" : ""].filter(Boolean).join(", "),
          href: lineHref({ rev: earlier?.documentId, pid: r.documentId }),
          active: f.compared.documentId === r.documentId,
        })),
      })),
      upRev: aheadFamily ? pidRevLabel(aheadFamily.compared) : undefined,
      baseline: aheadFamily?.baseline ? pidRevLabel(aheadFamily.baseline) : undefined,
      baselineHref: aheadFamily?.baseline ? lineHref({ rev: earlier?.documentId, pid: aheadFamily.baseline.documentId }) : undefined,
    };
    const summary = await summariseLine(projectId, viewed, { pidChoice: chosenPid ? [chosenPid] : [] });
    // The line's errors as the error report counts them -- what a check print
    // records, and what must be zero for Final.
    const errorCount = buildIsoReport(summary)?.totals.all ?? null;
    const linePrints = printsOfLine(prints, line.key);
    const revisionPrints = printsOfRevision(linePrints, line);
    const next = prints !== null && errorCount !== null && !earlier ? nextStep(linePrints, line, errorCount) : undefined;
    const checks = summary.checks;

    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title={<span className="break-all font-mono text-xl">{line.lineNumber}</span>}
          back={{ href: links.list, label: projectName }}
          description="Every review for this line. Open one to see all of its data."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {/* The errors on this line, laid out to hand to the designer. */}
              <Link href={`/projects/${projectId}/report?line=${encodeURIComponent(line.lineNumber)}`} className="btn btn-secondary">
                <IconClipboard size={16} />
                Error report
              </Link>
              {earlier ? null : progress ? (
                <ReviewControl
                  projectId={projectId}
                  lineNumber={line.lineNumber}
                  review={progress.reviews.find((r) => r.lineKey === line.key)}
                  currentRevision={line.revision}
                  currentSources={sources.get(line.key)}
                  next={next}
                  lastPrint={revisionPrints.filter((p) => p.kind === "cp").pop()}
                  errorCount={errorCount}
                  readOnly={!canMark}
                />
              ) : (
                <MarkingNotSetUpBadge />
              )}
            </div>
          }
          meta={
            <>
              {viewed.revision && (
                <Badge tone={earlier ? "warning" : "info"} title="The revision printed in this drawing's title block">
                  REV {viewed.revision}
                  {earlier ? " · superseded" : ""}
                </Badge>
              )}
              <Badge>{plural(viewed.sheets, "sheet")}</Badge>
              {summary.drawings.length > 1 && <Badge>{summary.drawings.length} drawings</Badge>}
            </>
          }
        />

        {earlier ? (
          <Alert tone="warning">
            <strong>
              You are viewing REV {earlier.revision} ({earlier.fileName}), superseded by REV {line.revision}.
            </strong>{" "}
            These checks are for that earlier drawing only.{" "}
            <Link href={currentHref} className="link font-medium">
              Back to REV {line.revision}
            </Link>
          </Alert>
        ) : (
          <SupersededDrawings line={line} hrefOf={drawingHref} />
        )}

        {/* The first thing on the page when a done line has gone stale: who checked
            it, at which revision, and what has been issued since -- then the cards
            below to see the change, and the button to mark it done again. */}
        {!earlier && review && lineStateOf(review, line.revision, sources.get(line.key)) === "recheck" && (
          <Alert tone="warning">
            <strong>
              {review.reviewedByName ?? "A checker"} marked this line done
              {review.revision ? ` at REV ${review.revision}` : ""} on {uploaded.format(review.reviewedAt)}
              {review.revision && line.revision && review.revision !== line.revision
                ? `, and REV ${line.revision} has been issued since.`
                : `, and since then: ${changeSummary(compareSources(review.basis, sources.get(line.key) ?? [], review.reviewedAt)) || "a document it was based on changed"}.`}
            </strong>{" "}
            Look at what changed below, then mark it done again.
          </Alert>
        )}

        {!earlier && prints !== null && <CheckPrints prints={revisionPrints} allPrints={linePrints} revision={line.revision} next={next} errorCount={errorCount} done={Boolean(review)} />}

        {!earlier && review && (
          <CheckedAgainst
            projectId={projectId}
            review={review}
            comparisons={compareSources(review.basis, sources.get(line.key) ?? [], review.reviewedAt)}
            drawingHref={drawingHref}
          />
        )}

        {/* Where "Mark as done" would be. Saying why it is absent is the whole
            point -- an empty header reads as "this app has no such feature". */}
        {!progress && <MarkingNotSetUp canMark={canMark} />}

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
          title="MTO (BOM vs admin item list)"
          text="This line's bill of material looked up in the admin's item list, class by class."
          // "Template" only while there is nothing to check against yet --
          // once an admin item list exists for the project, this is real.
          status={checks && !checks.some((d) => d.mto.available) ? <Badge tone="info">Template</Badge> : undefined}
          badges={
            checks && checks.some((d) => d.bom.items > 0) ? <Badge>{plural(most(checks.map((d) => d.bom.items)), "BOM item")}</Badge> : undefined
          }
        >
          {checks ? <MtoBody drawings={checks} projectId={projectId} /> : <Note>{UNAVAILABLE}</Note>}
        </CollapsibleCard>

        <CollapsibleCard
          icon={IconCompare}
          title="ISO vs P&ID"
          text="This line's routing and in-line components against the project's P&IDs."
          badges={checks ? <PidBadges drawings={checks} upRev={pidContext.upRev} /> : undefined}
        >
          {checks ? <PidBody drawings={checks} context={pidContext} /> : <Note>{UNAVAILABLE}</Note>}
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

        <CollapsibleCard
          icon={IconSupport}
          title="Pipe supports"
          text="Whether the gaps between this line's supports are within the span standard for its pipe."
          badges={<SupportsBadges supports={summary.supports} />}
        >
          <SupportsBody supports={summary.supports} />
        </CollapsibleCard>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={listTitle ?? projectName}
        back={links.back}
        description="Choose a line number to review its spools, hook-up and container check."
        actions={
          links.library && (
            <Link href={links.library} className="btn btn-secondary">
              <IconLibrary size={16} />
              Library
            </Link>
          )
        }
      />

      {/* The list is where somebody looks for progress first, so the reason it is
          absent belongs here too, not only inside a line. */}
      {!progress && lines.length > 0 && <MarkingNotSetUp canMark={canMark} />}

      {/* How far through the project the checkers are, against the line list's
          total (or the lines uploaded so far). A line needing a re-check is still
          done -- it is drawn amber in the bar rather than taken out of it. */}
      {progress && lines.length > 0 && (
        <div className="card flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium">Progress</p>
            <p className="text-sm tabular-nums text-muted-foreground">
              <span className="font-semibold text-foreground">{counts.done}</span> of {progress.total ?? lines.length} lines checked
              {progress.lineList && <span title={`Counted from ${progress.lineList.fileName}`}> &middot; from the line list</span>}
            </p>
          </div>
          <ProgressBar value={counts.done} max={progress.total ?? lines.length} recheck={counts.recheck} label="Lines checked" />
          <p className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-success-solid" aria-hidden="true" />
              {counts.done - counts.recheck} done
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-warning-solid" aria-hidden="true" />
              {counts.recheck} need re-check
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-muted-foreground/40" aria-hidden="true" />
              {Math.max(0, (progress.total ?? lines.length) - counts.done)} not started
            </span>
          </p>
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
          {/* One row per line: the number and its ISO revision, the documents it is
              checked against underneath, and where it stands on the right. A line
              done against something since revised carries an amber edge, and the
              document that moved is the only thing in its strip shown in colour. */}
          <ul className="divide-y divide-border">
            {rows.map(({ line: l, review: lineReview, state, comparisons, now, lastPrint }) => (
              <li key={l.key} className={`relative ${state === "recheck" ? "bg-warning-soft/40" : ""}`}>
                {state === "recheck" && <span className="absolute inset-y-0 left-0 w-1 bg-warning-solid" aria-hidden="true" />}
                <Link
                  href={links.line(l.lineNumber)}
                  className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 px-5 py-3.5 transition-colors hover:bg-muted/50"
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                      <span className="break-all font-mono text-[0.8125rem] font-semibold text-foreground group-hover:text-link">{l.lineNumber}</span>
                      <span className="text-xs text-muted-foreground">
                        REV {l.revision ?? "—"} &middot; {plural(l.sheets, "sheet")}
                      </span>
                    </p>
                    <DocumentStrip now={now} comparisons={comparisons} state={state} checkedAt={lineReview?.reviewedAt} />
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="flex flex-col items-end gap-0.5 text-right">
                      {state === "open" &&
                        (lastPrint ? (
                          <Badge tone="info" dot title="Sent back to the designer; the line is done once it is issued Final.">
                            {checkPrintLabel(lastPrint)} &middot; with designer
                          </Badge>
                        ) : (
                          <Badge>Not started</Badge>
                        ))}
                      {state === "done" && (
                        <Badge tone="success" dot>
                          Done
                        </Badge>
                      )}
                      {state === "recheck" && (
                        <Badge tone="warning" dot title="Marked done, but a document it was checked against has been revised since">
                          Re-check
                        </Badge>
                      )}
                      {lineReview && (
                        <span className="text-[0.6875rem] text-muted-foreground">
                          {lineReview.reviewedByName ?? "Checked"} &middot; {uploaded.format(lineReview.reviewedAt)}
                        </span>
                      )}
                    </div>
                    <IconChevronRight size={16} className="flex-none text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
