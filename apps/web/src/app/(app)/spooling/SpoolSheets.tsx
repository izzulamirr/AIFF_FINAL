import type { SpoolSheet } from "@/lib/spooling";

// One block per SHEET: the spools that sheet prints, then its weld list
// grouped under the spool each weld sits in.
export function SpoolSheets({ sheets }: { sheets: SpoolSheet[] }) {
  return (
    <>
      {sheets.map(({ lineNumber, sheetLabel, page, spools, weldsBySpool }) => (
        <div key={`${lineNumber}-${page ?? "x"}`} className="mb-6 rounded border p-4">
          <p className="mb-3 text-sm font-medium">
            <span className="font-mono">{lineNumber}</span>
            {sheetLabel && <span className="ml-2 font-normal text-gray-500">{sheetLabel}</span>}
          </p>

          {spools.length > 0 && (
            <div className="mb-4">
              <p className="mb-1 text-sm font-medium">
                Pipe spools <span className="font-normal text-gray-500">({spools.length})</span>
              </p>
              <table className="w-full text-left text-sm">
                <thead className="border-b text-gray-500">
                  <tr>
                    <th className="py-1">Spool</th>
                    <th className="w-24">Welds</th>
                    <th>Ends at</th>
                  </tr>
                </thead>
                <tbody>
                  {spools.map((s) => (
                    <tr key={s.id} className="border-b">
                      <td className="py-1 font-mono text-xs">{s.spoolNo}</td>
                      <td>{s.weldCount}</td>
                      <td className="text-xs text-gray-500">{s.note || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {weldsBySpool.length > 0 && (
            <div>
              <p className="mb-1 text-sm font-medium">
                Weld list <span className="font-normal text-gray-500">({weldsBySpool.reduce((sum, g) => sum + g.welds.length, 0)})</span>
              </p>

              {weldsBySpool.map(({ spoolNo, welds }) => (
                <div key={spoolNo} className="mb-3">
                  <p className="mb-1 text-xs font-medium text-gray-600">
                    {spoolNo === "-" ? (
                      <span className="text-amber-700">Spool not determined</span>
                    ) : (
                      <span className="font-mono">{spoolNo}</span>
                    )}{" "}
                    <span className="font-normal text-gray-500">({welds.length})</span>
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="border-b text-gray-500">
                        <tr>
                          <th className="w-20 py-1">Weld</th>
                          <th className="w-28">Type</th>
                          <th className="w-20">Size</th>
                          <th className="w-36">Against the drawing</th>
                        </tr>
                      </thead>
                      <tbody>
                        {welds.map((w) => (
                          <tr key={w.id} className="border-b">
                            <td className="py-1">{w.weldNo}</td>
                            <td>{w.weldType}</td>
                            <td>{w.size}</td>
                            <td className="text-xs">
                              {/* Nothing to compare against on a sheet whose
                                  boundaries could not be read off the drawing,
                                  which is not a match and not a mismatch. */}
                              {w.drawingSpool == null ? (
                                <span className="text-gray-400">-</span>
                              ) : w.drawingSpool === w.spoolOf ? (
                                <span className="text-green-700">match</span>
                              ) : (
                                <span className="font-medium text-amber-700">mismatch</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
