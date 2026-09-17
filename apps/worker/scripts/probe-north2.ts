// A north symbol is a small BOX with an arrow inside it.
//   pnpm --filter @easy/worker exec tsx scripts/probe-north2.ts <pdf> <page>
import { readFileSync } from "node:fs";
import { readPageGeometry, type GeomPath } from "../src/pdfGeometry";

async function main() {
  const [, , pdfPath, pageArg] = process.argv;
  const geom = await readPageGeometry(readFileSync(pdfPath), Number(pageArg));
  const boxes = geom.paths.filter(
    (p) => p.paint === "stroke" && p.points.length >= 4 && p.points.length <= 6 && p.extent >= 25 && p.extent <= 110
  );
  const filled = geom.paths.filter((p) => p.paint !== "stroke" && p.extent >= 8 && p.extent <= 70);
  const inside = (b: GeomPath["bbox"], p: GeomPath) =>
    p.bbox.x0 >= b.x0 - 2 && p.bbox.x1 <= b.x1 + 2 && p.bbox.y0 >= b.y0 - 2 && p.bbox.y1 <= b.y1 + 2;
  console.log(`${boxes.length} small boxes; those containing a filled shape:`);
  for (const b of boxes) {
    const held = filled.filter((f) => inside(b.bbox, f));
    if (held.length === 0) continue;
    const glyphs = geom.paths.filter((p) => p.paint === "stroke" && p.extent <= 16 && inside(b.bbox, p)).length;
    console.log(
      `   box (${b.bbox.x0.toFixed(0)},${b.bbox.y0.toFixed(0)})-(${b.bbox.x1.toFixed(0)},${b.bbox.y1.toFixed(0)}) ${b.extent.toFixed(0)}pt  ${held.length} filled, ${glyphs} glyph strokes`
    );
  }
}
main();
