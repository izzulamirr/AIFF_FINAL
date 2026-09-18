// Runs the geometry pipeline over an ISO and writes what it found to a JSON
// file, ready to be loaded into the database by
// packages/db/scripts/import-weld-geometry.mjs.
//
//   pnpm --filter @easy/worker exec tsx scripts/export-weld-geometry.ts <file.pdf> <out.json> [--read-labels 2,3] [--preview sheet.png] [--labels-from labels.json] [--bores weld-list.json]
//
// --preview renders the exact contact sheet the call WOULD send and writes it to
// disk instead, so a broken render is found for nothing. --labels-from supplies
// the readings from a JSON file of {"2-1": "BW7", ...} rather than asking for
// them, which is how a hand-checked or already-paid-for read is replayed.
//
// Everything except --read-labels is local and free. --read-labels sends one
// small contact sheet per named page to put a weld NUMBER against each position;
// without it the positions are still exported, just unnamed.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ISO_WELD_FLAGS_TOOL, buildSystemPrompt } from "@easy/extraction-schemas";
import { readWeldMarks, type WeldMarkResult } from "../src/extraction/isoWeldMarks";
import { readRunOrder } from "../src/extraction/isoRunOrder";
import { renderMultiPageContactSheet } from "../src/pdfImages";

type FlagRegion = { label: string; bbox: { x0: number; y0: number; x1: number; y1: number } };

// EVERY flag on a wanted page goes on the contact sheet, including the few whose
// leader was never traced. Reading a number does not depend on having followed
// its leader, and the numbers coming back as a complete 1..N set with no repeat
// is the self-check that the read is right -- a check that only works if no flag
// was left off. An untraced flag has no box of its own recorded, so one is cut
// around its centre at the height every flag is drawn to.
function regionsFor(page: number, marks: WeldMarkResult): FlagRegion[] {
  return [
    ...marks.hits.map((h, i) => ({ label: `${page}-${i + 1}`, bbox: h.flagBox })),
    ...marks.untraced.map((u, j) => ({
      label: `${page}-u${j + 1}`,
      bbox: { x0: u.x - 27, y0: u.y - 8, x1: u.x + 27, y1: u.y + 8 },
    })),
  ];
}

// A misread almost always shows up as a gap or a duplicate, so say plainly
// whether this page's numbers came back complete rather than leaving a reviewer
// to count them.
function reportCompleteness(page: number, regions: FlagRegion[], labels: Map<string, string>) {
  const read = regions.map((r) => labels.get(r.label)).filter((v): v is string => v != null && v.trim() !== "");
  const nums = read.map((s) => Number(s.replace(/^[A-Za-z]+/, ""))).filter((n) => Number.isFinite(n) && n > 0);
  const distinct = new Set(nums);
  const highest = nums.length ? Math.max(...nums) : 0;
  const gaps: number[] = [];
  for (let n = 1; n <= highest; n++) if (!distinct.has(n)) gaps.push(n);
  const complete = gaps.length === 0 && distinct.size === nums.length && highest === regions.length;
  console.log(
    `   page ${page}: ${read.length}/${regions.length} labels read, ${distinct.size} distinct, highest ${highest}` +
      (complete ? "  -- complete and unduplicated" : "") +
      (gaps.length ? `  -- GAPS at ${gaps.join(", ")}` : "") +
      (distinct.size !== nums.length ? "  -- DUPLICATES present" : "")
  );
}

function loadApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const text = readFileSync(resolve(__dirname, "../.env"), "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith("ANTHROPIC_API_KEY="));
  if (!line) throw new Error("ANTHROPIC_API_KEY not found");
  return line.slice("ANTHROPIC_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

// Labels for every named page in ONE call. A whole document's flags fit on a
// single contact sheet, and each cell carries a "page-index" label, so which
// page a reading belongs to comes back with the answer rather than being
// inferred from position. One call instead of one per sheet.
async function readLabels(
  buf: Buffer,
  byPage: Array<{ pageNumber: number; regions: FlagRegion[] }>,
  previewPath?: string
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const png = await renderMultiPageContactSheet(buf, byPage);
  if (!png) return out;
  const cellCount = byPage.reduce((n, p) => n + p.regions.length, 0);
  console.log(`   contact sheet: ${cellCount} flags from pages ${byPage.map((p) => p.pageNumber).join(", ")} in one image`);
  // Look at the sheet before paying for it: this is the exact image the call
  // would send, so a broken render costs nothing to find.
  if (previewPath) {
    writeFileSync(previewPath, Buffer.from(png, "base64"));
    console.log(`   preview written to ${previewPath} -- nothing sent, no cost`);
    return out;
  }

  const client = new Anthropic({ apiKey: loadApiKey() });
  const message = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 8000,
    system: buildSystemPrompt("piping isometric drawing"),
    tools: [ISO_WELD_FLAGS_TOOL],
    tool_choice: { type: "tool", name: ISO_WELD_FLAGS_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
          {
            type: "text",
            text:
              `Each box is one weld's number flag cut from an isometric drawing. The cell label is printed under each box as "#2-1", "#2-7", "#5-3", "#1-u1" and so on -- the first part is the drawing sheet it came from, the rest its position in this grid.
` +
              `Read the label inside every hexagon exactly as printed, keeping the letter prefix (BW buttweld, FW field weld, TW tapweld, TH threaded, SW socketweld).
` +
              `There are ${cellCount} cells; return ${cellCount} entries, giving each cell's printed label in the "cell" field exactly as shown (e.g. "2-1"). Stray line fragments clipping into a box are not part of the weld label.`,
          },
        ],
      },
    ],
  });
  const block = message.content.find((b) => b.type === "tool_use");
  if (block && block.type === "tool_use") {
    for (const f of (block.input as { flags?: Array<{ cell: string | number; label: string }> }).flags ?? []) {
      out.set(String(f.cell).trim(), f.label);
    }
  }
  const u = message.usage;
  console.log(`   read ${out.size} labels  (${u.input_tokens} in / ${u.output_tokens} out, ~$${((u.input_tokens / 1e6) * 15 + (u.output_tokens / 1e6) * 75).toFixed(3)})`);
  return out;
}

async function main() {
  const [, , pdfPath, outPath, ...rest] = process.argv;
  if (!pdfPath || !outPath) {
    console.error("usage: tsx scripts/export-weld-geometry.ts <file.pdf> <out.json> [--read-labels 2,3]");
    process.exit(1);
  }
  const li = rest.indexOf("--read-labels");
  const labelPages = li >= 0 ? (rest[li + 1] ?? "").split(",").map(Number).filter(Boolean) : [];
  const pi = rest.indexOf("--preview");
  const previewPath = pi >= 0 ? rest[pi + 1] : undefined;
  const lfi = rest.indexOf("--labels-from");
  const labelsFrom = lfi >= 0 ? rest[lfi + 1] : undefined;
  // --bores takes the weld list purely for each weld's SIZE, which geometry
  // cannot supply and which stops the walk rooting at a small-bore vent stub.
  const bi = rest.indexOf("--bores");
  const boresPath = bi >= 0 ? rest[bi + 1] : undefined;
  const boreByPage = new Map<number, Map<number, string>>();
  if (boresPath) {
    const list = JSON.parse(readFileSync(boresPath, "utf8")) as { pages: Array<{ page: number; welds: Array<{ weldNo: number; size?: string }> }> };
    for (const bp of list.pages) boreByPage.set(bp.page, new Map(bp.welds.filter((w) => w.size).map((w) => [w.weldNo, String(w.size)])));
  }
  // FORGETTING --bores IS SILENT, AND IT MOVES REAL NUMBERS.
  //
  // Without the weld list the bore guard cannot run, so the walk is free to
  // root at a small-bore vent stub's dead end and orient that whole fragment
  // backwards. It does not fail, it does not warn, and the file it writes
  // looks exactly as trustworthy as a correct one -- the only visible trace
  // is `orientedBy` saying "a drawn flow arrow" on a sheet where the guard
  // would have said otherwise. That cost page 2 its N-04, flipping a
  // hand-verified DOWN 506 to UP 506, and it took an envelope diff to find.
  //
  // The worker never hits this: `readGeometrySpools` has the weld list in
  // hand and always passes the bores. Only this script can be run without it.
  if (!boresPath) {
    console.log(
      `NOTE: no --bores given, so weld SIZES are unknown and the small-bore guard is off.
` +
        `      A sheet whose only open end is a vent or drain stub can then root the walk at
` +
        `      that dead end and report its drop as a rise. Pass --bores <weld-list.json>.`
    );
  }
  const buf = readFileSync(pdfPath);

  // Locate every sheet's welds first (free), then read all the wanted pages'
  // flags in a single call.
  const located = [];
  for (const page of [1, 2, 3, 4, 5]) {
    located.push({ page, marks: await readWeldMarks(buf, page) });
  }
  const wanted = located.filter((l) => labelPages.includes(l.page));
  const labels = labelsFrom
    ? new Map<string, string>(Object.entries(JSON.parse(readFileSync(labelsFrom, "utf8")) as Record<string, string>))
    : labelPages.length
      ? await readLabels(buf, wanted.map((l) => ({ pageNumber: l.page, regions: regionsFor(l.page, l.marks) })), previewPath)
      : new Map<string, string>();
  if (labelsFrom) console.log(`   ${labels.size} labels read from ${labelsFrom} -- no call made`);
  if (previewPath) return;
  for (const l of wanted) reportCompleteness(l.page, regionsFor(l.page, l.marks), labels);

  const pages = [];
  for (const { page, marks } of located) {
    const labelAt = (i: number) => labels.get(`${page}-${i + 1}`);
    const numberOf = (i: number) => Number(String(labelAt(i) ?? "").replace(/^[A-Za-z]+/, ""));
    const sheetLabelled = marks.hits.some((_, i) => labelAt(i) != null);
    const bores = boreByPage.get(page);
    const run = sheetLabelled
      ? await readRunOrder(buf, page, marks, numberOf, bores ? (i: number) => bores.get(numberOf(i)) : undefined)
      : await readRunOrder(buf, page, marks);
    const orderOf = new Map(run.welds.map((w, i) => [w.hitIndex, i]));
    const afterOf = new Map(run.welds.map((w) => [w.hitIndex, w.comesAfter]));
    const branchOf = new Map(run.welds.map((w) => [w.hitIndex, w.onBranch]));

    pages.push({
      page,
      width: marks.width,
      height: marks.height,
      flagCount: marks.flagCount,
      untraced: marks.untraced.length,
      // What decided which end the run starts from, and the arrows that said
      // so. Stored because "the drawing says the flow goes this way" and "the
      // weld numbering was assumed to follow the run" are very different
      // grounds for an ordering, and a reviewer should be able to tell which
      // one they are looking at.
      orientedBy: run.orientedBy,
      // Every run segment pointed the way the pipe TRAVELS. A dimension has no
      // direction of its own, so this is what says whether the leg it brackets
      // is a rise or a drop -- see buildSpoolEnvelopes.
      orientedSegments: run.orientedSegments.map((sg) => ({
        from: { x: Number(sg.from.x.toFixed(1)), y: Number(sg.from.y.toFixed(1)) },
        to: { x: Number(sg.to.x.toFixed(1)), y: Number(sg.to.y.toFixed(1)) },
      })),
      flowArrows: run.flowArrows.map((a) => ({
        at: { x: Number(a.at.x.toFixed(1)), y: Number(a.at.y.toFixed(1)) },
        apex: { x: Number(a.apex.x.toFixed(1)), y: Number(a.apex.y.toFixed(1)) },
        pageAngle: Number((((Math.atan2(a.dir.y, a.dir.x) * 180) / Math.PI + 360) % 360).toFixed(1)),
        onPipePt: Number(a.onPipePt.toFixed(1)),
        alongDeg: Number(a.alongDeg.toFixed(1)),
      })),
      welds: marks.hits.map((h, i) => ({
        label: labelAt(i) ?? null,
        weldNo: Number.isFinite(numberOf(i)) && numberOf(i) > 0 ? numberOf(i) : null,
        mark: { x: Number(h.mark.x.toFixed(1)), y: Number(h.mark.y.toFixed(1)) },
        markFraction: { x: Number((h.mark.x / marks.width).toFixed(4)), y: Number((h.mark.y / marks.height).toFixed(4)) },
        flag: { x: Number(h.flag.x.toFixed(1)), y: Number(h.flag.y.toFixed(1)) },
        fitPt: Number(h.markDistance.toFixed(1)),
        runOrder: orderOf.has(i) ? (orderOf.get(i) as number) + 1 : null,
        comesAfterLabel: afterOf.get(i) != null ? (labelAt(afterOf.get(i) as number) ?? null) : null,
        onBranch: branchOf.get(i) ?? null,
      })),
    });
    const n = marks.hits.filter((_, i) => labelAt(i) != null).length;
    console.log(
      `page ${page}: ${marks.hits.length}/${marks.flagCount} located, ${run.welds.length} ordered${n ? `, ${n} labelled` : ""}` +
        `, oriented by ${run.orientedBy}`
    );
  }

  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), pages }, null, 2));
  const total = pages.reduce((s, p) => s + p.welds.length, 0);
  const flags = pages.reduce((s, p) => s + p.flagCount, 0);
  console.log(`\nwrote ${outPath}: ${total} located welds out of ${flags} flags`);
}

main();
