import Link from "next/link";
import { and, eq, inArray } from "drizzle-orm";
import { documentPages, documents, extractedTags, projects } from "@easy/db";
import { currentDocuments } from "@easy/shared";
import { getDb } from "@/lib/db";
import { canReadOrganization } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { kindOfDocument } from "@/lib/docTypes";
import { extractSheetItems } from "@/lib/parseSheetPage";
import { normalizeSpecClassCode } from "@/lib/verifySpecCrossCheck";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { IconChevronRight, IconFile } from "@/components/ui/icons";

// PIPE SPECS: each piping class the client's spec defines, next to the admin item list
// that is meant to carry the same class. Opening a class shows the two side by side --
// the client's bands against the admin's lines, with every disagreement marked.
//
// Read-only, and open to anyone who can read the project: it changes nothing. The
// comparison itself is the class page (documents/[docId]/classes/[classCode]).

const CATEGORIES = ["pipes", "fittings", "flanges", "valves"] as const;
const count = (attrs: Record<string, unknown>, key: string) => (Array.isArray(attrs[key]) ? (attrs[key] as unknown[]).length : 0);
const richness = (attrs: Record<string, unknown>) => CATEGORIES.reduce((n, k) => n + count(attrs, k), 0);

export default async function ProjectSpecsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();

  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return <p>Project not found.</p>;
  const session = await getSessionUser();
  if (!session) return null;
  if (!(await canReadOrganization(session, project.organizationId))) return <p>Project not found.</p>;

  const docs = await db.select().from(documents).where(eq(documents.projectId, id));
  const specDocs = docs.filter((d) => d.docType === "spec_sheet");
  const clientDocs = currentDocuments(specDocs.filter((d) => kindOfDocument(d.docType, d.fileName)?.key === "client_spec"));
  const adminDocs = currentDocuments(specDocs.filter((d) => kindOfDocument(d.docType, d.fileName)?.key === "admin_spec"));

  // One entry per class: where the client spec has it, and how much of it was read. More
  // than one upload can hold the same class; the richer reading wins, as everywhere else.
  const clientTags = clientDocs.length
    ? await db
        .select()
        .from(extractedTags)
        .where(and(inArray(extractedTags.documentId, clientDocs.map((d) => d.id)), eq(extractedTags.tagType, "spec_class")))
    : [];
  const classes = new Map<string, { code: string; doc: (typeof clientDocs)[number]; attrs: Record<string, unknown> }>();
  for (const t of clientTags) {
    const doc = clientDocs.find((d) => d.id === t.documentId);
    if (!doc) continue;
    const attrs = t.attributes as Record<string, unknown>;
    const key = normalizeSpecClassCode(t.tagNumber);
    const existing = classes.get(key);
    if (!existing || richness(attrs) > richness(existing.attrs)) classes.set(key, { code: key, doc, attrs });
  }

  // Which admin list carries which class: read from the lines themselves (each names its
  // class), falling back to the file's own name for a list that leaves it blank.
  const linesByDoc = new Map<string, Map<string, number>>();
  if (adminDocs.length > 0) {
    const pages = await db.select().from(documentPages).where(inArray(documentPages.documentId, adminDocs.map((d) => d.id)));
    for (const doc of adminDocs) {
      const tally = new Map<string, number>();
      const stem = normalizeSpecClassCode(doc.fileName.replace(/\.[^.]+$/, ""));
      for (const page of pages.filter((p) => p.documentId === doc.id)) {
        for (const item of extractSheetItems(page.pageText)) {
          const code = item.specCode.trim() ? normalizeSpecClassCode(item.specCode) : stem;
          tally.set(code, (tally.get(code) ?? 0) + 1);
        }
      }
      linesByDoc.set(doc.id, tally);
    }
  }
  const adminFor = (code: string) => {
    let best: { doc: (typeof adminDocs)[number]; lines: number } | null = null;
    for (const doc of adminDocs) {
      const lines = linesByDoc.get(doc.id)?.get(code) ?? 0;
      if (lines > 0 && (!best || lines > best.lines || (lines === best.lines && doc.uploadedAt > best.doc.uploadedAt))) best = { doc, lines };
    }
    return best;
  };

  const rows = [...classes.values()]
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
    .map((c) => ({ ...c, admin: adminFor(c.code) }));
  const withAdmin = rows.filter((r) => r.admin).length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Pipe specs"
        back={{ href: `/projects/${id}`, label: project.name }}
        description="Each piping class in the client's spec, compared with the admin item list for the same class."
        meta={
          <>
            <Badge>{rows.length} {rows.length === 1 ? "class" : "classes"}</Badge>
            <Badge tone={withAdmin === rows.length && rows.length > 0 ? "success" : "warning"} dot>
              {withAdmin} with an admin list
            </Badge>
          </>
        }
      />

      {rows.length === 0 ? (
        <div className="card">
          <EmptyState icon={<IconFile />} title="No client spec has been read yet">
            {clientDocs.length === 0
              ? "The client's pipe spec has not been uploaded to this project's library."
              : "The client spec is uploaded but its classes have not been extracted yet."}
          </EmptyState>
        </div>
      ) : (
        <section className="card card-flush overflow-hidden">
          <div className="table-wrap">
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>Class</th>
                  <th>Client spec</th>
                  <th className="text-right">Pipe</th>
                  <th className="text-right">Fittings</th>
                  <th className="text-right">Flanges</th>
                  <th className="text-right">Valves</th>
                  <th>Admin item list</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const href = `/projects/${id}/documents/${r.doc.id}/classes/${encodeURIComponent(r.code)}${r.admin ? `?adminDocId=${r.admin.doc.id}` : ""}`;
                  return (
                    <tr key={r.code}>
                      <td className="font-mono font-semibold">{r.code}</td>
                      <td className="text-xs text-muted-foreground">{r.doc.fileName}</td>
                      {CATEGORIES.map((k) => (
                        <td key={k} className="text-right tabular-nums">
                          {count(r.attrs, k) || <span className="text-muted-foreground">-</span>}
                        </td>
                      ))}
                      <td className="text-xs">
                        {r.admin ? (
                          <>
                            {r.admin.doc.fileName} <span className="text-muted-foreground">&middot; {r.admin.lines.toLocaleString()} lines</span>
                          </>
                        ) : (
                          <Badge tone="warning">No admin list</Badge>
                        )}
                      </td>
                      <td>
                        <Link href={href} className="btn btn-secondary btn-sm" aria-label={`Compare class ${r.code}`}>
                          Compare
                          <IconChevronRight size={14} />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
