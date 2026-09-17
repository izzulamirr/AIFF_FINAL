// Run the FULL ISO extraction on a local PDF and write the raw result.
//
//   pnpm --filter @easy/worker exec tsx scripts/extract-iso.ts <file.pdf> <out.json>
//
// This is the expensive one -- the same two vision passes per sheet the
// worker runs, with the page image and its tiles attached each time. It
// reports the ACTUAL cost when it finishes, and the running total after each
// call, so it can be stopped if it is going somewhere unexpected.
//
// Everything downstream of it is free: scripts/spool-cuts.ts,
// scripts/export-spool-tags.ts, scripts/export-spool-envelopes.ts and
// `pnpm --filter @easy/worker replay:spools`.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractPdfPages } from "../src/pdfText";
import { extractIsoDocument } from "../src/extraction/iso";
import { usage, usageCostUsd, resetUsage } from "../src/extraction/claudeClient";

function loadApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const text = readFileSync(resolve(__dirname, "../.env"), "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith("ANTHROPIC_API_KEY="));
  if (!line) throw new Error("ANTHROPIC_API_KEY not found");
  return line.slice("ANTHROPIC_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

async function main() {
  const [, , pdfPath, outPath] = process.argv;
  if (!pdfPath || !outPath) {
    console.error("usage: tsx scripts/extract-iso.ts <file.pdf> <out.json>");
    process.exit(1);
  }
  const buf = readFileSync(pdfPath);
  const pages = await extractPdfPages(buf);
  console.log(`${pages.length} pages from ${pdfPath}\n`);

  resetUsage();
  let lastCalls = 0;
  const started = Date.now();
  const result = await extractIsoDocument(pages, loadApiKey(), (evt) => {
    const cost = usageCostUsd();
    // Only print the running cost when a call has actually happened, so the
    // line means something.
    const spend = usage.calls > lastCalls ? `   [${usage.calls} calls, $${cost.toFixed(3)} so far]` : "";
    lastCalls = usage.calls;
    console.log(`  ${evt.phase} ${evt.current}/${evt.total}${evt.detail ? ` -- ${evt.detail}` : ""}${spend}`);
  }, buf);

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  writeFileSync(outPath, JSON.stringify(result.rawJson, null, 2));
  const tagCounts = new Map<string, number>();
  for (const t of result.tags) tagCounts.set(t.tagType, (tagCounts.get(t.tagType) ?? 0) + 1);

  console.log(`\nwrote ${outPath}`);
  console.log(`  ${result.tags.length} tags: ${[...tagCounts.entries()].map(([k, v]) => `${v} ${k}`).join(", ")}`);
  console.log(
    `\nACTUAL COST: $${usageCostUsd().toFixed(3)}  (${usage.calls} calls, ` +
      `${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out, ${secs}s)`
  );
}
main();
