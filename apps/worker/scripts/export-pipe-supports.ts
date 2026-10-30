// The PIPE SUPPORTS on an isometric, found geometrically and written out.
//
//   tsx scripts/export-pipe-supports.ts <file.pdf> <welds.json> out.json \
//       [--preview sheet.png] [--labels-from labels.json] [--pages 1,2]
//
// FREE except for reading the number inside each balloon, and even that need
// not be paid for: `--preview` renders the exact contact sheet a call would
// send and writes it to disk instead of sending it, so the numbers can be
// read by eye and fed back through `--labels-from`. Same arrangement as the
// weld flags and the spool tags, and for the same reason -- a broken render
// costs nothing to find, and the sheet is legible enough that the reading is
// a second opinion rather than an expense.
//
// `welds.json` is the dumped WELD LIST (packages/db/scripts/dump-weld-list.mjs).
// It supplies the BOM's support rows, which is what says WHICH item numbers
// are supports -- the whole detector rests on that lookup rather than on
// recognising a symbol.
import { readFileSync, writeFileSync } from "node:fs";
import { readPageCount } from "../src/pdfGeometry";
import { renderRegionContactSheet, type ContactSheetRegion } from "../src/pdfImages";
import {
  pipeSupportsOf,
  readItemBalloons,
  supportCountCheck,
  supportSpansWhenComplete,
  type DimensionLeg,
  type SupportItemRow,
} from "../src/extraction/isoPipeSupports";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const [pdf, bomPath, outPath] = positional;
const previewPath = flag("--preview");
const labelsPath = flag("--labels-from");
const pagesArg = flag("--pages");
// The printed lengths. Without them a support can be LOCATED but no span
// can be measured, because an isometric is not drawn to scale.
const dimsPath = flag("--dims");

if (!pdf || !bomPath) {
  console.error("usage: tsx scripts/export-pipe-supports.ts <file.pdf> <welds.json> out.json [--preview sheet.png] [--labels-from labels.json] [--pages 1,2]");
  process.exit(1);
}

/** The BOM's support rows, per page, keyed by item number. */
function supportItemsByPage(bomJson: unknown): Map<number, SupportItemRow[]> {
  const out = new Map<number, SupportItemRow[]>();
  const rows = Array.isArray(bomJson) ? bomJson : ((bomJson as Record<string, unknown>)?.bom as unknown[]) ?? [];
  for (const raw of rows as Array<Record<string, unknown>>) {
    const text = `${raw.component_type ?? ""} ${raw.description ?? ""}`;
    if (!/support/i.test(text)) continue;
    const page = Number(raw.page ?? raw.source_page ?? 1);
    const itemNo = String(raw.item_no ?? raw.itemNo ?? "").trim();
    if (!itemNo) continue;
    const quantity = Number(String(raw.quantity ?? "1").replace(/[^0-9.]/g, "")) || 1;
    const list = out.get(page) ?? [];
    list.push({ itemNo, description: String(raw.description ?? ""), quantity });
    out.set(page, list);
  }
  return out;
}

async function main() {
  const bom = JSON.parse(readFileSync(bomPath, "utf8"));
  const itemsByPage = supportItemsByPage(bom);
  const labels: Record<string, string> = labelsPath ? JSON.parse(readFileSync(labelsPath, "utf8")) : {};
  const dimsJson = dimsPath ? JSON.parse(readFileSync(dimsPath, "utf8")) : null;
  const legsByPage = new Map<number, DimensionLeg[]>();
  for (const p of (dimsJson?.pages ?? []) as Array<Record<string, unknown>>) {
    const page = Number(p.pageNumber ?? p.page);
    const legs: DimensionLeg[] = [];
    for (const d of (p.dimensions ?? []) as Array<Record<string, unknown>>) {
      const attach = d.attach as { from: { x: number; y: number }; to: { x: number; y: number } } | undefined;
      if (!attach) continue;
      const mm = d.lengthMm ?? d.mm ?? null;
      legs.push({
        cell: String(d.cell),
        mm: typeof mm === "number" ? mm : mm != null && String(mm).trim() !== "" ? Number(mm) : null,
        from: attach.from,
        to: attach.to,
        degrees: Number(d.degrees ?? 0),
      });
    }
    legsByPage.set(page, legs);
  }

  const count = await readPageCount(pdf);
  const pages = pagesArg ? pagesArg.split(",").map(Number) : Array.from({ length: count }, (_, i) => i + 1);

  const out: Array<Record<string, unknown>> = [];
  const previewRegions: Array<{ page: number; regions: ContactSheetRegion[] }> = [];

  for (const page of pages) {
    const { balloons } = await readItemBalloons(pdf, page);
    const items = itemsByPage.get(page) ?? [];

    // The contact sheet holds EVERY balloon on the page, not just the ones
    // already believed to be supports -- the number inside is the only thing
    // that says which they are, so leaving any out makes the read circular.
    previewRegions.push({
      page,
      regions: balloons.map((b, i) => ({ label: `${page}-${i + 1}`, bbox: b.box })),
    });

    const supports = pipeSupportsOf(balloons, labels, items, page);
    const check = supportCountCheck(supports, items);
    console.log(
      `page ${page}: ${balloons.length} balloons, ${supports.length} of them supports` +
        (items.length === 0
          ? " -- the BOM lists no supports on this sheet"
          : check.complete
            ? `  (matches the BOM's ${check.expected})`
            : `  BOM SAYS ${check.expected}: ${check.perItem.map((p) => `item ${p.itemNo} ${p.found}/${p.expected}`).join(", ")}`)
    );

    // READ THE SUPPORTS THROUGH FIRST. Spans are withheld entirely unless
    // every support the BOM calls for was located -- see the gate's own
    // comment for why a missed support is worse than a missing span.
    const { spans, withheld } = supportSpansWhenComplete(legsByPage.get(page) ?? [], supports, check);
    if (withheld) console.log(`    no spans: ${withheld}`);
    for (const sp of spans)
      console.log(
        `    ${sp.kind === "run-end" ? "[run end] " : ""}${sp.fromCell} -> ${sp.toCell}: ${sp.mm != null ? `${sp.mm}mm` : "length not read"}` +
          `  via ${sp.legs.join(" + ")}  ${sp.turns} turn${sp.turns === 1 ? "" : "s"}` +
          (sp.verticalLegMm != null ? `  vertical leg ${sp.verticalLegMm}mm` : "")
      );

    out.push({
      page,
      balloons: balloons.length,
      expected: check.expected,
      complete: check.complete,
      perItem: check.perItem,
      supports: supports.map((s) => ({
        cell: s.cell,
        itemNo: s.itemNo,
        description: s.description,
        typeCode: s.typeCode,
        role: s.role,
        at: s.at,
        offRunPt: Number(s.offRunPt.toFixed(2)),
        box: s.box,
      })),
      spans,
      spansWithheld: withheld,
    });
  }

  if (previewPath) {
    for (const { page, regions } of previewRegions) {
      if (regions.length === 0) continue;
      // Raw base64, not a data: URL -- renderRegionContactSheet returns the
      // payload the API expects, which has no "data:image/png;base64," prefix.
      const png = await renderRegionContactSheet(pdf, page, regions);
      if (!png) continue;
      const target = previewPath.replace(/(\.png)?$/i, `-p${page}.png`);
      writeFileSync(target, Buffer.from(png, "base64"));
      console.log(`  preview -> ${target} (${regions.length} cells)`);
    }
  }

  if (outPath) {
    writeFileSync(outPath, JSON.stringify({ pdf, pages: out }, null, 2));
    console.log(`\nwrote ${outPath}`);
  }
  if (!labelsPath) {
    console.log("\nNo --labels-from given, so no balloon numbers were read and nothing is a support yet.");
    console.log("Read the preview and write {\"1-8\": \"18\", ...}, then re-run with --labels-from.");
  }
}

void main();
