// Free: every BOM item balloon found on a page, and where its leader lands.
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-item-balloons.ts <pdf> [page]
//
// Runs the real `findItemBalloons` rather than a copy of it, so what this
// prints is what the extraction would use.
import { readPageCount } from "../src/pdfGeometry";
import { readItemBalloons } from "../src/extraction/isoPipeSupports";

const [pdf, pageArg] = process.argv.slice(2);
if (!pdf) {
  console.error("usage: tsx scripts/probe-item-balloons.ts <pdf> [page]");
  process.exit(1);
}

async function main() {
  const count = await readPageCount(pdf);
  const pages = pageArg ? [Number(pageArg)] : Array.from({ length: count }, (_, i) => i + 1);
  let total = 0;
  for (const page of pages) {
    const { balloons } = await readItemBalloons(pdf, page);
    total += balloons.length;
    console.log(`\npage ${page}: ${balloons.length} item balloons leadering to the run`);
    balloons.forEach((b, i) => {
      console.log(
        `  ${`${page}-${i + 1}`.padEnd(7)} box ${(b.box.x1 - b.box.x0).toFixed(1)}x${(b.box.y1 - b.box.y0).toFixed(1)} at (${b.box.x0.toFixed(0)},${b.box.y0.toFixed(0)})` +
          `  leader ${b.leaderPt.toFixed(0)}pt -> (${b.at.x.toFixed(0)},${b.at.y.toFixed(0)})  ${b.offRunPt.toFixed(1)}pt off the run`
      );
    });
  }
  console.log(`\n${total} balloons across ${pages.length} page(s)`);
}

void main();
