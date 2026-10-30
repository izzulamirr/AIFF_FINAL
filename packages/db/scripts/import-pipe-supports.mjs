// Store the pipe supports found geometrically on a drawing.
//
//   node scripts/import-pipe-supports.mjs <supports.json> [documentId] [--write]
//
// Written by `apps/worker/scripts/export-pipe-supports.ts`, which finds them
// off the vector geometry -- the balloon, its leader, and the BOM row the
// balloon's number names.
//
// REPLACES this document's pipe_support rows rather than adding to them. A
// support is a position on a drawing, not an accumulating fact: re-running
// the export after fixing a label must leave one row per support, and the
// older shape of this data in the database is exactly what happens when it
// does not -- the same support 18-1 is in there four times with four
// different spans.
//
// Dry by default. Nothing is written without --write.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));

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

const argv = process.argv.slice(2);
const write = argv.includes("--write");
const [inFile, documentId] = argv.filter((a) => !a.startsWith("--"));
if (!inFile) {
  console.error("usage: node scripts/import-pipe-supports.mjs <supports.json> [documentId] [--write]");
  process.exit(1);
}

const payload = JSON.parse(readFileSync(inFile, "utf8"));
const sql = postgres(loadDatabaseUrl(), { prepare: false });

try {
  const docId =
    documentId ?? (await sql`SELECT id FROM documents WHERE doc_type = 'iso' ORDER BY uploaded_at DESC LIMIT 1`)[0]?.id;
  const [doc] = await sql`SELECT id, project_id, doc_type, file_name FROM documents WHERE id = ${docId}`;
  if (!doc) {
    console.error(`No document ${docId}`);
    process.exit(1);
  }
  console.log(`${doc.file_name}`);

  const rows = [];
  for (const page of payload.pages ?? []) {
    // The span is recorded on the support it STARTS at, and each support
    // carries the spans that begin there. Keyed by cell, which is the
    // balloon's own name and stable across re-runs.
    const spansFrom = new Map();
    for (const s of page.spans ?? []) {
      // The stretch BEFORE the first support starts at the run end, which is
      // not a support and so has no row of its own. Hang it on the support it
      // arrives at instead, or it is silently dropped -- and that stretch is
      // exactly the unheld pipe this check exists to surface.
      const key = s.fromCell === "(run end)" ? s.toCell : s.fromCell;
      const list = spansFrom.get(key) ?? [];
      list.push(s.fromCell === "(run end)" ? { ...s, toCell: "(run end)", fromCell: s.toCell } : s);
      spansFrom.set(key, list);
    }
    for (const s of page.supports ?? []) {
      rows.push({
        page: page.page,
        cell: s.cell,
        attributes: {
          cell: s.cell,
          item_no: s.itemNo,
          description: s.description,
          type_code: s.typeCode,
          role: s.role,
          // Page position, as a fraction, so it survives a re-render at any
          // scale -- same convention as the weld geometry.
          at: s.at,
          off_run_pt: s.offRunPt,
          spans: (spansFrom.get(s.cell) ?? []).map((sp) => ({
            // "span" between two supports, or "run-end" to where the
            // dimensioned run stops. The second is reported, not failed:
            // what holds the pipe there is usually not on this sheet.
            kind: sp.kind ?? "span",
            to_support: sp.toCell,
            span_mm: sp.mm,
            legs: sp.legs,
            turns: sp.turns,
            vertical_leg_mm: sp.verticalLegMm,
          })),
          // What the BOM expected against what was found, carried with the
          // rows so the page can say "2 called for, 1 located" without
          // re-deriving it.
          sheet_expected: page.expected,
          sheet_complete: page.complete,
          // Why this sheet has no spans, where it has none. A blank cell and
          // a withheld one are different answers and must not look alike.
          spans_withheld: page.spansWithheld ?? null,
          source: "geometry: item balloon leader, BOM lookup",
        },
      });
    }
  }

  console.log(`${rows.length} supports across ${(payload.pages ?? []).length} page(s)`);
  for (const r of rows) {
    const spans = r.attributes.spans;
    console.log(
      `  p${r.page} ${r.cell.padEnd(6)} item ${String(r.attributes.item_no).padEnd(3)} ${r.attributes.role.padEnd(10)} ${r.attributes.type_code ?? "-"}` +
        (spans.length ? `  spans: ${spans.map((s) => `${s.span_mm ?? "?"}mm to ${s.to_support}`).join(", ")}` : "  (no span starts here)")
    );
  }

  if (!write) {
    console.log("\nDry run. Pass --write to replace this document's pipe_support rows.");
    process.exit(0);
  }

  const existing = await sql`SELECT count(*)::int AS n FROM extracted_tags WHERE document_id = ${docId} AND tag_type = 'pipe_support'`;
  await sql`DELETE FROM extracted_tags WHERE document_id = ${docId} AND tag_type = 'pipe_support'`;
  for (const r of rows) {
    await sql`
      INSERT INTO extracted_tags (project_id, document_id, doc_type, tag_type, tag_number, tag_number_normalized, source_page, attributes)
      VALUES (${doc.project_id}, ${docId}, ${doc.doc_type}, 'pipe_support', ${r.cell}, ${r.cell.toUpperCase()}, ${r.page}, ${sql.json(r.attributes)})
    `;
  }
  console.log(`\nreplaced ${existing[0].n} old pipe_support rows with ${rows.length}`);
} finally {
  await sql.end();
}
