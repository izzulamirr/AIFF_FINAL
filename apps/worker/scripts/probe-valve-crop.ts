// Asks the flanking-weld question about ONE valve, with one close-up crop
// centred on it, and nothing else in frame.
//
// This is the narrowest form of the question that has been failing. The tile
// grid puts a valve wherever the grid happens to fall, often with its two
// neighbouring weld marks in different tiles or near an edge; a crop centred on
// the valve puts the valve and both marks large and together.
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-valve-crop.ts <file.pdf> <page> <valve.json>
//
// <valve.json>: { x, y, w, h, description, welds: [{weld_no, weld_type, size}],
//                 expected_after?, expected_downstream? }

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, FLOW_DIRECTION_RULE, type ClaudeTool } from "@easy/extraction-schemas";
import { renderPdfPageCrops } from "../src/pdfImages";

const INPUT_PER_M = 15;
const OUTPUT_PER_M = 75;

// Deliberately NOT asked as upstream/downstream. Which side of a valve is
// upstream depends on which way the fluid flows, and a close-up crop does not
// show that -- a real run read the drawing correctly and then filled the two
// fields the wrong way round. The pair is unordered here and ordered in code
// from the weld chain, which does know the run's direction.
const TOOL: ClaudeTool = {
  name: "read_valve_welds",
  description: "Reads the two weld marks either side of one valve on an isometric drawing.",
  input_schema: {
    type: "object",
    properties: {
      weld_one: {
        type: "string",
        description: "ID number of the weld mark on ONE side of the valve, read from its own hexagonal flag. Bare number. Blank if not legible. Either side -- order does not matter.",
      },
      weld_two: {
        type: "string",
        description: "ID number of the weld mark on the OTHER side of the valve, read from its own hexagonal flag. Bare number. Blank if not legible.",
      },
      what_you_see: { type: "string", description: "Briefly, the run of symbols from one weld to the other, in order, saying where each sits in the image." },
      weld_flow_reaches_first: {
        type: "string",
        description: "Of the two welds above, the one the FLOW reaches FIRST -- see the tracing rule in the prompt. This is the one that ends the spool. Blank if the direction cannot be told from this crop.",
      },
    },
    required: ["weld_one", "weld_two"],
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
  const [, , pdfPath, pageArg, valvePath] = process.argv;
  if (!pdfPath || !pageArg || !valvePath) {
    console.error("usage: tsx scripts/probe-valve-crop.ts <file.pdf> <page> <valve.json>");
    process.exit(1);
  }
  const page = Number(pageArg);
  const v = JSON.parse(readFileSync(valvePath, "utf8")) as {
    x: number;
    y: number;
    w: number;
    h: number;
    description?: string;
    welds?: Array<{ weld_no: string; weld_type?: string; size?: string }>;
    expected_after?: number;
    expected_downstream?: number;
  };

  const [crop] = await renderPdfPageCrops(readFileSync(pdfPath), page, [{ label: "valve", x: v.x, y: v.y, w: v.w, h: v.h }]);
  if (!crop) {
    console.log("no crop rendered");
    return;
  }

  const weldTable = (v.welds ?? []).map((w) => `${w.weld_no}(${w.weld_type ?? "?"},${w.size ?? "?"}mm)`).join(" ");

  const client = new Anthropic({ apiKey: loadApiKey() });
  const stream = client.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 2000,
    thinking: { type: "adaptive" },
    system: buildSystemPrompt("piping isometric drawing"),
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: crop.pngBase64 } },
          {
            type: "text",
            text:
              `This is a close-up of one spot on an isometric drawing, centred on a single valve${v.description ? `: ${v.description}` : ""}.\n\n` +
              (weldTable ? `The welds marked on this sheet are: ${weldTable}\n\n` : "") +
              `The valve is the bowtie/hourglass symbol near the middle of the image, with a flange drawn on each side of it (a heavy bar across the pipe).\n\n` +
              `Follow the pipe through it. Going along the run you will pass, in order:\n` +
              `   ... pipe -- a WELD MARK -- flange ][ VALVE ][ flange -- a WELD MARK -- pipe ...\n\n` +
              `A weld mark is a small filled dot on the pipe, with a leader line out to a HEXAGONAL flag -- a six-sided outline with a point at each end -- carrying a label like "BW7", "FW6" or "TH6". The number in that flag is the weld number: "BW7" is weld 7.\n\n` +
              `Do NOT read a weld number off a SQUARE or RECTANGULAR box. Those are BOM item balloons -- "[2]", "[14]", "[7]" -- and they number the part (a valve, a weldolet, a reducer), not a weld. A square box near a weld dot is a different thing entirely, and taking its number is the main way this goes wrong. Only a hexagonal flag gives a weld number.\n\n` +
              `THE WELD LIST ABOVE IS THE COMPLETE SET OF WELDS ON THIS SHEET -- nothing else on the drawing is a weld. Every number you report must be one of those IDs. If what you are about to give is not in that list, you have read something that is not a weld, and the right answer is a blank.\n\n` +
              `Give me BOTH of those weld numbers -- one from each side of the valve. Which is which does not matter and you should not try to work it out: just read the two marks. ` +
              `Follow each dot's own leader line out to its hexagonal flag and read the number there -- do not take a nearby flag that belongs to a different dot, and do not guess a number from the sequence. ` +
              `Note that the two are often NOT consecutive numbers: branch welds are numbered in among the run's own, so weld 4 can be followed by weld 7. ` +
              `If either dot's leader does not reach a legible HEXAGONAL flag inside this image, leave that field blank rather than guessing. A blank is a useful answer; a wrong number is not.

` +
              `Then, separately: say which of the two the FLOW reaches FIRST, in weld_flow_reaches_first.
${FLOW_DIRECTION_RULE}
` +
              `So on this crop: the higher end of the pipe is upstream. If the crop does not show enough to tell, leave it blank.`,
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
  const r = block.input as { weld_one?: string; weld_two?: string; what_you_see?: string; weld_flow_reaches_first?: string };

  // The weld list is the complete set of welds on the sheet, so anything not in
  // it was read off something that is not a weld.
  const known = new Set((v.welds ?? []).map((w) => String(Number(w.weld_no))));
  const raw = [r.weld_one, r.weld_two].map((x) => (x ?? "").trim()).filter(Boolean);
  const rejected = raw.filter((n) => !known.has(String(Number(n))));
  const pair = raw.filter((n) => known.has(String(Number(n))));
  if (rejected.length) console.log(`
REJECTED (not in the weld list): ${rejected.join(", ")}`);
  const want = [v.expected_after, v.expected_downstream].filter((x) => x != null).map(String);
  console.log(`\nflanking welds read: ${pair.join(" and ") || "(none)"}${want.length === 2 ? `   expected ${want.join(" and ")}` : ""}`);
  if (want.length === 2) {
    const hits = want.filter((n) => pair.includes(n)).length;
    console.log(hits === 2 ? "=> PAIR CORRECT" : `=> ${hits}/2 of the expected pair`);
  }
  console.log(`flow reaches first:  ${r.weld_flow_reaches_first || "(blank)"}   <- the weld that CLOSES the spool`);
  if (r.what_you_see) console.log(`\nsaw: ${r.what_you_see}`);

  const usage = message.usage;
  const cost = (usage.input_tokens / 1e6) * INPUT_PER_M + (usage.output_tokens / 1e6) * OUTPUT_PER_M;
  console.log(`\ntokens: ${usage.input_tokens.toLocaleString()} in / ${usage.output_tokens.toLocaleString()} out  ~$${cost.toFixed(3)}`);
}

main();
