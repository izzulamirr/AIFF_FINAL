// Replaces one document's EXTRACTED DATA with another project's reading of the same file.
//
//   pnpm --filter @easy/worker exec tsx scripts/replace-doc-extraction.ts <fromProject> <toProject> <docType>            (dry run)
//   pnpm --filter @easy/worker exec tsx scripts/replace-doc-extraction.ts <fromProject> <toProject> <docType> --write
//   pnpm --filter @easy/worker exec tsx scripts/replace-doc-extraction.ts --restore <backup.json>
//
// For a file that is already in both projects (same hash), so a plain copy would add nothing:
// the destination document stays exactly as it is -- same row, same stored file -- and only what
// was READ from it (its extracted tags, page text and extraction result) is swapped for the
// source's. The destination's own reading is written to backups/ first, in full, and
// --restore puts it back. Nothing is written without --write.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

for (const l of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(l);
  if (m && m[1] === "DATABASE_URL") process.env.DATABASE_URL = m[2].replace(/^["']|["']$/g, "");
}

async function main() {
  const args = process.argv.slice(2);
  const { createDb, projects, documents, documentPages, extractionJobs, extractionResults, extractedTags } = await import("@easy/db");
  const { eq } = await import("drizzle-orm");
  const db = createDb(process.env.DATABASE_URL!);

  // ---- restore ----------------------------------------------------------------------
  if (args[0] === "--restore") {
    const backup = JSON.parse(readFileSync(args[1], "utf8")) as {
      documentId: string;
      pages: Array<{ pageNumber: number; pageText: string | null }>;
      results: Array<{ schemaVersion: string; rawJson: unknown }>;
      tags: Array<{ projectId: string; docType: string; tagType: string; tagNumber: string; tagNumberNormalized: string; sourcePage: number | null; attributes: unknown }>;
    };
    await db.transaction(async (tx) => {
      await tx.delete(extractedTags).where(eq(extractedTags.documentId, backup.documentId));
      await tx.delete(documentPages).where(eq(documentPages.documentId, backup.documentId));
      await tx.delete(extractionResults).where(eq(extractionResults.documentId, backup.documentId));
      if (backup.pages.length > 0) await tx.insert(documentPages).values(backup.pages.map((p) => ({ documentId: backup.documentId, ...p })));
      for (const r of backup.results) await tx.insert(extractionResults).values({ documentId: backup.documentId, schemaVersion: r.schemaVersion, rawJson: r.rawJson as object });
      for (let i = 0; i < backup.tags.length; i += 200) {
        await tx.insert(extractedTags).values(backup.tags.slice(i, i + 200).map((t) => ({ ...t, documentId: backup.documentId, attributes: t.attributes as object })));
      }
    });
    console.log(`restored ${backup.tags.length} tags, ${backup.pages.length} pages, ${backup.results.length} result(s) to document ${backup.documentId}`);
    process.exit(0);
  }

  // ---- replace ----------------------------------------------------------------------
  const [fromArg, toArg, docType, ...flags] = args;
  if (!fromArg || !toArg || !docType) throw new Error("usage: replace-doc-extraction.ts <from> <to> <docType> [--write]");
  const write = flags.includes("--write");
  const all = await db.select().from(projects);
  const find = (arg: string) => {
    const hits = all.filter((p) => p.id.startsWith(arg));
    if (hits.length !== 1) throw new Error(`"${arg}" matches ${hits.length} projects.`);
    return hits[0];
  };
  const from = find(fromArg);
  const to = find(toArg);

  const docs = await db.select().from(documents);
  const source = docs.filter((d) => d.projectId === from.id && d.docType === docType);
  const target = docs.filter((d) => d.projectId === to.id && d.docType === docType);
  console.log(`from ${from.name} [${from.id.slice(0, 8)}] to ${to.name} [${to.id.slice(0, 8)}], ${docType}   ${write ? "WRITE" : "dry run"}`);

  for (const src of source) {
    const dst = target.find((d) => d.fileHash === src.fileHash);
    if (!dst) {
      console.log(`  ${src.fileName}: not in the destination -- use copy-project-docs.ts for that`);
      continue;
    }
    const srcTags = await db.select().from(extractedTags).where(eq(extractedTags.documentId, src.id));
    const srcPages = await db.select().from(documentPages).where(eq(documentPages.documentId, src.id));
    const srcResults = (await db.select().from(extractionResults).where(eq(extractionResults.documentId, src.id))).sort((a, b) => +a.createdAt - +b.createdAt);
    const dstTags = await db.select().from(extractedTags).where(eq(extractedTags.documentId, dst.id));
    const dstPages = await db.select().from(documentPages).where(eq(documentPages.documentId, dst.id));
    const dstResults = await db.select().from(extractionResults).where(eq(extractionResults.documentId, dst.id));
    const count = (rows: Array<{ tagType: string }>) => {
      const by: Record<string, number> = {};
      for (const t of rows) by[t.tagType] = (by[t.tagType] ?? 0) + 1;
      return JSON.stringify(by);
    };
    console.log(`  ${src.fileName}`);
    console.log(`    yours now : ${dstTags.length} tags ${count(dstTags)}, ${dstPages.length} pages, ${dstResults.length} result(s)`);
    console.log(`    to become : ${srcTags.length} tags ${count(srcTags)}, ${srcPages.length} pages, ${srcResults.length} result(s)`);
    if (!write) continue;

    mkdirSync("backups", { recursive: true });
    const backupPath = `backups/${docType}-${dst.id.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(
      backupPath,
      JSON.stringify({
        documentId: dst.id,
        fileName: dst.fileName,
        pages: dstPages.map((p) => ({ pageNumber: p.pageNumber, pageText: p.pageText })),
        results: dstResults.map((r) => ({ schemaVersion: r.schemaVersion, rawJson: r.rawJson })),
        tags: dstTags.map((t) => ({ projectId: t.projectId, docType: t.docType, tagType: t.tagType, tagNumber: t.tagNumber, tagNumberNormalized: t.tagNumberNormalized, sourcePage: t.sourcePage, attributes: t.attributes })),
      })
    );
    console.log(`    backup    : ${backupPath}`);

    await db.transaction(async (tx) => {
      await tx.delete(extractedTags).where(eq(extractedTags.documentId, dst.id));
      await tx.delete(documentPages).where(eq(documentPages.documentId, dst.id));
      await tx.delete(extractionResults).where(eq(extractionResults.documentId, dst.id));
      if (srcPages.length > 0) await tx.insert(documentPages).values(srcPages.map((p) => ({ documentId: dst.id, pageNumber: p.pageNumber, pageText: p.pageText })));
      for (const r of srcResults.slice(-1)) await tx.insert(extractionResults).values({ documentId: dst.id, schemaVersion: r.schemaVersion, rawJson: r.rawJson as object });
      for (let i = 0; i < srcTags.length; i += 200) {
        await tx.insert(extractedTags).values(
          srcTags.slice(i, i + 200).map((t) => ({
            projectId: to.id,
            documentId: dst.id,
            docType: t.docType,
            tagType: t.tagType,
            tagNumber: t.tagNumber,
            tagNumberNormalized: t.tagNumberNormalized,
            sourcePage: t.sourcePage,
            attributes: t.attributes as object,
          }))
        );
      }
      await tx.update(documents).set({ pageCount: src.pageCount }).where(eq(documents.id, dst.id));
    });
    console.log(`    done. To undo: tsx scripts/replace-doc-extraction.ts --restore ${backupPath}`);
  }
  if (!write) console.log("\nDry run: nothing was written. Add --write to apply.");
  process.exit(0);
}
main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
