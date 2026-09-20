import Link from "next/link";
import { eq } from "drizzle-orm";
import { documents, extractionJobs, projects } from "@easy/db";
import { getDb } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { MAX_UPLOAD_MB } from "@/lib/uploadLimits";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge, EmptyState, JobStatus } from "@/components/ui/primitives";
import { IconBox, IconFile, IconGauge, IconLibrary, IconNest, IconSpool, IconUpload } from "@/components/ui/icons";
import { deleteDocument, uploadDocument } from "./actions";
import { DeleteDocumentButton } from "./DeleteDocumentButton";
import { LineReviewView } from "./LineReviewView";

const DOC_TYPE_LABELS: Record<string, string> = {
  pid: "P&ID",
  hmb: "H&MB",
  pfd: "PFD",
  spec_sheet: "Spec Sheet",
  iso: "ISO",
  ga: "GA",
  pll: "Line List (PLL)",
  pid_legend: "P&ID Legend",
};

// Scoped to this one project, so Document Control lands on Spooling/Hookup/etc.
// already filtered to it rather than picking it again from that page's own
// project selector.
const toolsFor = (id: string) => [
  { href: `/hookup?project=${id}`, title: "Instrument Hookup", text: "Check this project's ISOs against its hook-up typicals.", icon: IconGauge },
  { href: `/spooling?project=${id}`, title: "Spooling", text: "Spools and welds read off this project's isometrics.", icon: IconSpool },
  { href: `/containers?project=${id}`, title: "Container check", text: "Whether each spool ships in a 20ft container.", icon: IconBox },
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

  // A plain user sees a project as its ISO line numbers, not its documents --
  // see LineReviewView. Everything below is Document Control's, and the
  // actions behind its forms and buttons enforce that again on the server.
  const session = await getSessionUser();
  if (!session?.isDcc) {
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
        }}
      />
    );
  }

  const projectDocuments = await db.select().from(documents).where(eq(documents.projectId, id));

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

  async function handleLegendUpload(formData: FormData) {
    "use server";
    formData.set("docType", "pid_legend");
    await uploadDocument(id, formData);
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={project.name}
        back={{ href: `/projects?org=${project.organizationId}`, label: "Projects" }}
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
        <h2 className="section-title">Review tools</h2>
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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

      <section className="grid gap-4 lg:grid-cols-2">
        <form action={handleUpload} className="card flex flex-col gap-4">
          <div>
            <h2 className="card-title">Upload a document</h2>
            <p className="card-description">Drawings and tables are read as soon as they arrive.</p>
          </div>
          <div>
            <label htmlFor="docType" className="field-label">
              Document type
            </label>
            <select id="docType" name="docType" required className="input">
              <option value="pid">P&ID</option>
              <option value="hmb">H&MB</option>
              <option value="pfd">PFD</option>
              <option value="spec_sheet">Spec Sheet</option>
              <option value="iso">ISO</option>
              <option value="ga">GA</option>
              <option value="pll">Line List (PLL)</option>
            </select>
          </div>
          <div>
            <label htmlFor="file" className="field-label">
              PDF, CSV, or XLSX file <span className="font-normal text-muted-foreground">(max {MAX_UPLOAD_MB} MB)</span>
            </label>
            <input
              id="file"
              type="file"
              name="file"
              accept="application/pdf,.csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              required
              className="input input-file"
            />
          </div>
          <button className="btn btn-primary self-start">
            <IconUpload size={16} />
            Upload
          </button>
        </form>

        <form action={handleLegendUpload} className="card flex flex-col gap-4">
          <div>
            <h2 className="card-title">Upload P&amp;ID Legend</h2>
            <p className="card-description">
              This project&apos;s symbol/abbreviation key. Upload it once per project (before other P&IDs, if possible) -- other
              P&amp;IDs in this project will read their valve/instrument symbols against it.
            </p>
          </div>
          <div className="mt-auto">
            <label htmlFor="legend-file" className="field-label">
              PDF file <span className="font-normal text-muted-foreground">(max {MAX_UPLOAD_MB} MB)</span>
            </label>
            <input id="legend-file" type="file" name="file" accept="application/pdf" required className="input input-file" />
          </div>
          <button className="btn btn-primary self-start">
            <IconUpload size={16} />
            Upload legend
          </button>
        </form>
      </section>

      <section className="card card-flush">
        <div className="card-header">
          <h2 className="card-title">Documents</h2>
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
              {projectDocuments.map((doc) => {
                const job = jobsByDocument.get(doc.id);
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
                      <Badge>{DOC_TYPE_LABELS[doc.docType] ?? doc.docType}</Badge>
                    </td>
                    <td className="tabular-nums text-muted-foreground">{doc.pageCount ?? "-"}</td>
                    <td>
                      <JobStatus job={job} />
                    </td>
                    <td className="text-right">
                      <DeleteDocumentButton
                        fileName={doc.fileName}
                        onDelete={async () => {
                          "use server";
                          await deleteDocument(id, doc.id);
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
              {projectDocuments.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <EmptyState icon={<IconFile />} title="No documents uploaded yet">
                      Upload a drawing above to start an extraction.
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
