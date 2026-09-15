// Asks ONE question: given a sheet's weld list and the valves that break it,
// which weld does each valve sit immediately after?
//
// This isolates the step that has been getting the boundary one weld early. It
// is far cheaper than a full sheet pass because the weld list is supplied
// rather than re-read, so the answer is a handful of numbers instead of a whole
// BOM. Diagnostic only -- nothing is written to the database.
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-placement.ts <file.pdf> <page> <input.json>
//
// <input.json>: { welds: [{weld_no, weld_type, size}], valves: [{description, location_note}],
//                 expected?: [number] }

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, type ClaudeTool } from "@easy/extraction-schemas";
import { renderPdfPages, renderPdfPageTiles } from "../src/pdfImages";
import { buildSheetImageNote } from "../src/extraction/iso";

const INPUT_PER_M = 15;
const OUTPUT_PER_M = 75;

const PLACE_TOOL: ClaudeTool = {
  name: "place_spool_boundaries",
  description: "Says which weld each spool boundary on an isometric sheet sits immediately after.",
  input_schema: {
    type: "object",
    properties: {
      boundaries: {
        type: "array",
        description: "One entry per valve given, in the same order.",
        items: {
          type: "object",
          properties: {
            valve: { type: "string", description: "Which of the listed valves this is, by its number in the list." },
            after_weld: {
              type: "string",
              description:
                "The ID of the weld joining the pipe to this valve's UPSTREAM flange -- the very last weld mark you pass walking the main run toward the valve, not the one before it. Bare number.",
            },
            downstream_weld: {
              type: "string",
              description: "The ID of the weld on the valve's DOWNSTREAM flange -- the first weld of the next spool. Recording both is what makes the pair unambiguous.",
            },
            reasoning: { type: "string", description: "What you actually see between those two welds on the drawing." },
          },
          required: ["valve", "after_weld"],
        },
      },
    },
    required: ["boundaries"],
  },
};

function loadApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const text = readFileSync(resolve(__dirname, "../.env"), "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith("ANTHROPIC_API_KEY="));
  if (!line) throw new Error("ANTHROPIC_API_KEY not found");
  return line.slice("ANTHROPIC_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

async function main() {
  const [, , pdfPath, pageArg, inputPath] = process.argv;
  if (!pdfPath || !pageArg || !inputPath) {
    console.error("usage: tsx scripts/probe-placement.ts <file.pdf> <page> <input.json>");
    process.exit(1);
  }
  const page = Number(pageArg);
  const input = JSON.parse(readFileSync(inputPath, "utf8")) as {
    welds: Array<{ weld_no: string; weld_type?: string; size?: string }>;
    valves: Array<{ description?: string; location_note?: string }>;
    main_run_welds?: number[];
    expected?: number[];
  };

  const buf = readFileSync(pdfPath);
  const [whole] = await renderPdfPages(buf, [page]);
  const tiles = await renderPdfPageTiles(buf, [page]);
  const images = [...(whole ? [whole.pngBase64] : []), ...tiles.map((t) => t.pngBase64)];

  const weldTable = input.welds.map((w) => `${w.weld_no} (${w.weld_type ?? "?"}, ${w.size ?? "?"}mm)`).join("   ");
  const valveList = input.valves.map((v, i) => `  ${i + 1}. ${v.description ?? ""}\n     ${v.location_note ?? ""}`).join("\n");

  // Branch welds are numbered in among the run's own, so the two welds either
  // side of a main-run valve are frequently NOT consecutive numbers. Spelling
  // the run's own sequence out is what stops that assumption being made.
  const mainRun = input.main_run_welds ?? [];
  const branch = input.welds.map((w) => Number(w.weld_no)).filter((n) => mainRun.length > 0 && !mainRun.includes(n));
  const runNote = mainRun.length
    ? `\nOf those, the MAIN RUN passes through these welds, in this order along the pipe:\n  ${mainRun.join(" -> ")}\n` +
      `The rest are on BRANCHES that leave the run and dead-end: ${branch.join(", ")}. They are numbered in among the run's own welds, which is why the two welds either side of a main-run valve are OFTEN NOT CONSECUTIVE NUMBERS -- for example weld ${mainRun[3] ?? "4"} followed by weld ${mainRun[4] ?? "7"}, with the numbers between them belonging to a branch. ` +
      `Both welds either side of a main-run valve must come from the main run list, and must be NEXT TO EACH OTHER IN THAT LIST.\n`
    : "";

  const client = new Anthropic({ apiKey: loadApiKey() });
  const stream = client.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    system: buildSystemPrompt("piping isometric drawing"),
    tools: [PLACE_TOOL],
    tool_choice: { type: "tool", name: PLACE_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          ...images.map((data) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data } })),
          {
            type: "text" as const,
            text:
              `This is page ${page} of an isometric drawing. ${buildSheetImageNote(tiles.length, tiles[0]?.cols, tiles[0]?.rows)}\n\n` +
              `These welds are marked on this sheet (ID, type, bore):\n${weldTable}\n${runNote}\n` +
              `These valves break the sheet into pipe spools:\n${valveList}\n\n` +
              `ONE QUESTION ONLY: for each valve, which weld does it sit immediately after?\n\n` +
              `A flanged valve is drawn on an isometric like this, along the pipe:\n` +
              `      ... pipe --- WELD --- flange ][ VALVE ][ flange --- WELD --- pipe ...\n` +
              `There is a weld on EACH side of it. The one you want is the FIRST -- the weld joining the pipe to the valve's upstream flange. It is the last weld of the spool that ends at this valve. ` +
              `The weld on the far side belongs to the NEXT spool.\n\n` +
              `So: find the valve symbol on the tiles, then walk backwards along the MAIN RUN and take the VERY FIRST weld mark you meet. That is after_weld. Do not skip past it to the one before -- that weld is in the middle of the spool, not at its end. ` +
              `Do NOT assume after_weld and downstream_weld are consecutive numbers: check the main run list above and take two entries that are neighbours IN IT. ` +
              `Record the far-side weld in downstream_weld as well, so the pair is unambiguous: after_weld and downstream_weld are the two welds either side of the same valve, with nothing but the valve and its two flanges between them.\n\n` +
              `Read the weld numbers off the drawing's own labels (a flag marked "BW12" is weld 12). Every valve is at its own place on the run, so no two can share an after_weld.`,
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
  const r = block.input as { boundaries?: Array<Record<string, string>> };
  const got: number[] = [];

  console.log("");
  for (const b of r.boundaries ?? []) {
    got.push(Number(b.after_weld));
    console.log(`valve ${b.valve}: after weld ${b.after_weld}  (downstream ${b.downstream_weld ?? "?"})`);
    if (b.reasoning) console.log(`   ${b.reasoning.slice(0, 140)}`);
  }

  const sorted = [...got].filter(Number.isFinite).sort((a, b) => a - b);
  console.log(`\nboundaries after welds: ${sorted.join(", ")}`);
  if (input.expected) {
    const want = [...input.expected].sort((a, b) => a - b);
    const hits = want.filter((n) => sorted.includes(n));
    console.log(`drawing has:            ${want.join(", ")}`);
    console.log(`=> ${hits.length}/${want.length} correct`);
  }

  const usage = message.usage;
  const cost = (usage.input_tokens / 1e6) * INPUT_PER_M + (usage.output_tokens / 1e6) * OUTPUT_PER_M;
  console.log(`\ntokens: ${usage.input_tokens.toLocaleString()} in / ${usage.output_tokens.toLocaleString()} out  ~$${cost.toFixed(2)}`);
}

main();
