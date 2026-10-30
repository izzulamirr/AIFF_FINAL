import { Badge } from "@/components/ui/primitives";
import type { IsoChecks } from "@/lib/isoChecks";
import { ADMIN_STATUS_TONE, bomFault } from "@/lib/verifyBomCrossCheck";
import { combineAdminText } from "@/lib/parseSheetPage";
import { HOLD_LABEL } from "@/lib/pending";
import { clearItemHold, setItemHold } from "@/app/(app)/projects/[id]/holdActions";
import type { DesignBasisRow, RoutingFittingRow, ValveMatchGroup } from "@/lib/verifyIso";

// The tables behind an ISO's cross-document checks. Shown on the ISO's own page
// and, for a plain user, inside a line's page -- one component each, so the two
// places cannot drift apart.

type BomSheet = IsoChecks["bomBySpec"][number];
type MtoSheet = IsoChecks["mtoBySpec"][number];

// WHO IS RESPONSIBLE. Every check here audits the ISO against a master document
// -- the line list, the P&ID, the admin spec, the hook-up typical. The master is
// the REFERENCE: where the two disagree it is the ISO that is wrong and the ISO
// that gets corrected. So the reference column is headed as what is REQUIRED,
// the ISO's value is the one marked in red, and a status names the ISO, never a
// bare "mismatch" that leaves the reader to decide which document is at fault.
const ON_ISO = "text-danger font-medium";

function ReferenceNote({ reference, upRev }: { reference: string; upRev?: string }) {
  if (upRev) {
    return (
      <p className="border-b bg-warning-soft px-3 py-1.5 text-xs">
        Reference: <span className="font-medium">{reference} {upRev}</span>, issued after this ISO was drawn. Differences are changes in
        the P&amp;ID that the ISO has not been revised to yet &mdash; not errors in it.
      </p>
    );
  }
  return (
    <p className="border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
      Reference: <span className="font-medium text-foreground">{reference}</span>. Where they differ, the ISO is to be corrected.
    </p>
  );
}

// Against a P&ID revision issued AFTER the ISO, a difference is the P&ID having
// moved on, so it is named as the P&ID's change and shown amber -- the ISO is
// behind, not wrong. `upRev` is that revision ("Rev E").
const upRevLabel = (status: string, upRev: string) =>
  status === "pid only"
    ? `Added in P&ID ${upRev}`
    : status === "iso only"
      ? `Not in P&ID ${upRev}`
      : `Changed in P&ID ${upRev}`;

const COMPARE_LABEL: Record<string, string> = {
  match: "Match",
  mismatch: "Wrong on ISO",
  "iso only": "On ISO, not on P&ID",
  "not compared": "Not compared",
};

// ISO vs PLL: the design basis, field by field.
export function DesignBasisTable({ rows }: { rows: DesignBasisRow[] }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <ReferenceNote reference="the line list (PLL)" />
      <div className="table-wrap">
        <table className="table table-compact">
          <thead>
            <tr>
              <th>Field</th>
              <th>ISO states</th>
              <th>Line list requires</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.field}>
                <td className="font-medium">{row.field}</td>
                <td className={row.status === "mismatch" ? ON_ISO : ""}>{row.isoValue ?? "-"}</td>
                <td>{row.pllValue ?? "-"}</td>
                <td>
                  <Badge tone={row.status === "match" ? "success" : row.status === "mismatch" ? "danger" : "neutral"} dot>
                    {COMPARE_LABEL[row.status] ?? row.status}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ISO vs P&ID: routing, and the fitting counts.
export function RoutingTable({ rows, upRev }: { rows: RoutingFittingRow[]; upRev?: string }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <ReferenceNote reference="the P&ID" upRev={upRev} />
      <div className="table-wrap">
        <table className="table table-compact">
          <thead>
            <tr>
              <th>Item</th>
              <th>ISO states</th>
              <th>P&amp;ID requires</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.field}>
                <td className="font-medium">{row.field}</td>
                <td className={!upRev && (row.status === "mismatch" || row.status === "iso only") ? ON_ISO : ""}>{row.isoValue ?? "-"}</td>
                <td>{row.pidValue ?? "-"}</td>
                <td>
                  <Badge
                    tone={
                      row.status === "match" ? "success" : row.status === "mismatch" || row.status === "iso only" ? (upRev ? "warning" : "danger") : "neutral"
                    }
                    dot
                  >
                    {upRev && (row.status === "mismatch" || row.status === "iso only") ? upRevLabel(row.status, upRev) : (COMPARE_LABEL[row.status] ?? row.status)}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const FITTING_LABEL: Record<string, string> = {
  match: "Match",
  "count mismatch": "Wrong count on ISO",
  "iso only": "On ISO, not on P&ID",
  "pid only": "Missing from ISO",
};

// ISO vs P&ID: every in-line component both documents show, paired, one block per
// material class along the run.
export function FittingsMatchGroups({ groups, upRev }: { groups: ValveMatchGroup[]; upRev?: string }) {
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <div
          key={group.specClass}
          className={`overflow-hidden rounded-lg border ${group.specClass === "unassigned" ? "border-warning-solid" : ""}`}
        >
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/50 px-4 py-2.5 text-sm font-medium">
            <span className="font-mono">{group.specClass}</span>
            <span className="font-normal text-muted-foreground">
              ISO {group.isoTotal} / P&amp;ID {group.pidTotal}
            </span>
          </p>
          <ReferenceNote reference="the P&ID" upRev={upRev} />
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Size</th>
                  <th>ISO shows</th>
                  <th>P&amp;ID requires</th>
                  <th>ISO description</th>
                  <th>P&amp;ID tag</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={`${row.category}-${row.size}`}>
                    <td className="font-medium">{row.category}</td>
                    <td className="font-mono text-xs">{row.size}</td>
                    <td className={`tabular-nums ${row.status === "match" || upRev ? "" : ON_ISO}`}>{row.isoCount || "-"}</td>
                    <td className="tabular-nums">
                      {/* A root valve the legend declares is accounted for as
                          firmly as one the P&ID draws, so it is added into the
                          P&ID figure rather than shown as a separate tally. */}
                      {row.pidCount + row.impliedCount || "-"}
                    </td>
                    <td className="text-xs text-muted-foreground">{row.isoDetail ?? "-"}</td>
                    <td className="text-xs text-muted-foreground">
                      {/* For a valve hidden inside a simplified symbol the useful
                          answer is which device carries it, so the instrument tag
                          replaces the "untagged" a P&ID valve would show. */}
                      {row.impliedDetail ?? row.pidDetail ?? "-"}
                    </td>
                    <td>
                      <Badge tone={row.status === "match" ? "success" : upRev ? "warning" : "danger"} dot>
                        {row.status !== "match" && upRev ? upRevLabel(row.status, upRev) : (FITTING_LABEL[row.status] ?? row.status)}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

// The bill of material grouped by the class that governs each item, one block per
// SHEET -- a multi-sheet drawing carries a separate BOM per sheet and a spec break
// applies to the sheet that draws it, so QC is done sheet by sheet.
export function BomSheets({ sheets }: { sheets: BomSheet[] }) {
  return (
    <div className="flex flex-col gap-6">
      {sheets.map(({ lineNumber, sheetLabel, page, breaks, groups }) => (
        <div key={`${lineNumber}-${page ?? sheetLabel}`} className="overflow-hidden rounded-lg border">
          <div className="border-b bg-muted/50 px-4 py-3">
            <p className="text-sm font-medium">
              Sheet {sheetLabel || "?"} <span className="font-normal text-muted-foreground">&middot; line</span>{" "}
              <span className="font-mono font-normal">{lineNumber}</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {breaks.length > 1 ? (
                <>Spec break: {breaks.map((b) => `${b.spec_class}${b.rating ? ` (${b.rating}#)` : ""}`).join(" → ")}</>
              ) : (
                <>No spec break on this sheet -- the whole sheet is the title-block class.</>
              )}
            </p>
            {breaks.length > 1 && breaks.some((b) => b.location_note) && (
              <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">
                {breaks
                  .filter((b) => b.location_note)
                  .map((b) => (
                    <li key={b.spec_class}>
                      {b.spec_class}: {b.location_note}
                    </li>
                  ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-5 p-4">
            {groups.map(({ specClass, items }) => (
              <div key={specClass}>
                <p className={`mb-2 flex flex-wrap items-baseline gap-x-2 text-sm font-medium ${specClass === "Unassigned" ? "text-warning" : ""}`}>
                  {specClass} <span className="font-normal text-muted-foreground">({items.length} item{items.length > 1 ? "s" : ""})</span>
                  {specClass === "Unassigned" && (
                    <span className="text-xs font-normal text-warning">
                      -- the drawing doesn&apos;t show which side of the break these sit on; confirm against the isometric
                    </span>
                  )}
                </p>
                <div className="overflow-hidden rounded-lg border">
                  <div className="table-wrap">
                    <table className="table table-compact">
                      <thead>
                        <tr>
                          <th className="w-12">Item</th>
                          <th>Description</th>
                          <th className="w-32">Item code</th>
                          <th className="w-16">Qty</th>
                          <th className="w-40">Basis</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((item) => (
                          <tr key={item.id}>
                            <td className="tabular-nums">{item.itemNo}</td>
                            <td>{item.description}</td>
                            <td className="font-mono text-xs">{item.itemCode}</td>
                            <td className="tabular-nums">{item.qty}</td>
                            <td className="text-xs text-muted-foreground">{item.basis || "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// The MTO: the same BOM, looked up in the admin's own item list.
//
// One table per sheet, with each class as a band inside it rather than a bordered
// table of its own -- a sheet with a spec break was three cards and three header
// rows to say what one table says. Every row reads the same way: what the BOM
// states, the verdict, and the admin line that verdict rests on (or, where there is
// none, why not).
type TallyRow = { check: { status: string }; hold: unknown };

// A held row counts as pending and nowhere else -- it is waiting, not wrong.
function tally(rows: TallyRow[]) {
  const n = (...s: string[]) => rows.filter((r) => !r.hold && s.includes(r.check.status)).length;
  return { match: n("match"), wrongSpec: n("deviation"), wrongClass: n("wrong_spec"), missing: n("missing"), pending: rows.filter((r) => r.hold).length };
}

function CountBadges({ rows }: { rows: TallyRow[] }) {
  const { match, wrongSpec, wrongClass, missing, pending } = tally(rows);
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {pending > 0 && (
        <Badge tone="info" dot>
          {pending} pending
        </Badge>
      )}
      {match > 0 && (
        <Badge tone="success" dot>
          {match} match
        </Badge>
      )}
      {wrongSpec > 0 && (
        <Badge tone="danger" dot>
          {wrongSpec} wrong spec
        </Badge>
      )}
      {wrongClass > 0 && (
        <Badge tone="danger" dot>
          {wrongClass} wrong class
        </Badge>
      )}
      {missing > 0 && (
        <Badge tone="danger" dot>
          {missing} not in spec
        </Badge>
      )}
    </span>
  );
}

// Mark a row pending / on hold, or clear a mark. A plain form in a <details>, so
// it costs nothing until opened and needs no client code.
function HoldControl({ row, marking }: { row: MtoSheet["groups"][number]["rows"][number]; marking: HoldMarking }) {
  const { projectId, documentId } = marking;
  if (row.hold?.source === "manual") {
    return (
      <form action={clearItemHold.bind(null, projectId, documentId, row.holdKey)} className="mt-1">
        <button className="text-[11px] font-medium text-link hover:underline">Clear {HOLD_LABEL[row.hold.status].toLowerCase()}</button>
      </form>
    );
  }
  // A hold the drawing prints is the drawing's to lift, not this page's.
  if (row.hold) return null;
  return (
    <details className="mt-1 text-[11px]">
      <summary className="cursor-pointer font-medium text-link">Mark pending…</summary>
      <form action={setItemHold.bind(null, projectId, documentId, row.holdKey)} className="mt-1.5 flex w-56 flex-col gap-1.5">
        <select name="status" defaultValue="pending" className="input h-7 text-xs">
          <option value="pending">Pending (awaiting data)</option>
          <option value="hold">On hold</option>
        </select>
        <textarea name="remark" required rows={2} placeholder="Waiting on what? e.g. vendor datasheet from client" className="input text-xs" />
        <button className="btn btn-secondary btn-xs self-start">Save</button>
      </form>
    </details>
  );
}

/** Where marks are saved. Absent where items cannot be marked (the table is not set up, or no project context). */
export interface HoldMarking {
  projectId: string;
  documentId: string;
}

export function MtoSheets({ sheets, marking }: { sheets: MtoSheet[]; marking?: HoldMarking }) {
  return (
    <div className="flex flex-col gap-4">
      {sheets.map(({ lineNumber, sheetLabel, page, groups }) => (
        <div key={`${lineNumber}-${page ?? sheetLabel}`} className="overflow-hidden rounded-lg border">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/50 px-3 py-2">
            <p className="text-sm font-medium">
              Sheet {sheetLabel || "?"} <span className="font-normal text-muted-foreground">&middot; line</span>{" "}
              <span className="font-mono font-normal">{lineNumber}</span>
            </p>
            <CountBadges rows={groups.flatMap((g) => g.rows)} />
          </div>
          <ReferenceNote reference="the admin spec (item list)" />
          <div className="table-wrap">
            <table className="table table-compact min-w-[52rem] text-xs">
              <thead>
                <tr>
                  <th className="w-10">Item</th>
                  <th className="w-20">Size</th>
                  <th className="w-12">Qty</th>
                  <th>BOM</th>
                  <th className="w-32">Result</th>
                  <th>Spec requires (admin item list)</th>
                </tr>
              </thead>
              {groups.map(({ specClass, rows }) => (
                <tbody key={specClass}>
                  <tr className="bg-muted/30">
                    <td colSpan={6} className="!py-1.5">
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <span className={`font-semibold ${specClass === "Unassigned" ? "text-warning" : ""}`}>
                          {specClass} <span className="font-normal text-muted-foreground">&middot; {rows.length} item{rows.length > 1 ? "s" : ""}</span>
                          {specClass === "Unassigned" && (
                            <span className="ml-2 font-normal text-warning">the drawing doesn&apos;t show which side of the break these sit on</span>
                          )}
                        </span>
                        <CountBadges rows={rows} />
                      </span>
                    </td>
                  </tr>
                  {rows.map((row) => {
                    const { check } = row;
                    const muted = check.status === "skipped" || check.status === "no_list";
                    const fails = check.status !== "match" && check.status !== "skipped";
                    const { hold } = row;
                    // Held: waiting, not wrong. What the check found is kept, greyed,
                    // for when the data arrives -- but it is not shown as an error.
                    const faultTone = hold ? "text-muted-foreground" : "font-medium text-danger";
                    return (
                      <tr key={row.id} className={hold ? "bg-info-soft/40" : check.status === "wrong_spec" ? "bg-danger-soft/40" : ""}>
                        <td className="tabular-nums text-muted-foreground">{row.itemNo}</td>
                        <td className="whitespace-nowrap tabular-nums">{row.size}</td>
                        <td className="tabular-nums">{row.quantity}</td>
                        {/* Every fault is shown HERE, under what the BOM states: the
                            admin spec is the reference, so what is wrong is always
                            the BOM. The spec column only ever shows what is required. */}
                        <td className="max-w-sm">
                          <p className={muted ? "text-muted-foreground" : ""}>{row.description}</p>
                          {hold && (
                            <p className="mt-1 rounded border border-info-border bg-info-soft px-2 py-1 text-foreground">
                              <span className="font-semibold">{HOLD_LABEL[hold.status]}: </span>
                              {hold.remark}
                              {hold.markedByName && <span className="text-muted-foreground"> &middot; {hold.markedByName}</span>}
                            </p>
                          )}
                          {fails && check.note && <p className={`mt-0.5 ${faultTone}`}>{check.note}</p>}
                          {fails &&
                            check.adminMismatches.map((m) => (
                              <p key={m.attribute} className={`mt-0.5 ${faultTone}`}>
                                {bomFault(m, specClass)}
                              </p>
                            ))}
                          {check.detail && <p className="mt-0.5 font-medium">{check.detail}</p>}
                          {check.action && !hold && (
                            <p className="mt-1 rounded border border-warning-border bg-warning-soft px-2 py-1 text-foreground">
                              <span className="font-semibold">Action required: </span>
                              {check.action}
                            </p>
                          )}
                        </td>
                        <td>
                          {hold ? (
                            <>
                              <Badge tone="info" dot>
                                {HOLD_LABEL[hold.status]}
                              </Badge>
                              {check.status !== "match" && <p className="mt-0.5 text-[11px] text-muted-foreground">check: {check.label.toLowerCase()}</p>}
                            </>
                          ) : (
                            <Badge tone={ADMIN_STATUS_TONE[check.status]} dot>
                              {check.label}
                            </Badge>
                          )}
                          {marking && <HoldControl row={row} marking={marking} />}
                        </td>
                        <td className="max-w-sm text-muted-foreground">
                          {check.adminMatches.length > 0 ? (
                            <>
                              {/* Always name the class these lines come from. On a wrong-class
                                  row they are the OTHER class's, which must not read as what the
                                  filed class requires. */}
                              <p className="font-medium text-foreground">
                                Listed in{" "}
                                {check.status === "wrong_spec" && check.wrongSpec && check.wrongSpec.length > 0 ? check.wrongSpec.join(" / ") : specClass}:
                              </p>
                              {check.adminMatches.map((m, i) => (
                                <p key={i}>{combineAdminText(m)}</p>
                              ))}
                            </>
                          ) : !fails && check.note ? (
                            <span>{check.note}</span>
                          ) : (
                            <span>-</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
