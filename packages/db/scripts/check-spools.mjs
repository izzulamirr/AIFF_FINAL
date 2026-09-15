// Compares the spool tags currently in the DB for an ISO document against a
// hand-verified reference, so we can tell whether an extraction run reproduced
// the manual reading.
//
// The reference below is the 5-sheet ISO `8"-22-214-01-CRD-0002-AC03N-N`,
// walked weld-by-weld by hand against the drawing (see CLAUDE.md for the
// spool-boundary rules it encodes).
//
// Run from packages/db (the only workspace that resolves `postgres`):
//   node scripts/check-spools.mjs [documentId]

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));

const DEFAULT_DOC_ID = "820944b2-b2b9-467d-a005-22b05e53121d";

// sheet -> { spoolTag: [weld numbers, in order along the pipe] }
const REFERENCE = {
  1: { "N-01": [1, 2, 3, 4, 5, 6], "N-02": [7, 8, 9, 10, 11, 12], "N-03": [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25] },
  2: {
    "N-04": [1, 2, 3, 4, 5, 6],
    "N-05": [7, 8, 9, 10, 11],
    "N-06": [12, 13, 14],
    "N-07": [15, 16, 17],
    "N-08": [18, 19, 20, 21, 22],
    "N-09": [23, 24, 25, 26],
  },
  3: { "N-10": [1, 2, 3, 4, 5, 6], "N-11": [7, 8, 9, 10, 11] },
  4: { "N-12": [1, 2, 3, 4, 5, 6], "N-13": [7], "N-14": [8, 9, 10, 11, 12, 13, 14, 15, 16] },
  5: { "N-15": [1, 2, 3, 4, 5], "N-16": [6, 7, 8, 9, 10], "N-17": [11, 12], "N-18": [13, 14] },
};

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
  throw new Error("DATABASE_URL not found in env or apps/*/.env files");
}

// Spool tags carry the sheet's own printed tag (e.g. `...-AC03N-N-04`); the
// reference keys are just the trailing `N-04` part.
const shortTag = (tag) => {
  const m = String(tag).match(/(N-\d+)\s*$/i);
  return m ? m[1].toUpperCase() : String(tag);
};

const sameWelds = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const documentId = process.argv[2] ?? DEFAULT_DOC_ID;
const sql = postgres(loadDatabaseUrl(), { prepare: false });

try {
  const rows = await sql`
    SELECT tag_number, source_page, attributes
    FROM extracted_tags
    WHERE document_id = ${documentId} AND tag_type = 'spool'
    ORDER BY source_page, tag_number
  `;

  if (rows.length === 0) {
    console.log(`No spool tags in the DB for document ${documentId}.`);
    process.exit(1);
  }

  const bySheet = new Map();
  for (const r of rows) {
    const sheet = r.source_page ?? r.attributes?.sheet_number ?? 0;
    if (!bySheet.has(sheet)) bySheet.set(sheet, []);
    bySheet.get(sheet).push({
      tag: shortTag(r.tag_number),
      fullTag: r.tag_number,
      welds: (r.attributes?.weld_numbers ?? []).map(Number),
      note: r.attributes?.note,
    });
  }

  let exact = 0;
  let expectedTotal = 0;

  for (const sheet of Object.keys(REFERENCE).map(Number).sort((a, b) => a - b)) {
    const want = REFERENCE[sheet];
    const got = bySheet.get(sheet) ?? [];
    const gotByTag = new Map(got.map((g) => [g.tag, g]));
    console.log(`\nSheet ${sheet}`);

    for (const [tag, wantWelds] of Object.entries(want)) {
      expectedTotal += 1;
      const g = gotByTag.get(tag);
      if (!g) {
        console.log(`  MISSING ${tag}  expected ${wantWelds.join(",")}`);
        continue;
      }
      if (sameWelds(g.welds, wantWelds)) {
        exact += 1;
        console.log(`  OK      ${tag}  ${g.welds.join(",")}`);
      } else {
        console.log(`  WRONG   ${tag}  got ${g.welds.join(",") || "(none)"}  expected ${wantWelds.join(",")}`);
      }
    }

    for (const g of got) {
      if (!want[g.tag]) console.log(`  EXTRA   ${g.tag}  ${g.welds.join(",")}`);
    }
  }

  const sheetsInDb = [...bySheet.keys()].filter((s) => !REFERENCE[s]);
  if (sheetsInDb.length > 0) console.log(`\nSpools on unreferenced sheets: ${sheetsInDb.join(", ")}`);

  console.log(`\n${exact}/${expectedTotal} spools match the manual reference exactly.`);
} finally {
  await sql.end();
}
