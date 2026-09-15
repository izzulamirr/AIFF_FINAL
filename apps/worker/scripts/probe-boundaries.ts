// Runs ONLY the spool-boundary pass against chosen pages of a PDF, and prints
// what it found plus what the call actually cost. Nothing is written to the
// database.
//
// This is the cheap half of ISO extraction: one call per sheet instead of two,
// and a small answer instead of a full BOM. Use it to measure whether the model
// finds a sheet's valves before committing to a full run.
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-boundaries.ts <file.pdf> <page...>
//
// Needs ANTHROPIC_API_KEY (read from apps/worker/.env like the worker does).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ISO_SPOOL_BOUNDARIES_TOOL, buildSystemPrompt } from "@easy/extraction-schemas";
import { renderPdfPages, renderPdfPageTiles } from "../src/pdfImages";
import { buildSpoolBoundaryPrompt, buildSheetImageNote } from "../src/extraction/iso";

// Opus list pricing, USD per million tokens. Only used to print an estimate.
const INPUT_PER_M = 15;
const OUTPUT_PER_M = 75;

function loadApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const text = readFileSync(resolve(__dirname, "../.env"), "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith("ANTHROPIC_API_KEY="));
  if (!line) throw new Error("ANTHROPIC_API_KEY not found in env or apps/worker/.env");
  return line.slice("ANTHROPIC_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

async function main() {
  const [, , pdfPath, ...pageArgs] = process.argv;
  if (!pdfPath || pageArgs.length === 0) {
    console.error("usage: tsx scripts/probe-boundaries.ts <file.pdf> <page...>");
    process.exit(1);
  }
  const pages = pageArgs.map(Number).filter(Number.isFinite);
  const buf = readFileSync(pdfPath);
  const client = new Anthropic({ apiKey: loadApiKey() });
  const systemPrompt = buildSystemPrompt("piping isometric drawing");

  let totalIn = 0;
  let totalOut = 0;

  for (const page of pages) {
    const [whole] = await renderPdfPages(buf, [page]);
    const tiles = await renderPdfPageTiles(buf, [page]);
    const images = [...(whole ? [whole.pngBase64] : []), ...tiles.map((t) => t.pngBase64)];

    const stream = client.messages.stream({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: systemPrompt,
      tools: [ISO_SPOOL_BOUNDARIES_TOOL],
      tool_choice: { type: "tool", name: ISO_SPOOL_BOUNDARIES_TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            ...images.map((data) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data } })),
            {
              type: "text" as const,
              text: buildSpoolBoundaryPrompt({
                pageNumber: page,
                imageNote: buildSheetImageNote(tiles.length, tiles[0]?.cols, tiles[0]?.rows),
              }),
            },
          ],
        },
      ],
    });

    const message = await stream.finalMessage();
    const block = message.content.find((b) => b.type === "tool_use");
    const usage = message.usage;
    totalIn += usage.input_tokens;
    totalOut += usage.output_tokens;

    console.log(`\n${"=".repeat(70)}\nPAGE ${page}\n${"=".repeat(70)}`);
    if (!block || block.type !== "tool_use") {
      console.log("no tool call returned");
      continue;
    }
    const r = block.input as {
      line_size?: string;
      spool_tags?: string[];
      valves?: Array<Record<string, unknown>>;
      field_welds?: Array<Record<string, unknown>>;
    };

    console.log(`line size: ${r.line_size ?? "?"}`);
    console.log(`spool tags (${(r.spool_tags ?? []).length}): ${(r.spool_tags ?? []).join(", ") || "(none)"}`);

    const valves = r.valves ?? [];
    console.log(`\nvalves found: ${valves.length}`);
    for (const v of valves) {
      const flags = [
        v.on_main_run ? "main-run" : "branch",
        v.flanged_both_sides ? "flanged-both" : "not-flanged-both",
        v.pipe_continues_past ? "continues" : "terminates",
      ].join(" / ");
      console.log(
        `  ${v.is_boundary ? "BOUNDARY" : "        "}  ${String(v.size ?? "?").padEnd(6)} ${String(v.description ?? "").slice(0, 44).padEnd(44)}` +
          ` after weld ${String(v.nearest_upstream_weld ?? "?").padEnd(4)} [${flags}]`
      );
      if (v.location_note) console.log(`            ${String(v.location_note).slice(0, 110)}`);
    }

    const fws = r.field_welds ?? [];
    console.log(`\nfield welds found: ${fws.length}`);
    for (const f of fws) console.log(`  weld ${f.weld_no} -- ${String(f.evidence ?? "").slice(0, 90)}`);

    const boundaryWelds = [
      ...valves.filter((v) => v.is_boundary).map((v) => Number(v.nearest_upstream_weld)),
      ...fws.map((f) => Number(f.weld_no)),
    ]
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const expected = (r.spool_tags ?? []).length > 0 ? (r.spool_tags ?? []).length - 1 : null;
    console.log(
      `\n=> boundaries after welds: ${boundaryWelds.join(", ") || "(none)"}` +
        (expected != null ? `   (${boundaryWelds.length} found, ${expected} expected from ${expected + 1} printed spool tags)` : "")
    );
    console.log(`   tokens: ${usage.input_tokens.toLocaleString()} in / ${usage.output_tokens.toLocaleString()} out`);
  }

  const cost = (totalIn / 1e6) * INPUT_PER_M + (totalOut / 1e6) * OUTPUT_PER_M;
  console.log(
    `\n${"-".repeat(70)}\nTOTAL ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out` +
      `  ~$${cost.toFixed(2)} at $${INPUT_PER_M}/$${OUTPUT_PER_M} per Mtok`
  );
}

main();
