// Free: which PAGES of a revised drawing actually moved?
//
//   tsx scripts/probe-page-diff.ts <old.pdf> <new.pdf>
//
// A revision usually touches one sheet. Re-reading the whole document costs a
// vision call per sheet; this says which sheet to pay for, off the vector
// geometry alone. Paths, weld flags and the spool-cut count are compared --
// a sheet identical on all three was not edited.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readPageGeometry } from "../src/pdfGeometry";
import { readWeldMarks } from "../src/extraction/isoWeldMarks";
import { findFlanges } from "../src/extraction/isoSpoolCuts";

const [oldPath, newPath] = process.argv.slice(2);

async function summarize(pdf: string, page: number) {
  const geom = await readPageGeometry(pdf, page);
  const marks = await readWeldMarks(readFileSync(pdf), page);
  // A COUNT is not enough: swapping one digit for another -- "N-15" for
  // "N-17" -- leaves every count identical, and a renumbered spool tag is
  // exactly the kind of revision worth catching. Hash the coordinates.
  const h = createHash("sha1");
  for (const q of geom.paths) {
    h.update(`${q.paint}|${q.lineWidth.toFixed(2)}|`);
    for (const pt of q.points) h.update(`${pt.x.toFixed(2)},${pt.y.toFixed(2)};`);
  }
  return { paths: geom.paths.length, flags: marks.hits.length, flanges: findFlanges(geom.paths).length, hash: h.digest("hex").slice(0, 10) };
}

(async () => {
  console.log(`page   paths (old -> new)      flags        flange bars`);
  for (let p = 1; p <= 5; p++) {
    let a, b;
    try { a = await summarize(oldPath, p); } catch { break; }
    try { b = await summarize(newPath, p); } catch { break; }
    const same = a.hash === b.hash;
    console.log(
      `  ${p}    ${String(a.paths).padStart(6)} -> ${String(b.paths).padEnd(6)}  ` +
      `${String(a.flags).padStart(3)} -> ${String(b.flags).padEnd(3)}   ` +
      `${String(a.flanges).padStart(3)} -> ${String(b.flanges).padEnd(3)}   ` +
      (same ? `unchanged (${a.hash})` : `*** CHANGED ***  ${a.hash} -> ${b.hash}`)
    );
  }
})();
