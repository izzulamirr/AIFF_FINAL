import type { SpoolSheet } from "@/lib/spooling";
import { Badge } from "@/components/ui/primitives";

// One block per SHEET: the spools that sheet prints, then its weld list
// grouped under the spool each weld sits in.
export function SpoolSheets({ sheets }: { sheets: SpoolSheet[] }) {
  return (
    <>
      {sheets.map(({ lineNumber, sheetLabel, page, spools, weldsBySpool }) => (
        <div key={`${lineNumber}-${page ?? "x"}`} className="card card-flush">
          <div className="card-header">
            <p className="card-title">
              <span className="font-mono">{lineNumber}</span>
              {sheetLabel && <span className="ml-2 font-normal text-muted-foreground">{sheetLabel}</span>}
            </p>
          </div>

          <div className="flex flex-col gap-6 p-5">
            {spools.length > 0 && (
              <div>
                <p className="mb-2 text-sm font-medium">
                  Pipe spools <span className="font-normal text-muted-foreground">({spools.length})</span>
                </p>
                <div className="overflow-hidden rounded-lg border">
                  <div className="table-wrap">
                    <table className="table table-compact">
                      <thead>
                        <tr>
                          <th>Spool</th>
                          <th className="w-24">Welds</th>
                          <th>Ends at</th>
                        </tr>
                      </thead>
                      <tbody>
                        {spools.map((s) => (
                          <tr key={s.id}>
                            <td className="font-mono text-xs font-medium">{s.spoolNo}</td>
                            <td className="tabular-nums">{s.weldCount}</td>
                            <td className="text-xs text-muted-foreground">{s.note || "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {weldsBySpool.length > 0 && (
              <div>
                <p className="mb-3 text-sm font-medium">
                  Weld list{" "}
                  <span className="font-normal text-muted-foreground">({weldsBySpool.reduce((sum, g) => sum + g.welds.length, 0)})</span>
                </p>

                <div className="flex flex-col gap-5">
                  {weldsBySpool.map(({ spoolNo, welds }) => (
                    <div key={spoolNo}>
                      <p className="mb-1.5 flex items-center gap-2 text-xs font-medium">
                        {spoolNo === "-" ? (
                          <Badge tone="warning">Spool not determined</Badge>
                        ) : (
                          <span className="font-mono text-[0.8125rem]">{spoolNo}</span>
                        )}{" "}
                        <span className="font-normal text-muted-foreground">({welds.length})</span>
                      </p>
                      <div className="overflow-hidden rounded-lg border">
                        <div className="table-wrap">
                          <table className="table table-compact">
                            <thead>
                              <tr>
                                <th className="w-20">Weld</th>
                                <th className="w-28">Type</th>
                                <th className="w-20">Size</th>
                                <th className="w-36">Against the drawing</th>
                              </tr>
                            </thead>
                            <tbody>
                              {welds.map((w) => (
                                <tr key={w.id}>
                                  <td className="tabular-nums font-medium">{w.weldNo}</td>
                                  <td>{w.weldType}</td>
                                  <td>{w.size}</td>
                                  <td>
                                    {/* Nothing to compare against on a sheet whose
                                        boundaries could not be read off the drawing,
                                        which is not a match and not a mismatch. */}
                                    {w.drawingSpool == null ? (
                                      <span className="text-muted-foreground">-</span>
                                    ) : w.drawingSpool === w.spoolOf ? (
                                      <Badge tone="success" dot>
                                        match
                                      </Badge>
                                    ) : (
                                      <Badge tone="warning" dot>
                                        mismatch
                                      </Badge>
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
            )}
          </div>
        </div>
      ))}
    </>
  );
}
