// Free: run the container check over an envelopes file, 20ft only.
//   tsx scripts/probe-container-fit-all.ts <envelopes.json>
import { readFileSync } from "node:fs";
import {
  checkSpoolFit,
  FIELD_WELD_ALLOWANCE_MM,
  NEAR_MISS_MM,
  TWENTY_FOOT_CONTAINERS,
  withFieldWeldAllowance,
} from "@easy/shared";

const { envelopes } = JSON.parse(readFileSync(process.argv[2], "utf8"));
console.log(`checked against: ${TWENTY_FOOT_CONTAINERS.map((c) => c.name).join(", ")}\n`);
console.log(`spool   sheet  size (up x ns x ew)          turning allowed        loaded square`);
console.log(process.env.OD ? `  (as a RUN, pipe OD ${process.env.OD}mm)` : "  (as a BOX)");
for (const e of envelopes) {
  const fw = Number(process.env.FIELD_WELDS ?? 0);
  const fit = checkSpoolFit(
    e.spool,
    { lengthMm: e.upDownMm, widthMm: e.nsMm, heightMm: e.ewMm },
    {
      containers: TWENTY_FOOT_CONTAINERS,
      fieldWelds: fw,
      shape:
        e.shape && Number(process.env.OD ?? 0) > 0
          ? { points: withFieldWeldAllowance(e.shape, FIELD_WELD_ALLOWANCE_MM * fw).points, odMm: Number(process.env.OD) }
          : undefined,
    }
  );
  const near = fit.results
    .filter((r) => !r.fits && r.shortfallMm != null && r.shortfallMm <= NEAR_MISS_MM)
    .sort((a, b) => a.shortfallMm! - b.shortfallMm!)[0];
  const say = (r: (typeof fit)["smallest"]) =>
    r
      ? `${r.container} (${r.how}${r.tightestMm != null ? `, ${Math.round(r.tightestMm)}mm` : ""})`
      : near
        ? `${near.container}? over by ${near.shortfallMm}mm`
        : "WILL NOT SHIP";
  console.log(
    `${e.spool.split("-").slice(-2).join("-").padEnd(6)}  ${String(e.page).padEnd(5)}  ` +
      `${`${e.upDownMm} x ${e.nsMm} x ${e.ewMm}`.padEnd(26)} ${say(fit.smallest).padEnd(22)} ${say(fit.smallestStraight)}`
  );
}
