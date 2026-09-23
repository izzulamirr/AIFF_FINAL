import Link from "next/link";
import { eq } from "drizzle-orm";
import { documents, extractionJobs, projects } from "@easy/db";
import { getDb } from "@/lib/db";
import { canReadOrganization } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { formatMismatch, isLibraryDocument, labelForDocument } from "@/lib/docTypes";
import { PageHeader } from "@/components/ui/PageHeader";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { Badge, EmptyState, JobStatus } from "@/components/ui/primitives";
import { IconClipboard, IconFile, IconLibrary, IconNest } from "@/components/ui/icons";
import { deleteDocument, moveDocumentToLibrary, uploadDocument } from "./actions";
import { DeleteDocumentButton } from "./DeleteDocumentButton";
import { DocumentUploadCard } from "./DocumentUploadCard";
import { LineReviewView } from "./LineReviewView";

// TWO features, the same two the dashboard offers -- hook-up, spooling and the
// container check are checks ON an ISO and live inside ISO checking, on the
// line's own page. Scoped to this one project, so neither has to be picked again
// from that page's own project selector.
const toolsFor = (id: string) => [
  {
    href: `/review?project=${id}`,
    title: "ISO checking",
    text: "Check each line: design basis, bill of material, P&ID, hook-up, spools and container fit.",
    icon: IconClipboard,
  },
  { href: `/cutting?project=${id}`, title: "Cutting Plan", text: "Nest this project's cutting-plate parts onto stock plate.", icon: IconNest },
];

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ line?: string }>;
}) {
  const { id } = await params;
  const db = getDb();

  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (!project) return <p>Project not found.</p>;

  const session = await getSessionUser();
  if (!session) return null;

  // A project URL is guessable, and this page is reached by it rather than through
  // a list that was already filtered -- so the organization is checked here. Same
  // answer for a project that does not exist and one that is not this account's:
  // which organizations exist, and who is in them, is not this page's to disclose.
  if (!(await canReadOrganization(session, project.organizationId))) return <p>Project not found.</p>;

  // A plain user sees a project as its ISO line numbers, not its documents --
  // see LineReviewView. Everything below is Document Control's, and the
  // actions behind its forms and buttons enforce that again on the server.
  if (!session.isDcc) {
    const { line } = await searchParams;
    return (
      <LineReviewView
        projectId={id}
        projectName={project.name}
        requestedLine={line}
        canMark
        links={{
          list: `/projects/${id}`,
          line: (lineNumber) => `/projects/${id}?line=${encodeURIComponent(lineNumber)}`,
          back: { href: `/projects?org=${project.organizationId}`, label: "Projects" },
          // A checker has no sidebar, so this is their only way to the library.
          library: `/library?project=${id}`,
        }}
      />
    );
  }

  const projectDocuments = await db.select().from(documents).where(eq(documents.projectId, id));
  // Split by WHERE each was uploaded, which is the rule in lib/docTypes.ts: the
  // drawings being checked are listed here, the reference they are checked
  // against is listed in the library. Both are this project's and neither is
  // hidden -- the table says how many are over there and links to them.

  // By KIND, not by stored type: a spec_sheet XLSX is the admin spec and belongs
  // here, a spec_sheet PDF is the client's and belongs in the library. Both are
  // read; only where they are LISTED differs.
  const ownDocuments = projectDocuments.filter((d) => !isLibraryDocument(d.docType, d.fileName));
  const referenceDocuments = projectDocuments.filter((d) => isLibraryDocument(d.docType, d.fileName));

  const projectJobs = await db
    .select({ job: extractionJobs })
    .from(extractionJobs)
    .innerJoin(documents, eq(documents.id, extractionJobs.documentId))
    .where(eq(documents.projectId, id));
  const jobsByDocument = new Map<string, (typeof projectJobs)[number]["job"]>();
  for (const { job } of projectJobs) {
    const existing = jobsByDocument.get(job.documentId);
    if (!existing || job.createdAt > existing.createdAt) jobsByDocument.set(job.documentId, job);
  }

  async function handleUpload(formData: FormData) {
    "use server";
    await uploadDocument(id, formData);
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={project.name}
        // Back to DASHBOARD, not to a "Projects" list. Dashboard is the only
        // deliberate way out of one project's data and back to seeing every
        // project of this client; there is no second list to go back to.
        back={{ href: "/dashboard", label: "Dashboard" }}
        meta={
          <Badge>
            {projectDocuments.length} document{projectDocuments.length === 1 ? "" : "s"}
          </Badge>
        }
        actions={
          <Link href={`/library?project=${id}`} className="btn btn-secondary">
            <IconLibrary size={16} />
            Library
          </Link>
        }
      />

      <section className="flex flex-col gap-4">
        <ul className="grid gap-4 sm:grid-cols-2">
          {toolsFor(id).map(({ href, title, text, icon: Icon }) => (
            <li key={href}>
              <Link href={href} className="card group flex h-full flex-col gap-3 transition hover:border-border-strong hover:shadow-md">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-soft text-link">
                  <Icon />
                </span>
                <p className="font-medium">{title}</p>
                <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">{text}</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* ONE full-width card, where there were two side by side.
          The P&ID Legend had a card of its own because it is a document type
          with a rule attached -- upload it first. It is reference material, so
          it moved to the library with the rest of what the checks read FROM,
          and this card is now the whole of what a project takes in: the two
          things being checked. */}
      <DocumentUploadCard action={handleUpload} libraryHref={`/library?project=${id}`} />

      <section className="card card-flush">
        <div className="card-header">
          <h2 className="card-title">Documents</h2>
          {referenceDocuments.length > 0 && (
            <Link href={`/library?project=${id}`} className="ml-auto text-[0.8125rem] font-medium text-link">
              {referenceDocuments.length} reference {referenceDocuments.length === 1 ? "document" : "documents"} in the library
            </Link>
          )}
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>File</th>
                <th>Type</th>
                <th>Pages</th>
                <th>Extraction status</th>
                <th className="w-px"></th>
              </tr>
            </thead>
            <tbody>
              {ownDocuments.map((doc) => {
                const job = jobsByDocument.get(doc.id);
                // Null for a document whose file matches its type, which is all
                // of them from now on -- uploads that do not match are refused.
                const misfiled = formatMismatch(doc.docType, doc.fileName);
                return (
                  <tr key={doc.id}>
                    <td>
                      <span className="flex items-center gap-2.5">
                        <IconFile size={16} className="flex-none text-muted-foreground" />
                        {job?.status === "succeeded" ? (
                          <Link href={`/projects/${id}/documents/${doc.id}`} className="link break-all font-medium">
                            {doc.fileName}
                          </Link>
                        ) : (
                          <span className="break-all font-medium">{doc.fileName}</span>
                        )}
                      </span>
                    </td>
                    <td>
                      {/* A document stored before the format rule existed can
                          be a type it does not fit -- a pipe spec as a PDF. Say
                          so on the row rather than leaving it looking correct,
                          since nothing downstream reads it as its type. */}
                      <Badge tone={misfiled ? "warning" : "neutral"} dot={Boolean(misfiled)} title={misfiled ?? undefined}>
                        {labelForDocument(doc.docType, doc.fileName)}
                      </Badge>
                    </td>
                    <td className="tabular-nums text-muted-foreground">{doc.pageCount ?? "-"}</td>
                    <td>
                      <JobStatus job={job} />
                    </td>
                    <td className="text-right">
                      <span className="flex items-center justify-end gap-2">
                        {misfiled && (
                          <form
                            action={async () => {
                              "use server";
                              await moveDocumentToLibrary(id, doc.id);
                            }}
                          >
                            <ConfirmButton
                              className="btn btn-secondary btn-xs"
                              // What WILL happen, in order, and what it costs.
                              // A confirmation that only restates the problem
                              // leaves the reader to guess at the consequence.
                              message={`Move ${doc.fileName} into this project's library?

${misfiled}

It will be filed under "Kept for reference". The file itself is kept; what it loses is being read -- its extracted data is removed.`}
                            >
                              <IconLibrary size={13} />
                              Move to library
                            </ConfirmButton>
                          </form>
                        )}
                        <DeleteDocumentButton
                          fileName={doc.fileName}
                          onDelete={async () => {
                            "use server";
                            await deleteDocument(id, doc.id);
                          }}
                        />
                      </span>
                    </td>
                  </tr>
                );
              })}
              {ownDocuments.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <EmptyState icon={<IconFile />} title="No documents uploaded yet">
                      Upload an ISO or an admin pipe spec above to start an extraction.
                    </EmptyState>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
