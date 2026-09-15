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
import { renderRegionContactSheet } from "../src/pdfImages";

function loadApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const text = readFileSync(resolve(__dirname, "../.env"), "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith("ANTHROPIC_API_KEY="));
  if (!line) throw new Error("ANTHROPIC_API_KEY not found");
  return line.slice("ANTHROPIC_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

async function readLabels(buf: Buffer, page: number, boxes: Array<{ x0: number; y0: number; x1: number; y1: number }>) {
  const png = await renderRegionContactSheet(buf, page, boxes.map((b, i) => ({ label: String(i + 1), bbox: b })));
  if (!png) return new Map<number, string>();
  const client = new Anthropic({ apiKey: loadApiKey() });
  const message = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 3000,
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
              `Each box is one weld's number flag cut from an isometric drawing; the cell number is printed under it as "#1", "#2" and so on.\n` +
              `Read the label inside every hexagon exactly as printed, keeping the letter prefix (BW buttweld, FW field weld, TW tapweld, TH threaded, SW socketweld).\n` +
              `There are ${boxes.length} cells; return ${boxes.length} entries in cell order. Stray line fragments clipping into a box are not part of the label.`,
          },
        ],
      },
    ],
  });
  const block = message.content.find((b) => b.type === "tool_use");
  const out = new Map<number, string>();
  if (block && block.type === "tool_use") {
    for (const f of (block.input as { flags?: Array<{ cell: number; label: string }> }).flags ?? []) out.set(f.cell - 1, f.label);
  }
  const u = message.usage;
  console.log(`   page ${page}: read ${out.size} labels  (${u.input_tokens} in / ${u.output_tokens} out, ~$${((u.input_tokens / 1e6) * 15 + (u.output_tokens / 1e6) * 75).toFixed(3)})`);
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

  const pages = [];
  for (const page of [1, 2, 3, 4, 5]) {
    const marks = await readWeldMarks(buf, page);
    const labels = labelPages.includes(page) ? await readLabels(buf, page, marks.hits.map((h) => h.flagBox)) : new Map<number, string>();
    const numberOf = (i: number) => Number(String(labels.get(i) ?? "").replace(/^[A-Za-z]+/, ""));
    const run = labels.size ? await readRunOrder(buf, page, marks, numberOf) : await readRunOrder(buf, page, marks);
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
        label: labels.get(i) ?? null,
        weldNo: Number.isFinite(numberOf(i)) ? numberOf(i) : null,
        mark: { x: Number(h.mark.x.toFixed(1)), y: Number(h.mark.y.toFixed(1)) },
        markFraction: { x: Number((h.mark.x / marks.width).toFixed(4)), y: Number((h.mark.y / marks.height).toFixed(4)) },
        flag: { x: Number(h.flag.x.toFixed(1)), y: Number(h.flag.y.toFixed(1)) },
        fitPt: Number(h.markDistance.toFixed(1)),
        runOrder: orderOf.has(i) ? (orderOf.get(i) as number) + 1 : null,
        comesAfterLabel: afterOf.get(i) != null ? (labels.get(afterOf.get(i) as number) ?? null) : null,
        onBranch: branchOf.get(i) ?? null,
      })),
    });
    console.log(
      `page ${page}: ${marks.hits.length}/${marks.flagCount} located, ${run.welds.length} ordered${labels.size ? `, ${labels.size} labelled` : ""}`
    );
  }

  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), pages }, null, 2));
  const total = pages.reduce((s, p) => s + p.welds.length, 0);
  const flags = pages.reduce((s, p) => s + p.flagCount, 0);
  console.log(`\nwrote ${outPath}: ${total} located welds out of ${flags} flags`);
}

main();
