"use client";

import { useMemo, useState } from "react";
import {
  checkSpoolFit,
  FIELD_WELD_ALLOWANCE_MM,
  MARGINAL_MM,
  NEAR_MISS_MM,
  TWENTY_FOOT_CONTAINERS,
  withFieldWeldAllowance,
  type FitResult,
  type SpoolFit,
} from "@easy/shared";
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
  for (const [axis, parts] of Object.entries(s.envelope.parts) as Array<
    [keyof typeof AXIS_SIDE, Array<{ weldNo?: number; weldNos?: number[] }>]
  >) {
    // EVERY weld the length reaches, not just the one it is keyed by. A
    // length ending AT its spool's closing weld is keyed by the weld at its
    // other end: N-02's 881 is keyed 11 while the field weld it runs to is
    // 12, so matching on the key alone found nothing and the 150mm went to
    // the longest side -- 3437 east -- instead of the N-S leg carrying the
    // weld.
    const touches = (p: { weldNo?: number; weldNos?: number[] }) =>
      (p.weldNos ?? (p.weldNo != null ? [p.weldNo] : [])).some((n) => s.fieldWeldNumbers.includes(n));
    if (parts.some(touches)) return AXIS_SIDE[axis];
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
/**
 * The extents to show against a spool, named by direction.
 *
 * An axis carrying lengths BOTH ways is split and reported as both, not rolled
 * into one figure under the axis name. N-03 drops 2376 down its main leg and
 * rises 385 up each of two weldolet branches: "UP-DOWN 3652" is a number that
 * describes nothing -- it is neither the drop, nor the rise, nor the height of
 * anything -- while "DOWN 2882, UP 770" is what the drawing says and what a
 * reviewer can check leg by leg.
 */
/**
 * The container it ALMOST goes in, when none takes it outright.
 *
 * A spool over a nominal internal size by less than containers vary between
 * operators has not been shown not to fit -- it has been shown to need a tape
 * measure. N-10 carrying its field-weld allowance is the case: 6150 x 721 x
 * 457 against a 20ft, missing by single-digit millimetres on a spec quoted to
 * the nearest millimetre and built to rather less than that.
 */
function nearMiss(fit: SpoolFit): FitResult | null {
  const close = fit.results
    .filter((r) => !r.fits && r.shortfallMm != null && r.shortfallMm <= NEAR_MISS_MM)
    .sort((a, b) => a.shortfallMm! - b.shortfallMm!);
  return close[0] ?? null;
}

function sizeParts(e: NonNullable<ContainerSpool["envelope"]>): Array<{ label: string; mm: number }> {
  const out: Array<{ label: string; mm: number }> = [];
  for (const [axis, key] of Object.entries(AXIS_KEY) as Array<[keyof typeof AXIS_KEY, "upDownMm" | "nsMm" | "ewMm"]>) {
    const mm = e[key];
    if (!mm) continue;
    const byDirection = new Map<string, number>();
    for (const p of e.parts[axis] ?? []) byDirection.set(p.drawnAs, (byDirection.get(p.drawnAs) ?? 0) + p.mm);
    if (byDirection.size <= 1) {
      const only = [...byDirection.keys()][0];
      out.push({ label: only ? LONG[only] ?? only : axis, mm });
      continue;
    }
    // Biggest first, so the leg that decides the spool reads first.
    for (const [dir, total] of [...byDirection.entries()].sort((a, b) => b[1] - a[1])) {
      out.push({ label: LONG[dir] ?? dir, mm: total });
    }
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
  type Row = { cell: string; mm: number };
  const byDirection = new Map<string, Row[]>();
  for (const list of Object.values(envelope.parts)) {
    for (const p of list)
      byDirection.set(p.drawnAs, [...(byDirection.get(p.drawnAs) ?? []), { cell: p.cell, mm: p.mm }]);
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
              // TWENTY FOOT ONLY. A spool that beats a 20ft reports "will
              // not ship" rather than being answered with a 40ft: that is a
              // spool to cut differently, and saying so is the point.
              //
              // And the RUN where it is known, so the check is done on the
              // pipe rather than on the box around it. The field-weld excess
              // goes onto the run itself -- it is pipe left on the end.
              {
                fieldWelds: s.fieldWelds,
                axis: fieldWeldSide(s),
                containers: TWENTY_FOOT_CONTAINERS,
                shape:
                  e.shape && s.pipeOdMm != null
                    ? {
                        points: withFieldWeldAllowance(
                          e.shape as never,
                          FIELD_WELD_ALLOWANCE_MM * s.fieldWelds
                        ).points,
                        odMm: s.pipeOdMm,
                      }
                    : undefined,
              }
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
                    </div>
                    {spool.envelope && <Workings envelope={spool.envelope} />}
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums text-gray-600">
                    {fit
                      ? `${Math.round(fit.shipping.lengthMm)} × ${Math.round(fit.shipping.widthMm)} × ${Math.round(fit.shipping.heightMm)}`
                      : ""}
                  </td>
                  <td className="py-1.5 pr-3">
                    {best ? (
                      best.container
                    ) : fit ? (
                      // A NEAR MISS IS NOT A NO. Container internals vary
                      // between operators by more than these spools miss by,
                      // so "none" on a nominal spec would send someone away
                      // to re-cut a spool that goes in.
                      nearMiss(fit) != null ? (
                        <span className="text-amber-800">{nearMiss(fit)!.container}?</span>
                      ) : (
                        <span className="text-red-700">none</span>
                      )
                    ) : (
                      ""
                    )}
                  </td>
                  <td className="py-1.5 pr-3">{best ? <HowBadge result={best} /> : ""}</td>
                  <td className="py-1.5 pr-3 tabular-nums">
                    {best ? (
                      <span className={tight(best) ? "text-amber-800" : ""}>
                        {best.tightestMm}mm{tight(best) ? " — confirm" : ""}
                      </span>
                    ) : fit && nearMiss(fit) ? (
                      <span className="text-amber-800">
                        over by {nearMiss(fit)!.shortfallMm}mm — measure the actual box
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
        Sizes are worked out from the dimensions printed on the sheets. Each length is tied to a spool by where it meets the pipe, and a
        length spanning a bolted-in valve is listed as belonging to no spool, because a valve ships on its own. The lengths under each
        size are what went into it, so a wrong total can be spotted by which length does not belong. Checked against{" "}
        {TWENTY_FOOT_CONTAINERS.map((c) => c.name).join(" and ")} only &mdash; nothing larger, so a spool that beats a 20ft is reported as
        not shipping rather than answered with a 40ft. Internal sizes are nominal and vary between operators by a few tens of
        millimetres, so anything under 50mm of clearance is marked to confirm against the actual container. A field weld adds 150mm of
        excess pipe per NOTE 4.
      </p>
    </div>
  );
}
