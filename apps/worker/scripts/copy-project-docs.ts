// Copies documents (with their stored file, page text, extraction result and extracted tags)
// from one project into another, without re-extracting anything -- so it costs nothing and the
// copy carries exactly what the source was read as.
//
//   pnpm --filter @easy/worker exec tsx scripts/copy-project-docs.ts <fromProjectId> <toProjectId> <docType[,docType...]>            (dry run)
//   pnpm --filter @easy/worker exec tsx scripts/copy-project-docs.ts <fromProjectId> <toProjectId> <docType[,docType...]> --write
//
// Project ids may be given as their first 8 characters. Only the named document types are
// copied. A document whose file is already in the destination (same hash) is skipped, so
// running it twice copies nothing twice. For the cutting type it also copies the project's
// saved stock plates and part quantities, when the destination has none of its own.
//
// Uses the worker's own database and storage credentials; the source is only read.
import { readFileSync } from "node:fs";

for (const l of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(l);
  if (m && ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].includes(m[1])) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const BUCKET = "documents";

async function main() {
  const [, , fromArg, toArg, typesArg, ...flags] = process.argv;
  if (!fromArg || !toArg || !typesArg) throw new Error("usage: copy-project-docs.ts <from> <to> <docType[,docType]> [--write]");
  const write = flags.includes("--write");
  const types = typesArg.split(",").map((t) => t.trim());

  const { createDb, projects, documents, documentPages, extractionJobs, extractionResults, extractedTags, cuttingStockPlates, cuttingPartQuantities } = await import("@easy/db");
  const { eq } = await import("drizzle-orm");
  const { createClient } = await import("@supabase/supabase-js");

  const db = createDb(process.env.DATABASE_URL!);
  const storage = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const all = await db.select().from(projects);
  const find = (arg: string) => {
    const hits = all.filter((p) => p.id === arg || p.id.startsWith(arg));
    if (hits.length !== 1) throw new Error(`"${arg}" matches ${hits.length} projects.`);
    return hits[0];
  };
  const from = find(fromArg);
  const to = find(toArg);
  if (from.id === to.id) throw new Error("Source and destination are the same project.");
  console.log(`from: ${from.name} [${from.id.slice(0, 8)}]   to: ${to.name} [${to.id.slice(0, 8)}]   types: ${types.join(", ")}   ${write ? "WRITE" : "dry run"}`);

  const sourceDocs = (await db.select().from(documents).where(eq(documents.projectId, from.id))).filter((d) => types.includes(d.docType));
  const destDocs = await db.select().from(documents).where(eq(documents.projectId, to.id));

  for (const doc of sourceDocs) {
    if (destDocs.some((d) => d.fileHash === doc.fileHash)) {
      console.log(`  skip   ${doc.docType} ${doc.fileName}: already in the destination`);
      continue;
    }
    const pages = await db.select().from(documentPages).where(eq(documentPages.documentId, doc.id));
    const tags = await db.select().from(extractedTags).where(eq(extractedTags.documentId, doc.id));
    const jobs = (await db.select().from(extractionJobs).where(eq(extractionJobs.documentId, doc.id))).sort((a, b) => +b.createdAt - +a.createdAt);
    const job = jobs.find((j) => j.status === "succeeded");
    const results = await db.select().from(extractionResults).where(eq(extractionResults.documentId, doc.id));
    console.log(`  copy   ${doc.docType} ${doc.fileName}: ${pages.length} pages, ${tags.length} tags, ${results.length} result(s), job ${job?.status ?? "none"}`);
    if (!write) continue;

    // 1. the file, under the destination's own folder, named the way an upload is.
    const { data: file, error: downloadError } = await storage.storage.from(BUCKET).download(doc.storagePath);
    if (downloadError || !file) throw new Error(`Could not read ${doc.storagePath}: ${downloadError?.message}`);
    const storagePath = `${to.id}/${doc.fileHash}-${doc.fileName}`;
    const { error: uploadError } = await storage.storage.from(BUCKET).upload(storagePath, Buffer.from(await file.arrayBuffer()), { upsert: false });
    if (uploadError && !/already exists|Duplicate/i.test(uploadError.message)) throw new Error(`Could not store ${storagePath}: ${uploadError.message}`);

    // 2. the rows, together or not at all.
    await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(documents)
        .values({
          projectId: to.id,
          docType: doc.docType,
          fileName: doc.fileName,
          fileHash: doc.fileHash,
          storagePath,
          pageCount: doc.pageCount,
          uploadedBy: doc.uploadedBy,
        })
        .returning();
      if (pages.length > 0) await tx.insert(documentPages).values(pages.map((p) => ({ documentId: created.id, pageNumber: p.pageNumber, pageText: p.pageText })));
      let newJobId: string | undefined;
      if (job) {
        const [j] = await tx
          .insert(extractionJobs)
          .values({ documentId: created.id, status: "succeeded", progressPhase: job.progressPhase, progressCurrent: job.progressCurrent, progressTotal: job.progressTotal, startedAt: job.startedAt, finishedAt: job.finishedAt })
          .returning();
        newJobId = j.id;
      }
      for (const r of results.slice(-1)) {
        await tx.insert(extractionResults).values({ documentId: created.id, extractionJobId: newJobId, schemaVersion: r.schemaVersion, rawJson: r.rawJson as object });
      }
      for (let i = 0; i < tags.length; i += 200) {
        await tx.insert(extractedTags).values(
          tags.slice(i, i + 200).map((t) => ({
            projectId: to.id,
            documentId: created.id,
            docType: t.docType,
            tagType: t.tagType,
            tagNumber: t.tagNumber,
            tagNumberNormalized: t.tagNumberNormalized,
            sourcePage: t.sourcePage,
            attributes: t.attributes as object,
          }))
        );
      }
    });
    console.log(`         done -> ${storagePath}`);
  }

  if (types.includes("cutting")) {
    const stock = await db.select().from(cuttingStockPlates).where(eq(cuttingStockPlates.projectId, from.id));
    const quantities = await db.select().from(cuttingPartQuantities).where(eq(cuttingPartQuantities.projectId, from.id));
    const destStock = await db.select().from(cuttingStockPlates).where(eq(cuttingStockPlates.projectId, to.id));
    const destQty = await db.select().from(cuttingPartQuantities).where(eq(cuttingPartQuantities.projectId, to.id));
    console.log(`  cutting settings: source has ${stock.length} stock plate row(s) and ${quantities.length} quantity row(s); destination has ${destStock.length} and ${destQty.length}`);
    if (write) {
      if (stock.length > 0 && destStock.length === 0) {
        await db.insert(cuttingStockPlates).values(stock.map((s) => ({ projectId: to.id, lengthMm: s.lengthMm, widthMm: s.widthMm, thicknessMm: s.thicknessMm, material: s.material, quantity: s.quantity, sortOrder: s.sortOrder })));
        console.log(`         copied ${stock.length} stock plate row(s)`);
      }
      if (quantities.length > 0 && destQty.length === 0) {
        await db.insert(cuttingPartQuantities).values(quantities.map((q) => ({ projectId: to.id, partMark: q.partMark, quantity: q.quantity })));
        console.log(`         copied ${quantities.length} quantity row(s)`);
      }
    }
  }
  if (!write) console.log("\nDry run: nothing was written. Add --write to copy.");
  process.exit(0);
}
main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
