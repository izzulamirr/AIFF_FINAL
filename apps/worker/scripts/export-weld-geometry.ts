// Runs the geometry pipeline over an ISO and writes what it found to a JSON
// file, ready to be loaded into the database by
// packages/db/scripts/import-weld-geometry.mjs.
//
//   pnpm --filter @easy/worker exec tsx scripts/export-weld-geometry.ts <file.pdf> <out.json> [--read-labels 2,3]
//
// Everything except --read-labels is local and free. --read-labels sends one
// small contact sheet per named page to put a weld NUMBER against each position;
// without it the positions are still exported, just unnamed.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ISO_WELD_FLAGS_TOOL, buildSystemPrompt } from "@easy/extraction-schemas";
import { readWeldMarks } from "../src/extraction/isoWeldMarks";
import { readRunOrder } from "../src/extraction/isoRunOrder";
import { renderMultiPageContactSheet } from "../src/pdfImages";

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
  byPage: Array<{ pageNumber: number; boxes: Array<{ x0: number; y0: number; x1: number; y1: number }> }>
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const png = await renderMultiPageContactSheet(
    buf,
    byPage.map(({ pageNumber, boxes }) => ({
      pageNumber,
      regions: boxes.map((b, i) => ({ label: `${pageNumber}-${i + 1}`, bbox: b })),
    }))
  );
  if (!png) return out;
  const cellCount = byPage.reduce((n, p) => n + p.boxes.length, 0);
  console.log(`   contact sheet: ${cellCount} flags from pages ${byPage.map((p) => p.pageNumber).join(", ")} in one image`);

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
              `Each box is one weld's number flag cut from an isometric drawing. The cell label is printed under each box as "#2-1", "#2-2" and so on -- the first part is the drawing sheet it came from, the second its position in this grid.
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
  const buf = readFileSync(pdfPath);

  // Locate every sheet's welds first (free), then read all the wanted pages'
  // flags in a single call.
  const located = [];
  for (const page of [1, 2, 3, 4, 5]) {
    located.push({ page, marks: await readWeldMarks(buf, page) });
  }
  const labels = labelPages.length
    ? await readLabels(
        buf,
        located.filter((l) => labelPages.includes(l.page)).map((l) => ({ pageNumber: l.page, boxes: l.marks.hits.map((h) => h.flagBox) }))
      )
    : new Map<string, string>();

  const pages = [];
  for (const { page, marks } of located) {
    const labelAt = (i: number) => labels.get(`${page}-${i + 1}`);
    const numberOf = (i: number) => Number(String(labelAt(i) ?? "").replace(/^[A-Za-z]+/, ""));
    const sheetLabelled = marks.hits.some((_, i) => labelAt(i) != null);
    const run = sheetLabelled ? await readRunOrder(buf, page, marks, numberOf) : await readRunOrder(buf, page, marks);
    const orderOf = new Map(run.welds.map((w, i) => [w.hitIndex, i]));
    const afterOf = new Map(run.welds.map((w) => [w.hitIndex, w.comesAfter]));
    const branchOf = new Map(run.welds.map((w) => [w.hitIndex, w.onBranch]));

    pages.push({
      page,
      width: marks.width,
      height: marks.height,
      flagCount: marks.flagCount,
      untraced: marks.untraced.length,
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
    console.log(`page ${page}: ${marks.hits.length}/${marks.flagCount} located, ${run.welds.length} ordered${n ? `, ${n} labelled` : ""}`);
  }

  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), pages }, null, 2));
  const total = pages.reduce((s, p) => s + p.welds.length, 0);
  const flags = pages.reduce((s, p) => s + p.flagCount, 0);
  console.log(`\nwrote ${outPath}: ${total} located welds out of ${flags} flags`);
}

main();
