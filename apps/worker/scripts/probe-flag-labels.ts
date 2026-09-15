// End to end: find every weld flag on a sheet by geometry, cut them into one
// contact sheet, read the numbers off it, and check the result against the set
// of welds the sheet should have.
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-flag-labels.ts <file.pdf> <page> [expectedCount]
//
// Cheap by construction: the image is a grid of isolated labels, not a drawing,
// so it costs a fraction of a whole-sheet call. Thinking is off -- this is
// reading, not reasoning.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ISO_WELD_FLAGS_TOOL, buildSystemPrompt } from "@easy/extraction-schemas";
import { readWeldMarks } from "../src/extraction/isoWeldMarks";
import { renderRegionContactSheet } from "../src/pdfImages";

const INPUT_PER_M = 15;
const OUTPUT_PER_M = 75;

function loadApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const text = readFileSync(resolve(__dirname, "../.env"), "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith("ANTHROPIC_API_KEY="));
  if (!line) throw new Error("ANTHROPIC_API_KEY not found");
  return line.slice("ANTHROPIC_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

async function main() {
  const [, , pdfPath, pageArg, expectedArg] = process.argv;
  if (!pdfPath || !pageArg) {
    console.error("usage: tsx scripts/probe-flag-labels.ts <file.pdf> <page> [expectedCount]");
    process.exit(1);
  }
  const page = Number(pageArg);
  const buf = readFileSync(pdfPath);

  const marks = await readWeldMarks(buf, page);
  const regions = [
    ...marks.hits.map((h) => ({ box: h.flagBox, mark: h.mark as { x: number; y: number } | null })),
    ...marks.untraced.map((u) => ({ box: { x0: u.x - 27, y0: u.y - 8, x1: u.x + 27, y1: u.y + 8 }, mark: null })),
  ].sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);

  const png = await renderRegionContactSheet(
    buf,
    page,
    regions.map((r, i) => ({ label: String(i + 1), bbox: r.box }))
  );
  if (!png) {
    console.log("no flags found");
    return;
  }
  const kb = (Buffer.from(png, "base64").length / 1024).toFixed(0);
  console.log(`page ${page}: ${regions.length} flags found by geometry, contact sheet ${kb}kb`);

  const client = new Anthropic({ apiKey: loadApiKey() });
  const message = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4000,
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
              `Each box in this image is one weld's number flag, cut from an isometric drawing. The cell number is printed under each box as "#1", "#2" and so on.\n\n` +
              `Read the label inside every hexagon, exactly as printed -- keep the letter prefix, which gives the weld type: BW buttweld, FW field weld, TW tapweld, TH threaded, SW socketweld.\n\n` +
              `There are ${regions.length} cells. Return ${regions.length} entries, one per cell, in cell order. Do not skip a cell and do not merge two. ` +
              `Stray line fragments from the drawing may clip into a box -- ignore them; only the text inside the hexagon matters.`,
          },
        ],
      },
    ],
  });

  const block = message.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    console.log("no tool call returned");
    return;
  }
  const flags = ((block.input as { flags?: Array<{ cell: number | string; label: string }> }).flags ?? []).slice().map((f) => ({ ...f, cell: Number(f.cell) })).sort((a, b) => a.cell - b.cell);

  console.log(`\ncell -> label -> weld mark position:`);
  const numbers: number[] = [];
  for (const f of flags) {
    const r = regions[f.cell - 1];
    const m = r?.mark;
    const n = Number(String(f.label).replace(/^[A-Za-z]+/, ""));
    if (Number.isFinite(n)) numbers.push(n);
    console.log(
      `  #${String(f.cell).padStart(2)}  ${String(f.label).padEnd(6)}` +
        (m ? `  weld mark (${m.x.toFixed(0)},${m.y.toFixed(0)})  frac (${(m.x / marks.width).toFixed(3)},${(m.y / marks.height).toFixed(3)})` : `  [leader untraced]`)
    );
  }

  const expected = expectedArg ? Number(expectedArg) : regions.length;
  const sorted = [...numbers].sort((a, b) => a - b);
  const missing: number[] = [];
  for (let i = 1; i <= expected; i++) if (!sorted.includes(i)) missing.push(i);
  const dupes = sorted.filter((n, i) => sorted.indexOf(n) !== i);
  console.log(`\nread ${flags.length} labels for ${regions.length} cells`);
  console.log(`weld numbers: ${sorted.join(", ")}`);
  console.log(missing.length === 0 && dupes.length === 0 ? `=> COMPLETE AND UNIQUE 1..${expected}` : `=> missing ${missing.join(",") || "none"}; duplicated ${dupes.join(",") || "none"}`);
  const placed = flags.filter((f) => regions[f.cell - 1]?.mark).length;
  console.log(`weld numbers tied to a position on the drawing: ${placed}/${flags.length}`);

  const u = message.usage;
  console.log(`\ntokens: ${u.input_tokens.toLocaleString()} in / ${u.output_tokens.toLocaleString()} out  ~$${((u.input_tokens / 1e6) * INPUT_PER_M + (u.output_tokens / 1e6) * OUTPUT_PER_M).toFixed(3)}`);
}

main();
