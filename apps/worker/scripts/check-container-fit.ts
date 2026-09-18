// Will these spools ship? Pure arithmetic -- no API call, nothing to pay for.
//
//   pnpm --filter @easy/worker exec tsx scripts/check-container-fit.ts <spools.json>
//   pnpm --filter @easy/worker exec tsx scripts/check-container-fit.ts --size 6000x400x400 --field-welds 1
//
// spools.json is a list of envelopes:
//   [{ "spool": "N-12", "lengthMm": 6000, "widthMm": 400, "heightMm": 400,
//      "fieldWelds": 1, "axis": "length" }]
//
// `axis` is the direction the field-adjusted joint lies along; leave it out
// and the 150mm allowance goes on the longest side, which is the worst case.
import { readFileSync } from "node:fs";
import { checkSpoolFit, STANDARD_CONTAINERS, TWENTY_FOOT_CONTAINERS, type Envelope } from "@easy/shared";

interface SpoolInput extends Envelope {
  spool: string;
  fieldWelds?: number;
  axis?: "length" | "width" | "height";
}

const mm = (n: number) => `${Math.round(n)}`.padStart(6);

function main() {
  const args = process.argv.slice(2);
  const arg = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  let spools: SpoolInput[];
  const size = arg("--size");
  if (size) {
    const [l, w, h] = size.split(/[x*]/i).map(Number);
    if (![l, w, h].every((n) => Number.isFinite(n) && n > 0)) {
      console.error(`--size wants LxWxH in mm, e.g. 6000x400x400`);
      process.exit(1);
    }
    spools = [
      {
        spool: arg("--spool") ?? "spool",
        lengthMm: l,
        widthMm: w,
        heightMm: h,
        fieldWelds: Number(arg("--field-welds") ?? 0),
        axis: arg("--axis") as SpoolInput["axis"],
      },
    ];
  } else {
    const path = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);
    if (!path) {
      console.error("usage: tsx scripts/check-container-fit.ts <spools.json> | --size LxWxH [--field-welds N] [--axis length|width|height]");
      process.exit(1);
    }
    spools = JSON.parse(readFileSync(path, "utf8"));
  }

  // TWENTY FOOT ONLY by default, matching the page: this refinery does not
  // ship anything larger, so answering "40ft HC" for a spool that beats a
  // 20ft hides the thing worth knowing -- that it has to be cut differently.
  // --all-sizes puts the full equipment list back for a one-off question.
  const only20 = !process.argv.includes("--all-sizes");
  const containers = only20 ? TWENTY_FOOT_CONTAINERS : STANDARD_CONTAINERS;
  console.log(
    `containers checked: ${containers.map((c) => c.name).join(", ")}` +
      (only20 ? "  (20ft only; --all-sizes for the full list)" : "") +
      "\n"
  );

  let noFit = 0;
  let marginal = 0;
  let angled = 0;
  for (const s of spools) {
    const r = checkSpoolFit(s.spool, { lengthMm: s.lengthMm, widthMm: s.widthMm, heightMm: s.heightMm }, { ...s, containers });
    const fw = r.fieldWelds > 0 ? `  +${r.shipping.lengthMm - r.envelope.lengthMm || 150}mm for ${r.fieldWelds} field weld${r.fieldWelds > 1 ? "s" : ""}` : "";
    console.log(
      `${s.spool.padEnd(8)} ${mm(r.envelope.lengthMm)} x ${mm(r.envelope.widthMm)} x ${mm(r.envelope.heightMm)}${fw}`
    );
    if (r.fieldWelds > 0) {
      console.log(`         ships as ${mm(r.shipping.lengthMm)} x ${mm(r.shipping.widthMm)} x ${mm(r.shipping.heightMm)}`);
    }
    if (r.smallest) {
      const o = r.smallest.orientation!;
      const t = r.smallest.tilt;
      const how =
        r.smallest.how === "angled"
          ? `ANGLED ${r.smallest.angleDeg} deg across the floor`
          : r.smallest.how === "tilted"
            ? `TILTED yaw ${t!.yawDeg} / pitch ${t!.pitchDeg} / roll ${t!.rollDeg} deg`
            : "straight";
      console.log(
        `         -> ${r.smallest.container}, ${how}, ${r.smallest.tightestMm}mm clearance, loaded ${o.map((n) => Math.round(n)).join(" x ")}` +
          (r.marginal ? "   MARGINAL -- confirm against the actual container" : "")
      );
      // Angling is a decision, not a default: say what loading it square costs.
      if (r.smallest.how !== "straight") {
        angled++;
        console.log(
          r.smallestStraight
            ? `            square instead: ${r.smallestStraight.container}`
            : `            nothing on the list takes it square`
        );
      }
      if (r.marginal) marginal++;
    } else {
      noFit++;
      console.log(`         -> DOES NOT FIT any of them`);
      for (const why of r.results[0].blockedBy) console.log(`            ${why}`);
    }
    console.log("");
  }

  console.log(
    `${spools.length} spool${spools.length === 1 ? "" : "s"}: ${spools.length - noFit} fit (${angled} need turning), ${noFit} do not, ${marginal} marginal`
  );
}

main();
