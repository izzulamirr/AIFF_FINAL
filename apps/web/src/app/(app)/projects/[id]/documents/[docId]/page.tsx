import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { documents, extractionJobs, extractionResults, extractedTags, findings } from "@easy/db";
import { getDb } from "@/lib/db";
import { verifyIsoAction } from "./actions";

const DOC_TYPE_LABELS: Record<string, string> = {
  pid: "P&ID",
  hmb: "H&MB",
  pfd: "PFD",
  spec_sheet: "Spec Sheet",
  iso: "ISO",
  ga: "GA",
  pll: "Line List (PLL)",
};

const GATE_LABELS: Record<string, string> = {
  "0": "0 Document",
  "1": "1 Line list",
  "2": "2 Design basis",
  "3": "3 P&ID",
  "4": "4 Specs",
  "5": "5 Geometry",
  "6": "6 Supports",
  "7": "7 BOM",
  "8": "8 GA",
};

export default async function DocumentDetailPage({ params }: { params: Promise<{ id: string; docId: string }> }) {
  const { id: projectId, docId } = await params;
  const db = getDb();

  const [document] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
  if (!document || document.projectId !== projectId) return <p>Document not found.</p>;

  const [result] = await db
    .select()
    .from(extractionResults)
    .where(eq(extractionResults.documentId, docId))
    .orderBy(desc(extractionResults.createdAt))
    .limit(1);

  const tags = await db.select().from(extractedTags).where(eq(extractedTags.documentId, docId));

  const isIso = document.docType === "iso";
  let pllOptions: (typeof documents.$inferSelect)[] = [];
  let specOptions: (typeof documents.$inferSelect)[] = [];
  let pidOptions: (typeof documents.$inferSelect)[] = [];
  let gaOptions: (typeof documents.$inferSelect)[] = [];
  let isoFindings: (typeof findings.$inferSelect)[] = [];
  let docNameById = new Map<string, string>();

  if (isIso) {
    const siblingDocs = await db
      .select()
      .from(documents)
      .where(eq(documents.projectId, projectId));

    const siblingJobs = await db
      .select({ job: extractionJobs })
      .from(extractionJobs)
      .innerJoin(documents, eq(documents.id, extractionJobs.documentId))
      .where(eq(documents.projectId, projectId));
    const latestStatusByDoc = new Map<string, string>();
    for (const { job } of siblingJobs) {
      const existingStatus = latestStatusByDoc.get(job.documentId);
      if (!existingStatus) latestStatusByDoc.set(job.documentId, job.status);
    }

    const succeeded = siblingDocs.filter((d) => d.id !== docId && latestStatusByDoc.get(d.id) === "succeeded");
    pllOptions = succeeded.filter((d) => d.docType === "pll");
    specOptions = succeeded.filter((d) => d.docType === "spec_sheet");
    pidOptions = succeeded.filter((d) => d.docType === "pid");
    gaOptions = succeeded.filter((d) => d.docType === "ga");

    docNameById = new Map(siblingDocs.map((d) => [d.id, d.fileName]));
    docNameById.set(document.id, document.fileName);

    isoFindings = await db.select().from(findings).where(eq(findings.docAId, docId)).orderBy(desc(findings.createdAt));
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/projects/${projectId}`} className="text-sm text-blue-600 underline">
          &larr; Back to project
        </Link>
        <h1 className="text-xl font-semibold">{document.fileName}</h1>
        <p className="text-sm text-gray-500">
          {DOC_TYPE_LABELS[document.docType] ?? document.docType} &middot; {document.pageCount ?? "?"} pages
        </p>
      </div>

      {isIso && (
        <section className="rounded border p-4">
          <h2 className="mb-2 font-medium">Verify ISO</h2>
          <p className="mb-3 text-sm text-gray-500">
            Gate-ordered check chain: 0 title block &rarr; 1 line exists in PLL (fail = stop) &rarr; 2 design basis vs PLL (class
            mismatch = stop) &rarr; 3 P&amp;ID &rarr; 4 specs &rarr; 6 supports &rarr; 7 BOM item codes &rarr; 8 GA routing. Gate 5
            (geometry/drafting) needs drawing geometry the extraction doesn&apos;t capture and is not checked.
          </p>
          <form action={verifyIsoAction.bind(null, docId)} className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              Line list (PLL)
              <select name="pllDocumentId" className="mt-1 block rounded border px-3 py-2">
                <option value="">None</option>
                {pllOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fileName}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Spec sheet
              <select name="specDocumentId" className="mt-1 block rounded border px-3 py-2">
                <option value="">None</option>
                {specOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fileName}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              P&amp;ID
              <select name="pidDocumentId" className="mt-1 block rounded border px-3 py-2">
                <option value="">None</option>
                {pidOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fileName}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              GA
              <select name="gaDocumentId" className="mt-1 block rounded border px-3 py-2">
                <option value="">None</option>
                {gaOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fileName}
                  </option>
                ))}
              </select>
            </label>
            <button className="rounded bg-black px-4 py-2 text-white">Verify</button>
          </form>

          <h3 className="mb-2 mt-4 font-medium">Findings ({isoFindings.length})</h3>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-2">Gate</th>
                <th>Severity</th>
                <th>Tag</th>
                <th>Field</th>
                <th>ISO value</th>
                <th>Compared to</th>
                <th>Other value</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {[...isoFindings]
                .sort((a, b) => a.fieldChecked.localeCompare(b.fieldChecked))
                .map((finding) => {
                  const [gate, ...fieldParts] = finding.fieldChecked.split(".");
                  const field = fieldParts.join(".") || finding.fieldChecked;
                  return (
                    <tr key={finding.id} className="border-b align-top">
                      <td className="py-2">{GATE_LABELS[gate] ?? gate}</td>
                      <td>{finding.severity}</td>
                      <td>{finding.tagNumber}</td>
                      <td>{field}</td>
                      <td>{finding.valueA ?? "-"}</td>
                      <td>{finding.docBId ? docNameById.get(finding.docBId) ?? finding.docBId : "-"}</td>
                      <td>{finding.valueB ?? "-"}</td>
                      <td>{finding.notes ?? "-"}</td>
                    </tr>
                  );
                })}
              {isoFindings.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-4 text-gray-500">
                    No findings yet -- run Verify above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {!result && <p className="text-gray-500">No extraction result yet for this document.</p>}

      {result && (
        <>
          <section>
            <h2 className="mb-2 font-medium">Extracted tags ({tags.length})</h2>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="py-2">Tag type</th>
                  <th>Tag number</th>
                  <th>Page</th>
                  <th>Attributes</th>
                </tr>
              </thead>
              <tbody>
                {tags.map((tag) => (
                  <tr key={tag.id} className="border-b align-top">
                    <td className="py-2">{tag.tagType}</td>
                    <td>{tag.tagNumber}</td>
                    <td>{tag.sourcePage ?? "-"}</td>
                    <td>
                      <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(tag.attributes, null, 2)}</pre>
                    </td>
                  </tr>
                ))}
                {tags.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-4 text-gray-500">
                      No tags extracted.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          <section>
            <h2 className="mb-2 font-medium">Raw extraction result ({result.schemaVersion})</h2>
            <pre className="max-h-[600px] overflow-auto whitespace-pre-wrap rounded border p-4 text-xs">
              {JSON.stringify(result.rawJson, null, 2)}
            </pre>
          </section>
        </>
      )}
    </div>
  );
}
