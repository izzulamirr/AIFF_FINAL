"use client";

import { useMemo, useState } from "react";
import { TWENTY_FOOT_CONTAINERS, type FitResult, type SpoolFit } from "@easy/shared";
import type { ContainerSpool } from "@/lib/containers";
import { fitOf, isTight as tight, nearMiss } from "@/lib/containerFit";
import { Badge } from "@/components/ui/primitives";

// Sizes are DERIVED from the dimensions read off the sheets -- there is
// nothing to type. The job on this page is to VERIFY, so every row shows the
// individual lengths that produced its size, each with the cell it was read
// from. One spool, N-01, has been checked against the drawing and comes out
// exactly; the rest have not.
const SIX = ["UP", "DOWN", "N", "S", "E", "W"] as const;

const LONG: Record<string, string> = { UP: "UP", DOWN: "DOWN", N: "NORTH", S: "SOUTH", E: "EAST", W: "WEST" };
const AXIS_KEY = { "UP-DOWN": "upDownMm", "N-S": "nsMm", "E-W": "ewMm" } as const;

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
              <td className="pr-2 align-top font-medium text-muted-foreground">{d}</td>
              <td className="pr-2 align-top tabular-nums text-muted-foreground">{v.length}</td>
              <td className="align-top">
                {v.length === 0 ? (
                  <span className="text-muted-foreground">&mdash;</span>
                ) : (
                  <span className="flex flex-wrap gap-x-3">
                    {v.map((x) => (
                      <span key={x.cell} className="whitespace-nowrap">
                        <span className="text-muted-foreground">{x.cell}</span> <span className="tabular-nums">{x.mm}</span>
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
    <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
      {[...bySheet.values()].map((sheet) => (
        <p key={sheet.label}>
          <span className="font-medium text-foreground">{sheet.label} &mdash; printed, in no spool:</span>{" "}
          {sheet.rows.map((u) => (
            <span key={u.cell} className="mr-3 whitespace-nowrap">
              <span>{u.cell}</span> <span className="tabular-nums text-foreground">{u.mm}</span> <span>({u.why})</span>
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
  if (result.how === "straight") return <Badge tone="success">straight</Badge>;
  const t = result.tilt;
  return (
    <Badge
      tone="warning"
      title={
        result.how === "angled"
          ? `Swung ${result.angleDeg}° across the floor`
          : `Yaw ${t?.yawDeg}°, pitch ${t?.pitchDeg}°, roll ${t?.rollDeg}°`
      }
    >
      {result.how === "angled" ? `angled ${result.angleDeg}°` : "tilted"}
    </Badge>
  );
}

export function ContainerFit({ spools }: { spools: ContainerSpool[] }) {
  const [allowTurning, setAllowTurning] = useState(true);

  // Sizes come off the drawing. There is nothing to type: the job here is to
  // VERIFY what was read, which is what the per-direction lengths under each
  // one are for.
  // The fit itself is in lib/containerFit.ts, shared with a line's summary so the
  // two cannot disagree.
  const rows = useMemo(() => spools.map((s) => ({ spool: s, fit: fitOf(s) })), [spools]);

  const sized = rows.filter((r) => r.fit);
  const shown = (fit: SpoolFit) => (allowTurning ? fit.smallest : fit.smallestStraight);
  // Marginal against what is on screen (`tight`): `fit.marginal` is about the
  // smallest container of all, which is not the one shown when turning is
  // switched off.
  const noFit = sized.filter((r) => !shown(r.fit!)).length;
  const marginal = sized.filter((r) => tight(shown(r.fit!))).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="card flex flex-wrap items-center justify-between gap-x-6 gap-y-3 p-4">
        <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium">
          <input type="checkbox" checked={allowTurning} onChange={(e) => setAllowTurning(e.target.checked)} className="h-4 w-4" />
          Allow turning and angling
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Badge>
            {sized.length} of {spools.length} sized
          </Badge>
          {sized.length > 0 && (
            <>
              {noFit > 0 ? (
                <Badge tone="danger" dot>
                  {noFit} will not ship
                </Badge>
              ) : (
                <Badge tone="success" dot>
                  all ship
                </Badge>
              )}
              {marginal > 0 && (
                <Badge tone="warning" dot>
                  {marginal} marginal
                </Badge>
              )}
            </>
          )}
        </div>
      </div>

      <div className="card card-flush">
        <div className="table-wrap">
          <table className="table table-top min-w-[56rem]">
            <thead>
              <tr>
                <th>Spool</th>
                <th>Sheet</th>
                <th>Welds</th>
                <th>Field welds</th>
                <th>Size (mm)</th>
                <th>Ships as</th>
                <th>Container</th>
                <th>Loaded</th>
                <th>Clearance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ spool, fit }) => {
                const best = fit ? shown(fit) : null;
                return (
                  <tr key={spool.key}>
                    <td className="font-medium">{spool.spoolNo}</td>
                    <td className="text-muted-foreground">{spool.sheetLabel}</td>
                    <td className="tabular-nums">{spool.weldCount}</td>
                    <td className="tabular-nums">
                      {spool.fieldWelds > 0 ? (
                        <span className="font-medium text-warning" title={`+${spool.fieldWelds * 150}mm of excess pipe`}>
                          {spool.fieldWelds}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </td>
                    <td>
                      <div className="flex items-center gap-3">
                        {spool.envelope ? (
                          (() => {
                            const parts = sizeParts(spool.envelope);
                            if (parts.length === 0) return <span className="text-muted-foreground">no extent read</span>;
                            return (
                              <span className="flex flex-wrap gap-x-3">
                                {parts.map((x) => (
                                  <span key={x.label} className="whitespace-nowrap">
                                    <span className="text-muted-foreground">{x.label}</span>{" "}
                                    <span className="tabular-nums font-medium">{x.mm}</span>
                                  </span>
                                ))}
                              </span>
                            );
                          })()
                        ) : (
                          <span className="text-muted-foreground">not read</span>
                        )}
                      </div>
                      {spool.envelope && <Workings envelope={spool.envelope} />}
                    </td>
                    <td className="tabular-nums text-muted-foreground">
                      {fit
                        ? `${Math.round(fit.shipping.lengthMm)} × ${Math.round(fit.shipping.widthMm)} × ${Math.round(fit.shipping.heightMm)}`
                        : ""}
                    </td>
                    <td>
                      {best ? (
                        best.container
                      ) : fit ? (
                        // A NEAR MISS IS NOT A NO. Container internals vary
                        // between operators by more than these spools miss by,
                        // so "none" on a nominal spec would send someone away
                        // to re-cut a spool that goes in.
                        nearMiss(fit) != null ? (
                          <span className="font-medium text-warning">{nearMiss(fit)!.container}?</span>
                        ) : (
                          <span className="font-medium text-danger">none</span>
                        )
                      ) : (
                        ""
                      )}
                    </td>
                    <td>{best ? <HowBadge result={best} /> : ""}</td>
                    <td className="tabular-nums">
                      {best ? (
                        <span className={tight(best) ? "font-medium text-warning" : ""}>
                          {best.tightestMm}mm{tight(best) ? " — confirm" : ""}
                        </span>
                      ) : fit && nearMiss(fit) ? (
                        <span className="font-medium text-warning">
                          over by {nearMiss(fit)!.shortfallMm}mm — measure the actual box
                        </span>
                      ) : fit ? (
                        <span className="text-danger">{fit.results[0]?.blockedBy[0] ?? ""}</span>
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
      </div>

      <Unplaced spools={spools} />

      <p className="callout max-w-4xl text-xs">
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
