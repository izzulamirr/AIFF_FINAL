// Make sure every spool the DRAWING assigns welds to has a row of its own.
//
//   node scripts/sync-spool-rows.mjs <cuts.json> [documentId] [--write]
//
// The vision pass walks spools out of each weld's local answers, and on a
// busy sheet it walks out fewer than the sheet prints -- the reference ISO
// came back with one spool row for sheet 1 where the schedule prints three,
// and two for sheet 4 where it prints four. The weld rows are right, because
// the geometric cut finder corrected them (apply-drawing-spools.mjs); it is
// only the spool rows that are missing.
//
// That gap is invisible until something keys off a spool row: the container
// page reads its sizes from them, so a spool with welds but no row shows up
// with no size and no explanation. This inserts the missing rows, with the
// weld numbers the drawing gives them.
//
// It only ever INSERTS. A spool row that already exists is left alone, and a
// row for a spool the drawing gives no welds to is left alone as well -- the
// point is to match the drawing, not to tidy.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DOC_ID = "820944b2-b2b9-467d-a005-22b05e53121d";

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const rel of ["../../apps/worker/.env", "../../apps/web/.env.local"]) {
    try {
      const text = readFileSync(resolve(here, "..", rel), "utf8");
      const line = text.split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
      if (line) return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
    } catch {
      // try the next candidate
    }
  }
  throw new Error("DATABASE_URL not found");
}

const normalizeTagNumber = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, " ");

const [, , cutsPath, ...rest] = process.argv;
if (!cutsPath) {
  console.error("usage: node scripts/sync-spool-rows.mjs <cuts.json> [documentId] [--write]");
  process.exit(1);
}
const write = rest.includes("--write");
const documentId = rest.find((a) => !a.startsWith("--")) ?? DEFAULT_DOC_ID;
const cuts = JSON.parse(readFileSync(cutsPath, "utf8"));

const sql = postgres(loadDatabaseUrl(), { prepare: false });
try {
  const [doc] = await sql`SELECT id, project_id, doc_type FROM documents WHERE id = ${documentId}`;
  if (!doc) throw new Error(`no document ${documentId}`);

  const rows = await sql`SELECT tag_number, source_page FROM extracted_tags WHERE document_id = ${documentId} AND tag_type = 'spool'`;
  const have = new Set(rows.map((r) => `${r.source_page}:${String(r.tag_number).trim()}`));

  // What the drawing says, from the trusted sheets only.
  const wanted = [];
  for (const page of cuts.pages) {
    if (!page.trusted || !page.assignment?.length) continue;
    const bySpool = new Map();
    for (const a of page.assignment) {
      const list = bySpool.get(a.spool) ?? [];
      list.push(a.weldNo);
      bySpool.set(a.spool, list);
    }
    // In the order the run reaches them, which is the order the sheet's own
    // schedule lists them in.
    const ordered = [...bySpool.entries()].sort((x, y) => Math.min(...x[1]) - Math.min(...y[1]));
    ordered.forEach(([spool, welds], i) => {
      wanted.push({ page: page.page, spool, welds: welds.slice().sort((a, b) => a - b), index: i + 1 });
    });
  }

  const missing = wanted.filter((w) => !have.has(`${w.page}:${w.spool}`));
  console.log(`${wanted.length} spools assigned by the drawing on trusted sheets; ${missing.length} have no row\n`);
  for (const m of missing) console.log(`  page ${m.page}  ${m.spool.replace(/^.*-N-/, "N-")}  welds [${m.welds.join(",")}]`);

  if (missing.length === 0) {
    console.log("nothing to do");
  } else if (!write) {
    console.log(`\ndry run -- pass --write to insert them`);
  } else {
    for (const m of missing) {
      await sql`
        INSERT INTO extracted_tags (project_id, document_id, doc_type, tag_type, tag_number, tag_number_normalized, source_page, attributes)
        VALUES (${doc.project_id}, ${documentId}, ${doc.doc_type}, 'spool', ${m.spool}, ${normalizeTagNumber(m.spool)}, ${m.page},
                ${sql.json({
                  spool_index: m.index,
                  weld_numbers: m.welds,
                  line_number: m.spool.replace(/-N-\d+$/, "-N"),
                  note: "row added to match the drawing: the sheet prints this spool and the geometry assigns welds to it, but the vision pass walked out no row for it",
                  from_drawing: true,
                })})
      `;
    }
    console.log(`\ninserted ${missing.length} spool row${missing.length === 1 ? "" : "s"}, each marked from_drawing:true`);
  }
} finally {
  await sql.end();
}
