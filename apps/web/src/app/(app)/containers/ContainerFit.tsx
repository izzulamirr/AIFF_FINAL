"use client";

import { useMemo, useState } from "react";
import { checkSpoolFit, MARGINAL_MM, STANDARD_CONTAINERS, type FitResult, type SpoolFit } from "@easy/shared";
import type { ContainerSpool } from "@/lib/containers";

// Sizes are DERIVED from the dimensions read off the sheets -- there is
// nothing to type. The job on this page is to VERIFY, so every row shows the
// individual lengths that produced its size, each with the cell it was read
// from. One spool, N-01, has been checked against the drawing and comes out
// exactly; the rest have not.
const SIX = ["UP", "DOWN", "N", "S", "E", "W"] as const;

const LONG: Record<string, string> = { UP: "UP", DOWN: "DOWN", N: "NORTH", S: "SOUTH", E: "EAST", W: "WEST" };
const AXIS_KEY = { "UP-DOWN": "upDownMm", "N-S": "nsMm", "E-W": "ewMm" } as const;
/** How the three axes map onto the fit check's own length/width/height. */
const AXIS_SIDE = { "UP-DOWN": "length", "N-S": "width", "E-W": "height" } as const;

/**
 * Which side the field weld's 150mm of excess pipe belongs on.
 *
 * A field weld is a real place on the run, so the slack it needs lies along
 * the axis the pipe runs at that point -- found by the length that attaches
 * to that very weld. Falling back to the LONGEST side, which is what the
 * check does when the direction is unknown, is the worst case rather than
 * the answer: on N-02 the field weld is on the N-S leg, not the 3437mm
 * east one.
 */
function fieldWeldSide(s: ContainerSpool): "length" | "width" | "height" | undefined {
  if (!s.envelope || s.fieldWeldNumbers.length === 0) return undefined;
  for (const [axis, parts] of Object.entries(s.envelope.parts) as Array<[keyof typeof AXIS_SIDE, Array<{ weldNo?: number }>]>) {
    if (parts.some((p) => p.weldNo != null && s.fieldWeldNumbers.includes(p.weldNo))) return AXIS_SIDE[axis];
  }
  return undefined;
}

/**
 * The size as the axes it actually occupies, each named by the DIRECTION it
 * runs in -- "DOWN 588, WEST 404" rather than "588 x 0 x 404".
 *
 * A spool occupies at most three axes and often fewer, so a fixed
 * UP-DOWN x N-S x E-W triple spends two thirds of its width on zeroes and
 * still leaves the reader working out which way round it is. The direction
 * comes from the dimensions themselves; where an axis holds lengths drawn
 * both ways it is named by the axis instead, since neither direction is the
 * honest answer.
 */
function sizeParts(e: NonNullable<ContainerSpool["envelope"]>): Array<{ label: string; mm: number }> {
  const out: Array<{ label: string; mm: number }> = [];
  for (const [axis, key] of Object.entries(AXIS_KEY) as Array<[keyof typeof AXIS_KEY, "upDownMm" | "nsMm" | "ewMm"]>) {
    const mm = e[key];
    if (!mm) continue;
    const dirs = new Set((e.parts[axis] ?? []).map((p) => p.drawnAs));
    const only = dirs.size === 1 ? [...dirs][0] : null;
    out.push({ label: only ? LONG[only] ?? only : axis, mm });
  }
  return out;
}

/**
 * Every dimension that went into a spool, listed ONE BY ONE under its
 * direction -- never rolled into a sum.
 *
 * A total cannot be checked. "DOWN = 1726" is a number to agree with; six
 * separate lengths each carrying the cell they were read from is a list to
 * go through, and the cell id is what ties each back to its own box on the
 * dimension contact sheet and its own place on the drawing.
 *
 * All six directions are shown, empty ones included, because an empty one is
 * evidence too: N-01 having nothing at all sideways is exactly how its
 * missing 404mm branch announces itself.
 *
 * The direction is the sense the dimension is DRAWN in, not the way the pipe
 * flows -- enough to sort a pile into six, not a claim about the run.
 */
function Workings({ envelope }: { envelope: NonNullable<ContainerSpool["envelope"]> }) {
  type Row = { cell: string; mm: number; printedMm?: number; correctionWhy?: string; overshootPt?: number; overshootWeldNo?: number };
  const byDirection = new Map<string, Row[]>();
  for (const list of Object.values(envelope.parts)) {
    for (const p of list)
      byDirection.set(p.drawnAs, [
        ...(byDirection.get(p.drawnAs) ?? []),
        {
          cell: p.cell,
          mm: p.mm,
          printedMm: p.printedMm,
          correctionWhy: p.correctionWhy,
          overshootPt: p.overshootPt,
          overshootWeldNo: p.overshootWeldNo,
        },
      ]);
  }
  if (byDirection.size === 0) return null;
  return (
    <table className="mt-1 text-xs">
      <tbody>
        {SIX.map((d) => {
          const v = byDirection.get(d) ?? [];
          return (
            <tr key={d}>
              <td className="pr-2 align-top font-medium text-gray-400">{d}</td>
              <td className="pr-2 align-top tabular-nums text-gray-500">{v.length}</td>
              <td className="align-top">
                {v.length === 0 ? (
                  <span className="text-gray-600">&mdash;</span>
                ) : (
                  <span className="flex flex-wrap gap-x-3">
                    {v.map((x) => (
                      <span key={x.cell} className="whitespace-nowrap text-gray-400">
                        <span className="text-gray-600">{x.cell}</span> <span className="tabular-nums">{x.mm}</span>
                        {x.printedMm != null && x.printedMm !== x.mm && (
                          // A corrected length always shows what the sheet
                          // prints beside it -- a figure that silently
                          // disagrees with the drawing is unreviewable.
                          <span className="text-amber-700" title={x.correctionWhy}>
                            {" "}
                            (of {x.printedMm} printed)
                          </span>
                        )}
                        {x.overshootPt != null && (
                          // The length runs past the end of this spool, so
                          // part of what it measures is the next one's. How
                          // much cannot be scaled off a drawing that is not
                          // to scale -- look for the overshoot printed as
                          // its own dimension and correct it.
                          <span
                            className="text-red-700"
                            title={`Runs past weld ${x.overshootWeldNo}, which ends this spool, so part of this length belongs to the next one. The sheet usually prints the overshoot as its own dimension -- read it and correct this figure. The total is an over-estimate until you do.`}
                          >
                            {" "}
                            &#9888; past weld {x.overshootWeldNo}
                          </span>
                        )}
                      </span>
                    ))}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * Lengths printed on a sheet that went into no spool, listed once per sheet.
 *
 * Named rather than dropped: a length a reviewer can see printed on the
 * drawing but cannot find in any spool's workings is more confusing than a
 * wrong total. Most are valve assemblies, which are bolted in and ship on
 * their own, so "no pipe" is the expected reason and not a defect.
 */
function Unplaced({ spools }: { spools: ContainerSpool[] }) {
  // Per SHEET, not per spool: every spool on a sheet carries the same list.
  const bySheet = new Map<string, { label: string; rows: Array<{ cell: string; mm: number; why: string }> }>();
  for (const s of spools) {
    const rows = s.envelope?.unplaced ?? [];
    if (rows.length === 0 || bySheet.has(s.sheetLabel)) continue;
    bySheet.set(s.sheetLabel, { label: s.sheetLabel, rows });
  }
  if (bySheet.size === 0) return null;
  return (
    <div className="flex flex-col gap-1 text-xs text-gray-500">
      {[...bySheet.values()].map((sheet) => (
        <p key={sheet.label}>
          <span className="text-gray-600">{sheet.label} &mdash; printed, in no spool:</span>{" "}
          {sheet.rows.map((u) => (
            <span key={u.cell} className="mr-3 whitespace-nowrap">
              <span className="text-gray-600">{u.cell}</span> <span className="tabular-nums">{u.mm}</span>{" "}
              <span className="text-gray-600">({u.why})</span>
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

// Reads the result being SHOWN, not `fit.smallest`: with turning switched
// off the table shows the straight-load answer, and a badge reading off the
// other one would label it "angled" while the row beside it says otherwise.
function HowBadge({ result }: { result: FitResult }) {
  if (result.how === "straight") return <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-800">straight</span>;
  const t = result.tilt;
  return (
    <span
      className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900"
      title={
        result.how === "angled"
          ? `Swung ${result.angleDeg}° across the floor`
          : `Yaw ${t?.yawDeg}°, pitch ${t?.pitchDeg}°, roll ${t?.rollDeg}°`
      }
    >
      {result.how === "angled" ? `angled ${result.angleDeg}°` : "tilted"}
    </span>
  );
}

export function ContainerFit({ spools }: { spools: ContainerSpool[] }) {
  const [allowTurning, setAllowTurning] = useState(true);

  // Sizes come off the drawing. There is nothing to type: the job here is to
  // VERIFY what was read, which is what the per-direction lengths under each
  // one are for.
  const rows = useMemo(
    () =>
      spools.map((s) => {
        const e = s.envelope;
        // A spool measured on no axis has nothing to check yet -- a zero
        // extent is a real answer (a straight piece), an absent one is not.
        const fit = e
          ? checkSpoolFit(
              s.spoolNo,
              { lengthMm: e.upDownMm, widthMm: e.nsMm, heightMm: e.ewMm },
              { fieldWelds: s.fieldWelds, axis: fieldWeldSide(s) }
            )
          : null;
        return { spool: s, fit };
      }),
    [spools]
  );

  const sized = rows.filter((r) => r.fit);
  const shown = (fit: SpoolFit) => (allowTurning ? fit.smallest : fit.smallestStraight);
  // Marginal against what is on screen: `fit.marginal` is about the smallest
  // container of all, which is not the one shown when turning is switched off.
  const tight = (r: FitResult | null) => r != null && r.tightestMm != null && r.tightestMm < MARGINAL_MM;
  const noFit = sized.filter((r) => !shown(r.fit!)).length;
  const marginal = sized.filter((r) => tight(shown(r.fit!))).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={allowTurning} onChange={(e) => setAllowTurning(e.target.checked)} />
          Allow turning and angling
        </label>
        <span className="text-gray-500">
          {sized.length} of {spools.length} sized
          {spools.some((s) => s.envelope) && <span className="text-amber-700"> (derived, unconfirmed)</span>}
          {sized.length > 0 && (
            <>
              {" · "}
              {noFit > 0 ? <span className="text-red-700">{noFit} will not ship</span> : "all ship"}
              {marginal > 0 && <span className="text-amber-700">{` · ${marginal} marginal`}</span>}
            </>
          )}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] border-collapse text-sm">
          <thead>
            <tr className="border-b text-left text-gray-500">
              <th className="py-1 pr-3 font-medium">Spool</th>
              <th className="py-1 pr-3 font-medium">Sheet</th>
              <th className="py-1 pr-3 font-medium">Welds</th>
              <th className="py-1 pr-3 font-medium">Field welds</th>
              <th className="py-1 pr-3 font-medium">Size (mm)</th>
              <th className="py-1 pr-3 font-medium">Ships as</th>
              <th className="py-1 pr-3 font-medium">Container</th>
              <th className="py-1 pr-3 font-medium">Loaded</th>
              <th className="py-1 pr-3 font-medium">Clearance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ spool, fit }) => {
              const best = fit ? shown(fit) : null;
              return (
                <tr key={spool.key} className="border-b last:border-0 align-top">
                  <td className="py-1.5 pr-3 font-medium">{spool.spoolNo}</td>
                  <td className="py-1.5 pr-3 text-gray-500">{spool.sheetLabel}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{spool.weldCount}</td>
                  <td className="py-1.5 pr-3 tabular-nums">
                    {spool.fieldWelds > 0 ? (
                      <span className="text-amber-800" title={`+${spool.fieldWelds * 150}mm of excess pipe`}>
                        {spool.fieldWelds}
                      </span>
                    ) : (
                      <span className="text-gray-400">0</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    <div className="flex items-center gap-3">
                      {spool.envelope ? (
                        (() => {
                          const parts = sizeParts(spool.envelope);
                          if (parts.length === 0) return <span className="text-gray-400">no extent read</span>;
                          return (
                            <span className="flex flex-wrap gap-x-3">
                              {parts.map((x) => (
                                <span key={x.label} className="whitespace-nowrap">
                                  <span className="text-gray-500">{x.label}</span>{" "}
                                  <span className="tabular-nums font-medium">{x.mm}</span>
                                </span>
                              ))}
                            </span>
                          );
                        })()
                      ) : (
                        <span className="text-gray-400">not read</span>
                      )}
                      {spool.envelope && (
                        <span
                          className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900"
                          title="Worked out from the sheet's own dimensions -- check it against the lengths below."
                        >
                          derived
                        </span>
                      )}
                    </div>
                    {spool.envelope && <Workings envelope={spool.envelope} />}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums text-gray-600">
                    {fit
                      ? `${Math.round(fit.shipping.lengthMm)} × ${Math.round(fit.shipping.widthMm)} × ${Math.round(fit.shipping.heightMm)}`
                      : ""}
                  </td>
                  <td className="py-1.5 pr-3">{best ? best.container : fit ? <span className="text-red-700">none</span> : ""}</td>
                  <td className="py-1.5 pr-3">{best ? <HowBadge result={best} /> : ""}</td>
                  <td className="py-1.5 pr-3 tabular-nums">
                    {best ? (
                      <span className={tight(best) ? "text-amber-800" : ""}>
                        {best.tightestMm}mm{tight(best) ? " — confirm" : ""}
                      </span>
                    ) : fit ? (
                      <span className="text-red-700">{fit.results[0]?.blockedBy[0] ?? ""}</span>
                    ) : (
                      ""
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Unplaced spools={spools} />

      <p className="text-xs text-gray-500">
        Sizes marked <span className="text-amber-800">derived</span> were worked out from the dimensions printed on the sheets. Each length
        is tied to a spool by where it meets the pipe, and a length spanning a bolted-in valve is listed as belonging to no spool, because
        a valve ships on its own. One spool has been checked against the drawing; the rest{" "}
        <span className="font-medium">have not been confirmed</span> &mdash; the lengths under each one are what went into it, so a wrong
        total can be spotted by which length does not belong. Checked against{" "}
        {STANDARD_CONTAINERS.map((c) => c.name).join(", ")}; internal sizes are nominal and vary between operators by a few tens of
        millimetres, so anything under 50mm of clearance is marked to confirm against the actual container. A field weld adds 150mm of
        excess pipe per NOTE 4.
      </p>
    </div>
  );
}
