// The whole weld side, end to end: find each weld and its flag by geometry, read
// the numbers off a contact sheet, order them along the run by geometry, and
// print the chain with real weld numbers.
//
//   pnpm --filter @easy/worker exec tsx scripts/probe-weld-chain.ts <file.pdf> <page>
//
// One small API call (reading isolated labels); everything else is local.

import { readFileSync } from "node:fs";
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

async function main() {
  const [, , pdfPath, pageArg] = process.argv;
  if (!pdfPath || !pageArg) {
    console.error("usage: tsx scripts/probe-weld-chain.ts <file.pdf> <page>");
    process.exit(1);
  }
  const page = Number(pageArg);
  const buf = readFileSync(pdfPath);

  const marks = await readWeldMarks(buf, page);
  console.log(`page ${page}: ${marks.hits.length}/${marks.flagCount} welds located`);

  // Cell i of the contact sheet IS hits[i], so a label maps straight back to a
  // located weld without any ordering assumption.
  const png = await renderRegionContactSheet(
    buf,
    page,
    marks.hits.map((h, i) => ({ label: String(i + 1), bbox: h.flagBox }))
  );
  if (!png) return;

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
              `Each box is one weld's number flag, cut from an isometric drawing; the cell number is printed under it as "#1", "#2" and so on.\n\n` +
              `Read the label inside every hexagon exactly as printed, keeping the letter prefix (BW buttweld, FW field weld, TW tapweld, TH threaded, SW socketweld).\n` +
              `There are ${marks.hits.length} cells; return ${marks.hits.length} entries in cell order. Stray line fragments clipping into a box are not part of the label.`,
          },
        ],
      },
    ],
  });

  const block = message.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") return;
  const labels = new Map<number, string>();
  for (const f of (block.input as { flags?: Array<{ cell: number | string; label: string }> }).flags ?? []) labels.set(Number(f.cell), f.label);

  const nameOf = (hitIndex: number) => labels.get(hitIndex + 1) ?? `?${hitIndex}`;
  const numberOf = (hitIndex: number) => Number(String(nameOf(hitIndex)).replace(/^[A-Za-z]+/, ""));

  // The numbers orient the walk, so the run is ordered only once they are read.
  const run = await readRunOrder(buf, page, marks, numberOf);
  console.log(`run: ${run.runPolylines} polylines; ${run.welds.length} welds placed on it${run.offRun.length ? `, ${run.offRun.length} off it` : ""}`);

  console.log(`\nthe run, in the order the pipe reaches it:\n`);
  const chain: string[] = [];
  for (const w of run.welds) {
    chain.push(`${nameOf(w.hitIndex)}${w.onBranch ? "*" : ""}`);
    console.log(
      `  ${nameOf(w.hitIndex).padEnd(6)} after ${w.comesAfter === null ? "-".padEnd(6) : nameOf(w.comesAfter).padEnd(6)}` +
        `${w.onBranch ? "  [branch]" : ""}   at (${w.position.x.toFixed(0)},${w.position.y.toFixed(0)})`
    );
  }
  console.log(`\nchain: ${chain.join(" -> ")}`);
  console.log(`(* = on a branch)`);

  const nums = run.welds.map((w) => numberOf(w.hitIndex)).filter(Number.isFinite);
  const ascending = nums.every((n, i) => i === 0 || n >= nums[i - 1]);
  console.log(`\nweld numbers in run order: ${nums.join(", ")}`);
  console.log(ascending ? `=> the run follows the numbering` : `=> the run does NOT follow the numbering (expected on many sheets)`);

  const u = message.usage;
  console.log(`\ntokens: ${u.input_tokens.toLocaleString()} in / ${u.output_tokens.toLocaleString()} out  ~$${((u.input_tokens / 1e6) * 15 + (u.output_tokens / 1e6) * 75).toFixed(3)}`);
}

main();
