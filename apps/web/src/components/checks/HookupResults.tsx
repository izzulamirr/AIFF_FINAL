import { Badge } from "@/components/ui/primitives";
import type { HookupVerification } from "@/lib/hookupVerification";

const statusTone = { match: "success", unmatched: "danger", "not checkable": "neutral" } as const;

// The hook-up verification of one ISO: each instrument, the typical it was
// checked against, and each piping-scope component found or missing on the ISO.
// Shown on the hook-up page and, for a plain user, inside a line's page -- one
// component, so the two places cannot drift apart.
export function HookupResults({ results, isoLineNumber, lineService, serviceBasis }: HookupVerification) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="section-title flex flex-wrap items-baseline gap-x-2">
          {isoLineNumber ? (
            <>
              Line <span className="font-mono">{isoLineNumber}</span>
            </>
          ) : (
            "Selected ISO"
          )}
          <span className="text-sm font-normal text-muted-foreground">
            {results.length} instrument{results.length > 1 ? "s" : ""}
            {lineService ? ` -- service ${lineService}` : ""}
          </span>
        </h2>
        {serviceBasis && <p className="mt-1 text-xs text-muted-foreground">{serviceBasis}</p>}
      </div>

      {results.map((result) => (
        <div key={result.instrumentTag} className="card card-flush">
          <div className="card-header">
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono font-medium">{result.instrumentTag}</span>
              <span className="text-muted-foreground">{result.instrumentLabel}</span>
              {result.missingCount > 0 ? (
                <Badge tone="danger" dot>
                  {result.missingCount} piping item{result.missingCount > 1 ? "s" : ""} unmatched on the ISO
                </Badge>
              ) : result.sheet ? (
                <Badge tone="success" dot>
                  all piping-scope items matched
                </Badge>
              ) : null}
            </p>
          </div>
          {result.sheet ? (
            <p className="border-b bg-muted/40 px-5 py-2.5 text-xs text-muted-foreground">
              Typical: {[result.sheet.instrumentType, result.sheet.service].filter(Boolean).join(" / ") || result.sheet.title}
              {result.sheet.sheet ? ` (sheet ${result.sheet.sheet})` : ""}
              {" -- matched automatically"}
              {result.sheet.mounting ? ` | ${result.sheet.mounting}` : ""}
              {result.sheet.slope ? ` | slope ${result.sheet.slope}` : ""}
            </p>
          ) : (
            <p className="border-b bg-danger-soft px-5 py-2.5 text-xs text-danger">
              No typical in this set covers a {result.measuredVariable ?? "?"} instrument
              {result.service ? ` on ${result.service} service` : ""}.
            </p>
          )}

          {result.checks.length > 0 && (
            <div className="table-wrap">
              <table className="table table-top">
                <thead>
                  <tr>
                    <th className="w-16">Item</th>
                    <th>Hook-up component (piping scope)</th>
                    <th className="w-28">Size</th>
                    <th className="w-16">Qty</th>
                    <th className="w-56">Found on the ISO</th>
                    <th className="w-28">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.checks.map((check, i) => (
                    <tr key={`${check.item.itemNo ?? check.item.description}-${i}`}>
                      <td className="tabular-nums">{check.item.itemNo ?? ""}</td>
                      <td>
                        {/* The component is named from the HOOK-UP, never
                            from the ISO. The ISO is the document under
                            audit -- taking its answer would both invert the
                            check and inherit its errors. Where the hook-up
                            defers the type, that deferral is shown as the
                            answer, because it is the answer. */}
                        {check.item.description}
                        {check.item.typeDeferredTo ? (
                          <div className="text-xs text-muted-foreground">
                            type not fixed by this sheet &mdash; per {check.item.typeDeferredTo}
                          </div>
                        ) : null}
                        {/* A warning badge: its text and fill come from the
                            theme's warning pair, chosen for contrast with each
                            other, so it reads the same in light and dark. */}
                        {check.item.implied ? (
                          <Badge tone="warning" className="ml-2">
                            not in the hook-up BOM
                            {check.item.deferredTo ? ` -- per ${check.item.deferredTo}` : ""}
                          </Badge>
                        ) : null}
                        {check.item.disciplineBasis ? (
                          <span className="ml-2 text-xs text-muted-foreground">({check.item.disciplineBasis})</span>
                        ) : null}
                      </td>
                      <td>
                        {/* The size the sheet states IS the requirement --
                            confirming the ISO used the same size is the
                            reason this comparison exists -- so it is shown
                            plainly, with sizeBasis saying where a figure
                            the sheet draws rather than prints came from. */}
                        {check.item.size ?? "-"}
                        {check.item.sizeBasis ? <div className="text-xs text-muted-foreground">{check.item.sizeBasis}</div> : null}
                      </td>
                      <td className="tabular-nums">{check.item.quantity ?? "-"}</td>
                      <td className="text-xs text-muted-foreground">{check.isoDetail ?? "-"}</td>
                      <td>
                        <Badge tone={statusTone[check.status]} dot>
                          {check.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {result.sheet && result.checks.length === 0 && (
            <p className="px-5 py-4 text-xs text-muted-foreground">
              This typical places every component on the instrument side of the break -- nothing for piping to carry.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
