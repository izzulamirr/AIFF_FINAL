// Which weld block does each printed SPOOL TAG point at?
//
//   pnpm --filter @easy/worker exec tsx scripts/export-spool-tags.ts \
//       <file.pdf> <weld-geometry.json> <spool-cuts.json> <out.json> \
//       [--preview tags.png] [--labels-from labels.json]
//
// Tracing the leaders is FREE -- geometry only. Reading the tag STRING in
// each box is the only part that needs eyes, and `--preview` renders those
// boxes as one contact sheet so they can be read off it and replayed through
// `--labels-from` at no cost, exactly as the weld flags are.
//
// Why this exists: `assignSpools` maps tags onto blocks in SORTED ORDER, and
// on sheet 4 of the reference ISO that is wrong. Its `...-N-14` leader lands
// on the 6000mm piece between the two FW ticks -- the middle block -- while
// sorted order hands that block to N-13. The drawing wins.
import { readFileSync, writeFileSync } from "node:fs";
import { readPageGeometry, readPageCount } from "../src/pdfGeometry";
import { findSpoolTagLeaders, blockOfLeader } from "../src/extraction/isoSpoolTags";
import { renderMultiPageContactSheet, type ContactSheetRegion } from "../src/pdfImages";

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const [pdfPath, weldPath, cutsPath, outPath] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!pdfPath || !weldPath || !cutsPath || !outPath) {
    console.error("usage: tsx scripts/export-spool-tags.ts <file.pdf> <weld-geometry.json> <spool-cuts.json> <out.json> [--preview tags.png] [--labels-from labels.json]");
    process.exit(1);
  }
  const geom = JSON.parse(readFileSync(weldPath, "utf8"));
  const cuts = JSON.parse(readFileSync(cutsPath, "utf8"));
  const labels: Record<string, string> = flag("--labels-from") ? JSON.parse(readFileSync(flag("--labels-from")!, "utf8")) : {};

  const pageCount = await readPageCount(pdfPath);
  const pages: Array<{ page: number; tags: unknown[] }> = [];
  const preview: Array<{ pageNumber: number; regions: ContactSheetRegion[] }> = [];

  for (let page = 1; page <= pageCount; page++) {
    const welds = (geom.pages.find((p: { page: number }) => p.page === page)?.welds ?? [])
      .filter((w: { mark?: unknown; weldNo: number }) => w.mark && w.weldNo > 0)
      .map((w: { weldNo: number; mark: { x: number; y: number } }) => ({ weldNo: w.weldNo, mark: w.mark }));
    const cutPage = cuts.pages.find((p: { page: number }) => p.page === page);
    const cutList: number[] = cutPage?.cuts ?? [];
    // The spool each block resolves to under the CURRENT sorted-order map,
    // so the two answers can be compared rather than one silently replacing
    // the other.
    const sortedOrder: string[] = [];
    for (const a of cutPage?.assignment ?? []) {
      const idx = [...new Set(cutList)].sort((x, y) => x - y).filter((c) => a.weldNo > c).length;
      sortedOrder[idx] = a.spool;
    }

    const { paths } = await readPageGeometry(pdfPath, page);
    const leaders = findSpoolTagLeaders(paths, welds);
    if (leaders.length === 0) continue;

    const regions: ContactSheetRegion[] = [];
    const tags = leaders.map((l, i) => {
      const cell = `${page}-${i + 1}`;
      regions.push({ label: cell, bbox: l.box });
      const block = blockOfLeader(l.flanking, cutList);
      return {
        cell,
        box: l.box,
        tip: l.tip,
        at: l.at,
        offRunPt: l.offRunPt,
        flanking: l.flanking,
        block,
        /** What the tag string is, once someone has read the box. */
        tag: labels[cell] ?? null,
        /** What sorted order would have called this block. */
        sortedOrder: block == null ? null : sortedOrder[block] ?? null,
      };
    });
    preview.push({ pageNumber: page, regions });
    pages.push({ page, tags });

    console.log(`page ${page}: ${leaders.length} spool tag${leaders.length === 1 ? "" : "s"}`);
    for (const t of tags as Array<Record<string, unknown>>) {
      const f = t.flanking as [number, number] | null;
      const read = t.tag as string | null;
      const sorted = t.sortedOrder as string | null;
      const agree = read && sorted ? (read === sorted ? "  agrees" : `  DISAGREES with sorted order (${short(sorted)})`) : "";
      console.log(
        `  ${String(t.cell).padEnd(5)} ${(read ? short(read) : "unread").padEnd(8)} block ${t.block ?? "?"}` +
          `  ${f ? `between welds ${f[0]} and ${f[1]}` : "no flanking pair"}` +
          `  ${String(t.offRunPt).padStart(5)}pt off the run${agree}`
      );
    }
  }

  const previewPath = flag("--preview");
  if (previewPath) {
    const png = await renderMultiPageContactSheet(pdfPath, preview);
    if (png) {
      writeFileSync(previewPath, Buffer.from(png, "base64"));
      console.log(`\npreview written to ${previewPath} -- nothing sent, no cost. Read the tags off it and replay with --labels-from.`);
    }
  }
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), pages }, null, 2));
  console.log(`\nwrote ${outPath}`);
}

const short = (s: string) => s.replace(/^.*-N-/, "N-");
main();
