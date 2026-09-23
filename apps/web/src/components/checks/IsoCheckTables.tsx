import { Badge } from "@/components/ui/primitives";
import type { IsoChecks } from "@/lib/isoChecks";
import { BOM_STATUS_TONE } from "@/lib/verifyBomCrossCheck";
import { combineAdminText } from "@/lib/parseSheetPage";
import type { DesignBasisRow, RoutingFittingRow, ValveMatchGroup } from "@/lib/verifyIso";

// The tables behind an ISO's cross-document checks. Shown on the ISO's own page
// and, for a plain user, inside a line's page -- one component each, so the two
// places cannot drift apart.

type BomSheet = IsoChecks["bomBySpec"][number];
type MtoSheet = IsoChecks["mtoBySpec"][number];

// ISO vs PLL: the design basis, field by field.
export function DesignBasisTable({ rows }: { rows: DesignBasisRow[] }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="table-wrap">
        <table className="table table-compact">
          <thead>
            <tr>
              <th>Field</th>
              <th>ISO</th>
              <th>PLL</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.field}>
                <td className="font-medium">{row.field}</td>
                <td>{row.isoValue ?? "-"}</td>
                <td>{row.pllValue ?? "-"}</td>
                <td>
                  <Badge tone={row.status === "match" ? "success" : row.status === "mismatch" ? "danger" : "neutral"} dot>
                    {row.status}
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
export function RoutingTable({ rows }: { rows: RoutingFittingRow[] }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="table-wrap">
        <table className="table table-compact">
          <thead>
            <tr>
              <th>Item</th>
              <th>ISO</th>
              <th>P&amp;ID</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.field}>
                <td className="font-medium">{row.field}</td>
                <td>{row.isoValue ?? "-"}</td>
                <td>{row.pidValue ?? "-"}</td>
                <td>
                  <Badge tone={row.status === "match" ? "success" : row.status === "mismatch" ? "danger" : "neutral"} dot>
                    {row.status}
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

// ISO vs P&ID: every in-line component both documents show, paired, one block per
// material class along the run.
export function FittingsMatchGroups({ groups }: { groups: ValveMatchGroup[] }) {
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
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Size</th>
                  <th>ISO</th>
                  <th>P&amp;ID</th>
                  <th>ISO description</th>
                  <th>P&amp;ID tag</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={`${row.category}-${row.size}`}>
                    <td className="font-medium">{row.category}</td>
                    <td className="font-mono text-xs">{row.size}</td>
                    <td className="tabular-nums">{row.isoCount || "-"}</td>
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
                      <Badge tone={row.status === "match" ? "success" : row.status === "count mismatch" ? "warning" : "danger"} dot>
                        {row.status}
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

// The MTO: the same BOM, checked against the client's own piping spec and,
// where a real match exists, corroborated against the admin's own item list.
// Same per-sheet, per-class shape as BomSheets (so the two read as one
// family), with three extra facts per row: the client spec's own verdict,
// and -- only where the admin list actually confirms it -- the exact admin
// line(s) that do, with any attribute they contradict called out in red.
//
// A row with no result (its own class could not be resolved -- see
// lib/isoChecks.ts's own "Unassigned" handling) shows a plain dash rather
// than a status: there is nothing to have checked it against.
export function MtoSheets({ sheets }: { sheets: MtoSheet[] }) {
  return (
    <div className="flex flex-col gap-6">
      {sheets.map(({ lineNumber, sheetLabel, page, groups }) => (
        <div key={`${lineNumber}-${page ?? sheetLabel}`} className="overflow-hidden rounded-lg border">
          <div className="border-b bg-muted/50 px-4 py-3">
            <p className="text-sm font-medium">
              Sheet {sheetLabel || "?"} <span className="font-normal text-muted-foreground">&middot; line</span>{" "}
              <span className="font-mono font-normal">{lineNumber}</span>
            </p>
          </div>
          <div className="flex flex-col gap-5 p-4">
            {groups.map(({ specClass, rows }) => (
              <div key={specClass}>
                <p className={`mb-2 flex flex-wrap items-baseline gap-x-2 text-sm font-medium ${specClass === "Unassigned" ? "text-warning" : ""}`}>
                  {specClass}{" "}
                  <span className="font-normal text-muted-foreground">
                    ({rows.length} item{rows.length > 1 ? "s" : ""})
                  </span>
                  {specClass === "Unassigned" && (
                    <span className="text-xs font-normal text-warning">
                      &mdash; the drawing doesn&apos;t show which side of the break these sit on; not checked
                    </span>
                  )}
                </p>
                <div className="overflow-hidden rounded-lg border">
                  <div className="table-wrap">
                    <table className="table table-compact">
                      <thead>
                        <tr>
                          <th className="w-12">Item</th>
                          <th>Type</th>
                          <th>Size</th>
                          <th className="w-16">Qty</th>
                          <th>Description</th>
                          <th>Client spec</th>
                          <th>Admin</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.id}>
                            <td className="tabular-nums">{row.itemNo}</td>
                            <td className="text-xs text-muted-foreground">{row.componentType}</td>
                            <td>{row.size}</td>
                            <td className="tabular-nums">{row.quantity}</td>
                            <td className="max-w-xs">{row.description}</td>
                            <td className="max-w-xs">
                              {row.result ? (
                                <>
                                  {/* The STATUS is what a Badge is for -- a short word.
                                      The matched client spec text is a whole clause and
                                      sometimes a whole sentence; a pill is `white-space:
                                      nowrap` by design, so a long one doesn't wrap, it
                                      just runs on past the column and over whatever sits
                                      next to it. Shown as ordinary wrapped text below the
                                      badge instead. */}
                                  <Badge tone={BOM_STATUS_TONE[row.result.status]}>{row.result.label}</Badge>
                                  {row.result.clientDescription && (
                                    <p className="mt-1 text-xs text-muted-foreground">
                                      {row.result.clientDescription}
                                      {row.result.clientSize ? ` (${row.result.clientSize})` : ""}
                                    </p>
                                  )}
                                </>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </td>
                            <td className="max-w-xs text-xs">
                              {row.adminMatches == null ? (
                                <span className="text-muted-foreground">-</span>
                              ) : row.adminMatches.length > 0 ? (
                                <>
                                  <span className={row.adminMismatches.length > 0 ? "text-warning" : "text-success"}>
                                    {row.adminMatches.map((m) => combineAdminText(m)).join("; ")}
                                  </span>
                                  {row.adminMismatches.map((m) => (
                                    <div key={m.attribute} className="mt-1 font-medium text-danger">
                                      {m.attribute} differs &mdash; BOM says {m.wanted}, admin sheet has only {m.found.join(" / ")}
                                    </div>
                                  ))}
                                </>
                              ) : row.result && row.result.status === "match" ? (
                                <span className="text-danger">No admin line</span>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </td>
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
