// Loads what the geometry pipeline found (apps/worker/scripts/export-weld-geometry.ts)
// onto a document's existing weld rows, so the drawing-derived position and run
// order sit alongside what the vision extraction recorded and the two can be
// compared in one place.
//
// Nothing is deleted and no row is created: each matched weld row gains a
// `geometry` block in its attributes. A weld the geometry could not name is
// reported, not guessed at.
//
// Run from packages/db:
//   node scripts/import-weld-geometry.mjs <geometry.json> [documentId]

import { readFileSync } from "node:fs";
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

const [, , jsonPath, docArg] = process.argv;
if (!jsonPath) {
  console.error("usage: node scripts/import-weld-geometry.mjs <geometry.json> [documentId]");
  process.exit(1);
}
const documentId = docArg ?? DEFAULT_DOC_ID;
const data = JSON.parse(readFileSync(jsonPath, "utf8"));
const sql = postgres(loadDatabaseUrl(), { prepare: false });

try {
  const rows = await sql`
    SELECT id, source_page, tag_number, attributes
    FROM extracted_tags
    WHERE document_id = ${documentId} AND tag_type = 'weld'
    ORDER BY source_page, id
  `;
  console.log(`${rows.length} weld rows in the database for this document\n`);

  const byPageNo = new Map();
  for (const r of rows) {
    const no = Number(String(r.attributes?.weld_no ?? "").trim());
    if (Number.isFinite(no)) byPageNo.set(`${r.source_page}:${no}`, r);
  }

  let matched = 0;
  let unnamed = 0;
  const updates = [];
  for (const page of data.pages) {
    let pageMatched = 0;
    for (const w of page.welds) {
      if (w.weldNo == null) {
        unnamed++;
        continue;
      }
      const row = byPageNo.get(`${page.page}:${w.weldNo}`);
      if (!row) continue;
      pageMatched++;
      matched++;
      updates.push({
        id: row.id,
        attributes: {
          ...row.attributes,
          geometry: {
            source: "pdf-geometry",
            label: w.label,
            mark_x: w.markFraction.x,
            mark_y: w.markFraction.y,
            fit_pt: w.fitPt,
            run_order: w.runOrder,
            comes_after: w.comesAfterLabel,
            on_branch: w.onBranch,
          },
        },
      });
    }
    console.log(
      `page ${page.page}: ${page.welds.length}/${page.flagCount} located by geometry` +
        `${page.untraced ? `, ${page.untraced} unlocated` : ""}` +
        `  ->  ${pageMatched} matched onto database rows`
    );
  }

  for (const u of updates) {
    await sql`UPDATE extracted_tags SET attributes = ${sql.json(u.attributes)} WHERE id = ${u.id}`;
  }

  console.log(`\nwrote a geometry block onto ${matched} weld rows`);
  if (unnamed > 0) {
    console.log(`${unnamed} welds were located on the drawing but not named -- their sheet's flags were not read, so there is no weld number to match on`);
  }
} finally {
  await sql.end();
}
