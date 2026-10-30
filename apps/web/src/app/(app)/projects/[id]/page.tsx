import Link from "next/link";
import { eq } from "drizzle-orm";
import { documents, extractionJobs, projects } from "@easy/db";
import { resolveDocumentVersions } from "@easy/shared";
import { getDb } from "@/lib/db";
import { canReadOrganization } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { isoVersionsOf } from "@/lib/isoLines";
import { formatMismatch, isLibraryDocument, labelForDocument } from "@/lib/docTypes";
import { PageHeader } from "@/components/ui/PageHeader";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { Badge, EmptyState, JobStatus } from "@/components/ui/primitives";
import { IconBox, IconClipboard, IconCompare, IconFile, IconGauge, IconLibrary, IconNest, IconSpool, IconSupport, IconTable } from "@/components/ui/icons";
import { deleteDocument, moveDocumentToLibrary, uploadDocument } from "./actions";
import { DeleteDocumentButton } from "./DeleteDocumentButton";
import { DocumentUploadCard } from "./DocumentUploadCard";
import { LineReviewView } from "./LineReviewView";
import { ProjectHub } from "./ProjectHub";

// Every feature as a standalone tool, scoped to this one project. This page is
// Document Control's (a checker gets ProjectHub instead), so hook-up, spooling,
// the container check and pipe supports are reachable here across the WHOLE
// project, not only one line at a time from inside ISO checking -- which still
// shows them per line as well. P&ID compare is this project's alone: it reads
// two of the project's own P&IDs.
const toolsFor = (id: string) => [
  {
    href: `/review?project=${id}`,
    title: "ISO checking",
    text: "Check each line: design basis, bill of material, P&ID, hook-up, spools, container fit and pipe supports.",
    icon: IconClipboard,
  },
  // The same page a checker opens from the project hub's "Pipe specs" card.
  {
    href: `/projects/${id}/specs`,
    title: "Pipe specs",
    text: "Compare the client's piping classes with the admin item list, size by size, with every difference marked.",
    icon: IconTable,
  },
  {
    href: `/hookup?project=${id}`,
    title: "Instrument hook-up",
    text: "Every instrument on the project's ISOs, checked against the hook-up typicals.",
    icon: IconGauge,
  },
  {
    href: `/spooling?project=${id}`,
    title: "Spooling",
    text: "The spools and welds read off every ISO in the project, sheet by sheet.",
    icon: IconSpool,
  },
  {
    href: `/containers?project=${id}`,
    title: "Container check",
    text: "Whether each spool in the project ships in a 20ft container.",
    icon: IconBox,
  },
  {
    href: `/supports?project=${id}`,
    title: "Pipe supports",
    text: "Check each ISO's pipe supports: the BOM's count against the spans the pipe needs between them.",
    icon: IconSupport,
  },
  { href: `/cutting?project=${id}`, title: "Cutting Plan", text: "Nest this project's cutting-plate parts onto stock plate.", icon: IconNest },
  {
    href: `/projects/${id}/pid-compare`,
    title: "P&ID compare",
    text: "Pick an earlier P&ID and the latest one to see every line, valve and instrument that changed.",
    icon: IconCompare,
  },
];

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ line?: string; feature?: string; sort?: string; dir?: string; rev?: string; pid?: string }>;
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

  // A plain user sees a project as three things to do -- ISO checking, pipe specs, cutting
  // plate -- and picks one (see ProjectHub). ISO checking is its line numbers, and is what
  // a link to a single line opens. Everything below is Document Control's, and the actions
  // behind its forms and buttons enforce that again on the server.
  if (!session.isDcc) {
    const { line, feature, rev, pid } = await searchParams;
    if (!line && feature !== "iso") return <ProjectHub projectId={id} projectName={project.name} libraryHref={`/library?project=${id}`} />;
    return (
      <LineReviewView
        projectId={id}
        projectName={project.name}
        requestedLine={line}
        requestedDrawing={rev}
        requestedPid={pid}
        canMark
        links={{
          list: `/projects/${id}?feature=iso`,
          line: (lineNumber) => `/projects/${id}?feature=iso&line=${encodeURIComponent(lineNumber)}`,
          back: { href: `/projects/${id}`, label: project.name },
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
  const referenceDocuments = projectDocuments.filter((d) => isLibraryDocument(d.docType, d.fileName));

  // Sorted by a column header link (?sort=type|file&dir=asc|desc). By the type
  // as the table SHOWS it, so the order matches the badges read down the page;
  // ties fall back to the file name so a group reads in a stable order.
  const { sort, dir } = await searchParams;
  const sortKey = sort === "type" || sort === "file" ? sort : null;
  const descending = dir === "desc";
  const byName = (a: (typeof projectDocuments)[number], b: (typeof projectDocuments)[number]) =>
    a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: "base" });
  const ownDocuments = projectDocuments.filter((d) => !isLibraryDocument(d.docType, d.fileName));
  if (sortKey) {
    ownDocuments.sort((a, b) => {
      const order =
        sortKey === "type"
          ? labelForDocument(a.docType, a.fileName).localeCompare(labelForDocument(b.docType, b.fileName)) || byName(a, b)
          : byName(a, b);
      return descending ? -order : order;
    });
  }
  // Clicking the column already sorted by flips it; any other column starts ascending.
  const sortHref = (key: "type" | "file") =>
    `/projects/${id}?sort=${key}${sortKey === key && !descending ? "&dir=desc" : ""}#documents`;
  const sortMark = (key: "type" | "file") => (sortKey === key ? (descending ? " ↓" : " ↑") : "");

  // Revision tracking, for every kind of document: an upload that a later one has
  // replaced is not a row of its own but sits under the one in force, as a
  // dropdown. An ISO is ordered by the REV on the drawing, anything else by the
  // revision in its file name or, failing that, by upload date.
  const versions = resolveDocumentVersions(projectDocuments, await isoVersionsOf(id));
  const ownIds = new Set(ownDocuments.map((d) => d.id));
  const earlierOf = new Map<string, typeof ownDocuments>();
  const tableDocuments = ownDocuments.filter((d) => {
    const v = versions.get(d.id);
    // Kept as a row of its own if what replaced it is not in this table.
    if (!v || v.current || !v.supersededBy || !ownIds.has(v.supersededBy)) return true;
    earlierOf.set(v.supersededBy, [...(earlierOf.get(v.supersededBy) ?? []), d]);
    return false;
  });
  for (const list of earlierOf.values()) list.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
  const day = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });
  const revisionBadge = (docId: string) => {
    const v = versions.get(docId);
    if (!v) return null;
    if (v.revision) {
      return (
        <Badge tone={v.current ? "info" : "neutral"} title={v.current ? "Revision in force" : "Superseded by a later revision"}>
          Rev {v.revision}
        </Badge>
      );
    }
    if (v.orderedBy === "upload date" && v.current) return <Badge title="The newest upload of this document">Latest</Badge>;
    return null;
  };

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
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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

      <section id="documents" className="card card-flush scroll-mt-20">
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
                <th aria-sort={sortKey === "file" ? (descending ? "descending" : "ascending") : undefined}>
                  <Link href={sortHref("file")} className="hover:text-foreground" title="Sort by file name">
                    File{sortMark("file")}
                  </Link>
                </th>
                <th aria-sort={sortKey === "type" ? (descending ? "descending" : "ascending") : undefined}>
                  <Link href={sortHref("type")} className="hover:text-foreground" title="Sort by type of document">
                    Type{sortMark("type")}
                  </Link>
                </th>
                <th>Pages</th>
                <th>Extraction status</th>
                <th className="w-px"></th>
              </tr>
            </thead>
            <tbody>
              {tableDocuments.map((doc) => {
                const job = jobsByDocument.get(doc.id);
                const earlier = earlierOf.get(doc.id) ?? [];
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
                        {revisionBadge(doc.id)}
                      </span>
                      {earlier.length > 0 && (
                        <details className="mt-2 text-[0.8125rem]">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                            Earlier revisions ({earlier.length})
                          </summary>
                          <ul className="mt-2 flex flex-col gap-2 border-l border-border pl-3">
                            {earlier.map((old) => (
                              <li key={old.id} className="flex flex-wrap items-center gap-2">
                                {jobsByDocument.get(old.id)?.status === "succeeded" ? (
                                  <Link href={`/projects/${id}/documents/${old.id}`} className="link break-all">
                                    {old.fileName}
                                  </Link>
                                ) : (
                                  <span className="break-all">{old.fileName}</span>
                                )}
                                {revisionBadge(old.id)}
                                <span className="text-muted-foreground">{day.format(old.uploadedAt)}</span>
                                <DeleteDocumentButton
                                  fileName={old.fileName}
                                  onDelete={async () => {
                                    "use server";
                                    await deleteDocument(id, old.id);
                                  }}
                                />
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
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
              {tableDocuments.length === 0 && (
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
