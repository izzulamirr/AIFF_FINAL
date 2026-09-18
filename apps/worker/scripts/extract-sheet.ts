// Re-read ONE sheet of an ISO, and nothing else.
//
//   pnpm --filter @easy/worker exec tsx scripts/extract-sheet.ts \
//     <file.pdf> <page> <out.json> [--drawing "8\"-22-..."] [--sheet "4 OF 5"] [--check 1,2,3]
//
// PAID: one vision call, the sheet pass, with the page image and its tiles
// attached. It reports the actual cost when it finishes.
//
// Why this exists. A revision usually touches one sheet -- page 4 gained a
// weld, two field welds and a spool tag while the other four were untouched to
// the byte. Re-running the whole document to pick that up costs five sheet
// passes for one sheet's worth of change, and the geometry half is free and
// already tells you WHICH sheet moved (flag counts, cut counts, tag counts).
//
// The boundary pass is not run at all: the cut finder places the boundaries
// off the drawing, so all that is wanted here is the title block, the BOM and
// the WELD LIST -- number, TYPE and bore.
//
// --check takes the weld numbers the geometry found on this sheet (a complete,
// unduplicated 1..N read off the flag contact sheet). The read is scored
// against them and any disagreement is REPORTED, never retried automatically:
// a retry is a second call at the same price, and whether to pay for it is not
// this script's decision.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ISO_SHEET_TOOL, buildSystemPrompt } from "@easy/extraction-schemas";
import { buildIsoSheetPrompt, buildSheetImageNote, weldListProblems } from "../src/extraction/iso";
import { callTool, usage, usageCostUsd, resetUsage } from "../src/extraction/claudeClient";
import { renderPdfPages, renderPdfPageTiles } from "../src/pdfImages";

function loadApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const text = readFileSync(resolve(__dirname, "../.env"), "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith("ANTHROPIC_API_KEY="));
  if (!line) throw new Error("ANTHROPIC_API_KEY not found");
  return line.slice("ANTHROPIC_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const argv = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !String(all[i - 1] ?? "").startsWith("--"));
  const [pdfPath, pageArg, outPath] = argv;
  if (!pdfPath || !pageArg || !outPath) {
    console.error('usage: tsx scripts/extract-sheet.ts <file.pdf> <page> <out.json> [--drawing "..."] [--sheet "4 OF 5"] [--check 1,2,3]');
    process.exit(1);
  }
  const page = Number(pageArg);
  const buf = readFileSync(pdfPath);
  const check = (flag("--check") ?? "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);

  const [rendered] = await renderPdfPages(buf, [page]);
  const tiles = await renderPdfPageTiles(buf, [page]);
  if (!rendered) throw new Error(`could not render page ${page}`);
  const images = [rendered.pngBase64, ...tiles.map((t) => t.pngBase64)];
  console.log(`page ${page}: 1 full image + ${tiles.length} tiles`);

  resetUsage();
  const client = new Anthropic({ apiKey: loadApiKey() });
  const result = await callTool<Record<string, unknown>>(client, {
    tool: ISO_SHEET_TOOL,
    systemPrompt: buildSystemPrompt("piping isometric drawing"),
    userText: buildIsoSheetPrompt({
      sheetText: "",
      drawingNumber: flag("--drawing"),
      sheetLabel: flag("--sheet"),
      pageNumber: page,
      tileCount: tiles.length,
      tileCols: tiles[0]?.cols,
      tileRows: tiles[0]?.rows,
      // The cut finder places the boundaries off the drawing, so none are
      // handed over and none are asked for beyond what the sheet pass records
      // anyway.
      boundaryNote: "",
      retryNote: "",
    }),
    maxTokens: 32000,
    useThinking: true,
    images,
  });

  writeFileSync(outPath, JSON.stringify(result, null, 2));
  const welds = (result.welds ?? []) as Array<{ weld_no: string; weld_type?: string; size?: string }>;
  const bom = (result.bom_items ?? []) as unknown[];
  console.log(`\nwrote ${outPath}`);
  console.log(`  ${welds.length} welds, ${bom.length} BOM rows, spool tags: ${JSON.stringify(result.spool_tags ?? [])}`);
  console.log(`  welds: ${welds.map((w) => `${w.weld_no}${w.weld_type ? `/${w.weld_type}` : ""}`).join(" ")}`);

  if (check.length > 0) {
    const problems = weldListProblems(result as never, check);
    if (problems.length === 0) console.log(`\n  weld list AGREES with the ${check.length} flags the geometry found`);
    else {
      console.log(`\n  WELD LIST DISAGREES with the drawing:`);
      for (const p of problems) console.log(`    - ${p}`);
      console.log(`  Not retried -- a retry is another call at the same price.`);
    }
  }
  console.log(
    `\nACTUAL COST: $${usageCostUsd().toFixed(3)}  (${usage.calls} call, ${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out)`
  );
}
main();
