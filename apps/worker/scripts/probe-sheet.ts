// Runs ONLY the sheet pass (pass 2) against one page, with a pass-1 boundary
// result supplied from a JSON file instead of being re-extracted. Nothing is
// written to the database.
//
// The point is to measure the half that pass 1 cannot do for itself: given the
// boundary valves by name, does the sheet pass put them at the right welds?
// Reusing a saved pass-1 answer means that question can be asked without paying
// for the locating pass again.
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-sheet.ts <file.pdf> <page> <pass1.json>
//
// <pass1.json> is a locate_iso_spool_boundaries result: { line_size, spool_tags,
// valves, field_welds }.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ISO_SHEET_TOOL, buildSystemPrompt } from "@easy/extraction-schemas";
import { buildSpoolsFromWeldTopology } from "@easy/shared";
import { renderPdfPages, renderPdfPageTiles } from "../src/pdfImages";
import {
  buildIsoSheetPrompt,
  buildBoundaryNote,
  locatedBoundariesOf,
  resolveBoundaryWelds,
  buildWeldTopology,
  readSpoolTags,
  spoolProblems,
} from "../src/extraction/iso";

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
  const [, , pdfPath, pageArg, pass1Path] = process.argv;
  if (!pdfPath || !pageArg || !pass1Path) {
    console.error("usage: tsx scripts/probe-sheet.ts <file.pdf> <page> <pass1.json>");
    process.exit(1);
  }
  const page = Number(pageArg);
  const pass1 = JSON.parse(readFileSync(pass1Path, "utf8"));

  const buf = readFileSync(pdfPath);
  const [whole] = await renderPdfPages(buf, [page]);
  const tiles = await renderPdfPageTiles(buf, [page]);
  const images = [...(whole ? [whole.pngBase64] : []), ...tiles.map((t) => t.pngBase64)];

  const { located, weldNumbersUsable } = locatedBoundariesOf(pass1);
  const boundaryNote = buildBoundaryNote(pass1, located, weldNumbersUsable);
  console.log(`pass 1 weld numbers usable: ${weldNumbersUsable}`);
  console.log(`--- boundary note handed to the sheet pass ---${boundaryNote}\n${"=".repeat(70)}`);

  const client = new Anthropic({ apiKey: loadApiKey() });
  const stream = client.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    system: buildSystemPrompt("piping isometric drawing"),
    tools: [ISO_SHEET_TOOL],
    tool_choice: { type: "tool", name: ISO_SHEET_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          ...images.map((data) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data } })),
          {
            type: "text" as const,
            text: buildIsoSheetPrompt({
              sheetText: "",
              pageNumber: page,
              tileCount: tiles.length,
              tileCols: tiles[0]?.cols,
              tileRows: tiles[0]?.rows,
              boundaryNote,
              retryNote: "",
            }),
          },
        ],
      },
    ],
  });

  const message = await stream.finalMessage();
  const block = message.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    console.log("no tool call returned");
    return;
  }
  const r = block.input as Parameters<typeof spoolProblems>[0];

  const welds = (r.welds ?? []) as NonNullable<typeof r.welds>;
  console.log(`\nwelds read: ${welds.length}`);
  console.log(
    "  " +
      welds
        .map((w) => `${w.weld_no}:${w.weld_type ?? "?"}/${w.size ?? "?"}<-${w.comes_after_weld || "-"}${w.closes_spool ? "*" : ""}`)
        .join("  ")
  );

  console.log(`\nspool_boundaries returned:`);
  for (const b of r.spool_boundaries ?? []) console.log(`  after weld ${b.after_weld} (${b.boundary_type}) -- ${String(b.evidence ?? "").slice(0, 90)}`);

  const problems = spoolProblems(r);
  console.log(`\nchecks: ${problems.length === 0 ? "clean" : `${problems.length} problem(s)`}`);
  for (const p of problems) console.log(`  - ${p.slice(0, 160)}`);

  const boundaryWelds = resolveBoundaryWelds(welds, r.spool_boundaries);
  const { spools } = buildSpoolsFromWeldTopology(buildWeldTopology(welds, boundaryWelds), readSpoolTags(r.spool_tags));
  console.log(`\nresolved spools:`);
  for (const s of spools) console.log(`  ${s.spoolTag.padEnd(36)} ${s.weldNumbers.join(",")}`);

  const usage = message.usage;
  const cost = (usage.input_tokens / 1e6) * INPUT_PER_M + (usage.output_tokens / 1e6) * OUTPUT_PER_M;
  console.log(`\ntokens: ${usage.input_tokens.toLocaleString()} in / ${usage.output_tokens.toLocaleString()} out  ~$${cost.toFixed(2)}`);
}

main();
