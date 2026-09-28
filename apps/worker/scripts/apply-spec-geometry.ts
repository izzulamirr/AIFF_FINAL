// Corrects a stored client spec's PIPE rows from the PDF's own table geometry, without a
// model call -- for a document extracted before the geometry reader existed.
//
//   pnpm --filter @easy/worker exec tsx scripts/apply-spec-geometry.ts <pdf> <documentId>            (dry run)
//   pnpm --filter @easy/worker exec tsx scripts/apply-spec-geometry.ts <pdf> <documentId> --write
//
// Only the class's `pipes` change. The rows it replaces are kept on the same tag as
// `pipes_before_geometry`, so a correction can be reviewed and reversed. Nothing is written
// unless the table reads cleanly (every size column covered exactly once) AND the PDF's size
// headers are the sizes the stored class already has -- a guard against pointing the wrong PDF
// at a document.
import { readFileSync } from "node:fs";

for (const l of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(l);
  if (m && m[1] === "DATABASE_URL") process.env.DATABASE_URL = m[2].replace(/^["']|["']$/g, "");
}

async function main() {
  const [, , pdfPath, documentId, ...flags] = process.argv;
  if (!pdfPath || !documentId) throw new Error("usage: apply-spec-geometry.ts <pdf> <documentId> [--write]");
  const write = flags.includes("--write");

  const { createDb, extractedTags, documents } = await import("@easy/db");
  const { eq } = await import("drizzle-orm");
  const { parseNpsInches } = await import("@easy/shared");
  const { readSpecPageTable } = await import("../src/extraction/specTablePdf");
  const { classRowsFromTable } = await import("../src/extraction/specTable");
  const { readPageCount } = await import("../src/pdfGeometry");

  const db = createDb(process.env.DATABASE_URL!);
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  if (!doc) throw new Error(`No document ${documentId}.`);

  const buf = readFileSync(pdfPath);
  let read: { table: NonNullable<Awaited<ReturnType<typeof readSpecPageTable>>>; rows: NonNullable<ReturnType<typeof classRowsFromTable>>; page: number } | null = null;
  for (let p = 1, n = await readPageCount(buf); p <= n && !read; p++) {
    const table = await readSpecPageTable(buf, p);
    const rows = table ? classRowsFromTable(table) : null;
    if (table && rows) read = { table, rows, page: p };
  }
  if (!read) throw new Error("No size table with a Schedule row was found on that PDF.");
  if (read.rows.issues.length > 0) throw new Error(`The table did not read cleanly: ${read.rows.issues.join(" | ")}`);

  const tags = (await db.select().from(extractedTags).where(eq(extractedTags.documentId, documentId))).filter((t) => t.tagType === "spec_class");
  if (tags.length === 0) throw new Error("That document has no stored spec class.");
  console.log(`${doc.fileName}: ${tags.length} stored class(es); the PDF's table is on page ${read.page} with ${read.table.columns.length} size columns.`);

  for (const tag of tags) {
    const attrs = tag.attributes as Record<string, unknown>;
    const stored = (attrs.pipes as Array<Record<string, unknown>> | undefined) ?? [];

    // Guard: the stored class must be this PDF's. Every PDF header size has to fall inside one of
    // the stored bands, and no stored band may reach past the PDF's sizes.
    const pdfInches = read.table.columns.map((c) => parseNpsInches(c.min)).filter((v): v is number => v != null);
    const storedInches = stored.flatMap((r) => [parseNpsInches(r.size_min), parseNpsInches(r.size_max)]).filter((v): v is number => v != null);
    const covered = pdfInches.every((s) => stored.some((r) => (parseNpsInches(r.size_min) ?? Infinity) - 1e-9 <= s && s <= (parseNpsInches(r.size_max) ?? -Infinity) + 1e-9));
    const overreach = storedInches.some((v) => v > Math.max(...pdfInches) + 1e-9 || v < Math.min(...pdfInches) - 1e-9);
    if (!covered || overreach) {
      console.log(`  ${tag.tagNumber}: skipped -- its stored sizes are not this PDF's sizes.`);
      continue;
    }

    const label = (r: Record<string, unknown>) => `${r.size_min}${r.size_min === r.size_max ? "" : "-" + r.size_max}`;
    console.log(`\n  ${tag.tagNumber}: ${stored.length} stored pipe rows -> ${read.rows.pipes.length} from the PDF`);
    const at = (rows: Array<Record<string, unknown>>, size: number) => rows.find((r) => (parseNpsInches(r.size_min) ?? Infinity) - 1e-9 <= size && size <= (parseNpsInches(r.size_max) ?? -Infinity) + 1e-9);
    let changed = 0;
    for (const col of read.table.columns) {
      const size = parseNpsInches(col.min)!;
      const was = at(stored, size);
      const now = read.rows.pipes[read.table.columns.indexOf(col)];
      const same = String(was?.schedule ?? "").toUpperCase().replace(/MM$/i, "") === String(now.schedule ?? "").toUpperCase().replace(/MM$/i, "") && String(was?.end_type ?? "") === String(now.end_type ?? "");
      if (!same) changed += 1;
      console.log(`    ${col.label.padEnd(7)} app ${String(was ? label(was) + " " + was.schedule : "-").padEnd(20)} pdf ${String(now.schedule).padEnd(8)} ${same ? "" : "  <-- changes"}`);
    }
    console.log(`  ${changed} size(s) change.`);

    if (write) {
      await db
        .update(extractedTags)
        .set({
          attributes: {
            ...attrs,
            pipes: read.rows.pipes.map((p) => ({ ...p })),
            pipes_before_geometry: stored,
            table_source: "geometry",
          },
        })
        .where(eq(extractedTags.id, tag.id));
      console.log(`  written. The earlier rows are kept in attributes.pipes_before_geometry.`);
    }
  }
  if (!write) console.log("\nDry run: nothing was written. Add --write to apply.");
  process.exit(0);
}
main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
