import { supportProblems, type SupportSheet } from "@/lib/supports";
import { SPAN_CONFIGURATION_LABEL } from "@easy/shared";

// One block per sheet: what the BOM calls for, then every support located on
// the drawing with the spans running off it.
//
// The SPAN is the row, not the support. A support on its own is not right or
// wrong -- it is the gap between two of them that either meets the standard
// or does not, so that gap is what gets a verdict and a figure.

/**
 * TWO CONTACT SHEETS, TWO NUMBERINGS, AND THEY COLLIDE.
 *
 * A support is named by its cell on the BALLOON contact sheet and a printed
 * length by its cell on the DIMENSION one. Both are "<page>-<index>", and on
 * sheet 1 of the reference ISO `1-9` is the secondary support RB103 AND the
 * 1412mm vertical leg -- two unrelated things, one string, shown in adjacent
 * columns of the same row.
 *
 * Renaming either would break the saved `--labels-from` readings that index
 * them, so they keep their cells and the PAGE disambiguates: S for a support
 * balloon, D for a dimension. Cheap, reversible, and it makes every
 * identifier on the page say which sheet to go and look at.
 */
const RUN_END = "(run end)";
const supportRef = (cell: string) => (cell === RUN_END ? cell : `S${cell}`);
const dimensionRef = (cell: string) => `D${cell}`;

export function SupportSheets({ sheets }: { sheets: SupportSheet[] }) {
  return (
    <div className="flex flex-col gap-6">
      {sheets.map((sheet) => (
        <div key={sheet.key} className="rounded border p-4">
          <p className="text-sm font-medium">
            Sheet {sheet.sheetLabel}
            {sheet.lineNumber ? (
              <span className="ml-2 font-mono text-xs text-gray-500">
                {sheet.lineNumber}
              </span>
            ) : null}
          </p>

          {/* WHICH SHEET OF THE STANDARD APPLIES, and how each part of that
              was decided. A span verdict is only as good as the row it was
              looked up in, so the lookup is shown rather than assumed. */}
          <p className="mt-1 text-xs text-gray-500">
            Span standard for{" "}
            <span className="font-medium">
              {sheet.npsInch != null ? `${sheet.npsInch}" NPS` : "unknown size"}
              {sheet.schedule ? ` Sch-${sheet.schedule}` : ""}
              {sheet.material ? `, ${sheet.material}` : ""}
            </span>{" "}
            &mdash; {sheet.basis.join("; ")}
          </p>

          {sheet.items.length > 0 && (
            <table className="mt-3 w-full text-left text-sm">
              <thead>
                <tr className="border-b text-xs uppercase tracking-wide text-gray-500">
                  <th className="w-16 py-1">Item</th>
                  <th>Support the BOM calls for</th>
                  <th className="w-24">Type</th>
                  <th className="w-24">Role</th>
                  <th className="w-20">Size</th>
                  <th className="w-16">Qty</th>
                </tr>
              </thead>
              <tbody>
                {sheet.items.map((item, i) => (
                  <tr
                    key={`${item.itemNo ?? item.description}-${i}`}
                    className="border-b"
                  >
                    <td className="py-1">{item.itemNo ?? ""}</td>
                    <td>{item.description}</td>
                    <td className="font-mono text-xs">
                      {item.typeCode ?? (
                        <span className="text-amber-700">not stated</span>
                      )}
                    </td>
                    <td
                      className={
                        item.role === "unstated" ? "text-amber-700" : ""
                      }
                    >
                      {item.role}
                    </td>
                    <td>{item.size ?? "-"}</td>
                    <td>{item.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* WHAT IS WRONG, AND WHAT TO DO. First, before the tables --
              a reader who stops here should still have the answer. The
              tables below are the evidence for it, not a substitute: a
              number in a cell is something to interpret, an instruction is
              something to act on. */}
          {(() => {
            const problems = supportProblems(sheet);
            if (problems.length === 0)
              return (
                <p className="mt-2 rounded border border-green-500 bg-green-50 px-3 py-2 text-xs text-green-900">
                  Every gap on this sheet is inside the span standard, and every
                  support the BOM calls for was found.
                </p>
              );
            return (
              <ul className="mt-2 flex flex-col gap-2">
                {problems.map((problem, i) => (
                  <li
                    key={i}
                    className={`rounded border px-3 py-2 text-xs ${
                      problem.severity === "error"
                        ? "border-red-500 bg-red-50 text-red-900"
                        : "border-amber-400 bg-amber-50 text-amber-900"
                    }`}
                  >
                    <div className="font-medium">
                      {problem.severity === "error"
                        ? "Breaks the span standard"
                        : "Needs checking"}{" "}
                      &mdash; {problem.what}
                    </div>
                    <div className="mt-1">
                      <span className="font-medium">Do this:</span>{" "}
                      {problem.fix}
                    </div>
                  </li>
                ))}
              </ul>
            );
          })()}

          {sheet.points.length === 0 ? (
            <p className="mt-3 text-xs text-gray-500">
              No supports located on this sheet, so there are no spans to
              measure. The BOM rows above are all that is known.
            </p>
          ) : (
            <>
              {/* Said once, because the two prefixes are the only thing
                  keeping S1-9 (a support) apart from D1-9 (a 1412mm vertical
                  leg) -- the same string naming two different objects on the
                  same drawing. */}
              <p className="mt-3 text-xs text-gray-400">
                <span className="font-mono">S…</span> is a support, by its cell
                on the balloon contact sheet.{" "}
                <span className="font-mono">D…</span> is a printed dimension, by
                its cell on the dimension contact sheet. The two are numbered
                separately and the same number can appear in both.
              </p>
              <table className="mt-1 w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-xs uppercase tracking-wide text-gray-500">
                    <th className="w-28 py-1">Support</th>
                    <th className="w-24">Span to</th>
                    <th className="w-24">Length</th>
                    <th className="w-24">Max</th>
                    <th className="w-32">Verdict</th>
                    <th>On what basis</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.points.map((point) =>
                    (point.spans.length > 0 ? point.spans : [null]).map(
                      (span, i) => (
                        <tr
                          key={`${point.cell}-${i}`}
                          className="border-b align-top"
                        >
                          <td className="py-1">
                            {i === 0 ? (
                              <>
                                {/* Named by its BALLOON, which is what is printed
                                on the drawing beside it -- so a reviewer can
                                find it. The item number alone names three
                                different supports on this sheet. */}
                                <span className="font-mono">
                                  {supportRef(point.cell)}
                                </span>
                                <div className="text-xs text-gray-500">
                                  item {point.itemNo ?? "?"} &middot;{" "}
                                  {point.role}
                                  {point.typeCode ? ` ${point.typeCode}` : ""}
                                </div>
                              </>
                            ) : null}
                          </td>
                          {span === null ? (
                            <td colSpan={5} className="text-xs text-gray-500">
                              {/* Not a fault: the last support on a run starts no
                              span, and a secondary sits AT a primary rather
                              than at a point of its own. */}
                              no span starts here
                            </td>
                          ) : (
                            <>
                              {/* The note about a run end belongs in the basis
                              column, not here: this one is a narrow
                              identifier column, and wrapping a sentence
                              through it made the identifier hard to read. */}
                              <td className="whitespace-nowrap font-mono text-xs">
                                {supportRef(span.toSupport)}
                              </td>
                              <td>
                                {span.lengthMm != null ? (
                                  `${span.lengthMm} mm`
                                ) : (
                                  <span className="text-gray-500">
                                    not read
                                  </span>
                                )}
                              </td>
                              <td>
                                {span.verdict.maxSpanMm != null
                                  ? `${span.verdict.maxSpanMm} mm`
                                  : "-"}
                              </td>
                              <td>
                                {span.verdict.status === "over" ? (
                                  <span className="text-red-600">
                                    over by {span.verdict.overByMm} mm
                                  </span>
                                ) : span.verdict.status === "within" ? (
                                  <span className="text-green-600">
                                    within
                                    {span.verdict.slackMm != null
                                      ? ` (${span.verdict.slackMm} mm spare)`
                                      : ""}
                                  </span>
                                ) : (
                                  <span className="text-gray-500">
                                    not checked
                                  </span>
                                )}
                                {span.verdict.verticalLegOverByMm != null && (
                                  <div className="text-red-600">
                                    vertical leg over by{" "}
                                    {span.verdict.verticalLegOverByMm} mm
                                  </div>
                                )}
                              </td>
                              <td className="text-xs text-gray-500">
                                {span.kind === "run-end" && (
                                  // Reported, not failed. The end of a dimension
                                  // chain can be an anchor, a nozzle, a dead end
                                  // or the point where the line carries on to the
                                  // next sheet -- and what holds it is usually
                                  // not drawn here. Saying nothing would hide the
                                  // longest unheld stretch on the sheet.
                                  <div className="text-amber-700">
                                    This runs to the end of the dimensioned run,
                                    not to another support &mdash; check what
                                    holds it there.
                                  </div>
                                )}
                                {span.verdict.basis}
                                {/* THE WORKINGS. The length is a sum of PRINTED
                                dimensions, named by their own contact-sheet
                                cells, because an isometric is not to scale
                                and nothing here was measured off the page.
                                A reviewer can go and look at each one. */}
                                {span.legs.length > 0 && (
                                  <div className="text-gray-400">
                                    {span.lengthMm} = printed{" "}
                                    {span.legs.map(dimensionRef).join(" + ")}
                                  </div>
                                )}
                                <div className="text-gray-400">
                                  read as{" "}
                                  {span.configurations
                                    .map((c) => SPAN_CONFIGURATION_LABEL[c])
                                    .join(" or ")}
                                  {span.configurations.length > 1
                                    ? " -- the shortest governs"
                                    : ""}
                                </div>
                              </td>
                            </>
                          )}
                        </tr>
                      ),
                    ),
                  )}
                </tbody>
              </table>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
