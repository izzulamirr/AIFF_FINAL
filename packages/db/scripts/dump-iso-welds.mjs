// Dumps the raw per-weld topology the model returned for an ISO's latest
// extraction run, so a wrong spool grouping can be traced back to the specific
// `comes_after_weld` / `closes_spool` answer that caused it.
//
// Run from packages/db:
//   node scripts/dump-iso-welds.mjs [documentId] [sheetNumber ...]
//   node scripts/dump-iso-welds.mjs <documentId> --out raw.json
//
// `--out` writes the whole raw_json to a file, which is what
// apps/worker/scripts/replay-spools.ts then scores offline.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DOC_ID = "820944b2-b2b9-467d-a005-22b05e53121d";

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const rel of ["../../../apps/worker/.env", "../../../apps/web/.env.local"]) {
    try {
      const text = readFileSync(resolve(here, rel), "utf8");
      const line = text.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
      if (line) return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
    } catch {
      // try the next candidate
    }
  }
  throw new Error("DATABASE_URL not found");
}

const [, , docArg, ...rest] = process.argv;
const documentId = docArg ?? DEFAULT_DOC_ID;
const outIndex = rest.indexOf("--out");
const outFile = outIndex >= 0 ? rest[outIndex + 1] : undefined;
const wantSheets = (outIndex >= 0 ? rest.slice(0, outIndex) : rest).map(Number);

const sql = postgres(loadDatabaseUrl(), { prepare: false });

try {
  const [result] = await sql`
    SELECT id, created_at, raw_json
    FROM extraction_results
    WHERE document_id = ${documentId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (!result) {
    console.log("No extraction_results row for this document.");
    process.exit(1);
  }
  console.log(`Latest extraction result ${result.id} at ${result.created_at.toISOString()}\n`);

  const raw = result.raw_json;
  if (outFile) {
    writeFileSync(outFile, JSON.stringify(raw, null, 2));
    console.log(`Wrote raw_json to ${outFile}`);
  }
  const sheets = raw.sheets ?? raw.pages ?? [];
  console.log(`raw_json top-level keys: ${Object.keys(raw).join(", ")}`);
  console.log(`sheets: ${sheets.length}\n`);

  for (const entry of sheets) {
    // Each entry wraps the model's tool output as { result, pageNumber, drawing_number }.
    const sheet = entry.result ?? entry;
    const n = entry.pageNumber ?? sheet.sheet_number ?? "?";
    if (wantSheets.length > 0 && !wantSheets.includes(Number(n))) continue;
    console.log(`=== Sheet ${n} (${entry.drawing_number ?? "?"}) ===`);
    console.log(`spool_tags: ${JSON.stringify(sheet.spool_tags ?? sheet.pipe_spools ?? null)}`);
    const welds = sheet.welds ?? [];
    console.log(`welds (${welds.length}):`);
    for (const w of welds) {
      const flags = [];
      if (w.closes_spool) flags.push("CLOSES_SPOOL");
      console.log(
        `  #${String(w.weld_no).padEnd(3)} type=${String(w.weld_type ?? "?").padEnd(10)}` +
          ` after=${String(w.comes_after_weld ?? "-").padEnd(4)} ${flags.join(" ")}`
      );
    }
    console.log("");
  }
} finally {
  await sql.end();
}
