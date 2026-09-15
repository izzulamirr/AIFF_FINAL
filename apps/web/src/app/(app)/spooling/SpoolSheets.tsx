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
              <p className="mb-2 text-xs text-gray-500">
                Read off the sheet&rsquo;s own &ldquo;PIPE SPOOLS&rdquo; schedule. A spool ends only at a bolted joint -- the point the line
                comes apart with a spanner -- or at a field weld forced by the 6000mm rule. A branch rides along inside whichever spool
                holds its takeoff.
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
              {(() => {
                const all = weldsBySpool.flatMap((g) => g.welds);
                const fromDrawing = all.filter((w) => w.drawingSpool);
                if (fromDrawing.length === 0) {
                  return (
                    <p className="mb-2 text-xs text-gray-500">
                      This sheet&rsquo;s spool boundaries could not be established from the drawing, so the grouping below is the one the
                      extraction produced and has not been checked against it.
                    </p>
                  );
                }
                const moved = fromDrawing.filter((w) => w.drawingSpool !== w.spoolOf);
                const corrected = fromDrawing.filter((w) => w.spoolWas && w.spoolWas !== w.spoolOf);
                return (
                  <p className="mb-2 text-xs text-gray-500">
                    The spool boundaries on this sheet were read off the drawing itself -- from the bolted joints on the run and the field
                    welds in the weld list -- and they account for every spool its PIPE SPOOLS schedule prints.{" "}
                    {moved.length > 0 ? (
                      <span className="text-amber-700">
                        {moved.length} of {fromDrawing.length} welds belong to a different spool than the one stored -- those rows are marked
                        below.
                      </span>
                    ) : corrected.length === 0 ? (
                      <span className="text-green-700">
                        All {fromDrawing.length} welds sit in the spool the drawing puts them in, and none had to be corrected.
                      </span>
                    ) : (
                      <span className="text-green-700">
                        All {fromDrawing.length} welds now sit in the spool the drawing puts them in.{" "}
                        <span className="text-amber-700">
                          {corrected.length} were corrected from what the extraction had recorded -- those rows say what they were.
                        </span>
                      </span>
                    )}
                  </p>
                );
              })()}

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
                          <th className="w-28">NDE</th>
                          <th className="w-56">Against the drawing</th>
                        </tr>
                      </thead>
                      <tbody>
                        {welds.map((w) => (
                          <tr key={w.id} className="border-b">
                            <td className="py-1">{w.weldNo}</td>
                            <td>{w.weldType}</td>
                            <td>{w.size}</td>
                            <td className="text-gray-500">{w.ndeCodes || "-"}</td>
                            <td className="text-xs">
                              {w.drawingSpool == null ? (
                                <span className="text-gray-400">not established</span>
                              ) : w.drawingSpool !== w.spoolOf ? (
                                <span className="font-medium text-amber-700">
                                  belongs to <span className="font-mono">{w.drawingSpool.slice(-4)}</span>, not this one
                                </span>
                              ) : w.spoolWas && w.spoolWas !== w.spoolOf ? (
                                <span className="text-amber-700">
                                  corrected, was <span className="font-mono">{w.spoolWas.slice(-4)}</span>
                                </span>
                              ) : (
                                <span className="text-green-700">confirmed</span>
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
