import Link from "next/link";
import { redirect } from "next/navigation";
import { asc, eq, inArray } from "drizzle-orm";
import { documents, extractionJobs, projects } from "@easy/db";
import { getSessionUser } from "@/lib/session";
import { visibleOrganizations } from "@/lib/access";
import { findLine, isoLinesOf } from "@/lib/isoLines";
import { getDb } from "@/lib/db";
import { MAX_UPLOAD_MB } from "@/lib/uploadLimits";
import { uploadDocument } from "../projects/[id]/actions";
import { deleteDocument } from "../projects/[id]/actions";
import { DeleteDocumentButton } from "../projects/[id]/DeleteDocumentButton";
import { loadHookupSheets, verifyIsoHookup, type HookupVerification } from "@/lib/hookupVerification";
import { PageHeader } from "@/components/ui/PageHeader";
import { HookupResults } from "@/components/checks/HookupResults";
import { Alert, EmptyState, JobStatus } from "@/components/ui/primitives";
import { IconFile, IconFolder, IconUpload } from "@/components/ui/icons";
import { HookupSelectors } from "./HookupSelectors";

// Instrument hook-up verification.
//
// A P&ID simplifies an instrument to a bubble and a tap -- the root valve
// that really sits between the line and the instrument is not drawn there.
// So an ISO checked only against a P&ID can be missing it and still look
// complete. The hook-up typical is the document that says what must be
// there, and this page checks the ISO against it.
//
// Only the PIPING side of each typical's discipline break is checked: the
// tubing, tube fittings and valve manifold are the instrument department's
// supply, not something a piping ISO can be held to.
//
// The verification itself is in lib/hookupVerification.ts; this page loads the
// documents, calls it, and shows the result.
export default async function HookupPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; line?: string; iso?: string; [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const session = await getSessionUser();
  if (!session) return null;
  // Document Control uploads and deletes; everyone else reads. The upload form
  // and delete buttons below only appear for Document Control -- the actions
  // they call enforce it again on the server.
  const canManage = session.isDcc;

  const db = getDb();
  // The organizations this person can read: Document Control's own, or every
  // one for a plain user (see lib/access.ts).
  const orgIds = (await visibleOrganizations(session)).map((o) => o.id);
  // Ordered so a bare /hookup always lands on the same project. An unordered
  // select lets Postgres return the rows however it likes, and the fallback
  // below is "the first one" -- the same instability that made the cutting
  // page's saved stock appear to come and go.
  const myProjects = orgIds.length
    ? await db.select().from(projects).where(inArray(projects.organizationId, orgIds)).orderBy(asc(projects.createdAt), asc(projects.id))
    : [];

  const requestedProject = params.project && myProjects.some((p) => p.id === params.project) ? params.project : undefined;
  // A plain user gets here from a project's own tiles, so the project is always
  // named in the URL and this page shows that project alone; without one they go
  // back to the start rather than land on a project they never chose. Document
  // Control arrives from the sidebar with none chosen, and gets the first plus
  // the picker. (Same rule as the spooling page.)
  if (!requestedProject && !canManage) redirect("/organizations");
  const projectId = requestedProject ?? myProjects[0]?.id;
  if (!projectId) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Instrument Hookup" />
        <div className="card">
          <EmptyState
            icon={<IconFolder />}
            title="You need a project first"
            action={
              <Link href="/projects" className="btn btn-primary btn-sm mt-1">
                Create one
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  // The ISO line this page is scoped to. A plain user reaches it from a line's
  // tools, so the line is always named; without a valid one they go back to the
  // project to choose it. Document Control can arrive with none and pick any ISO
  // in the project, as before.
  const chosenLine = params.line ? findLine(await isoLinesOf(projectId), params.line) : undefined;
  if (!chosenLine && !canManage) redirect(`/projects/${projectId}`);

  const projectDocs = await db.select().from(documents).where(eq(documents.projectId, projectId));
  const hookupDocs = projectDocs.filter((d) => d.docType === "hookup");
  const isoDocs = projectDocs.filter((d) => d.docType === "iso" && (!chosenLine || chosenLine.documentIds.includes(d.id)));

  const jobs = await db
    .select()
    .from(extractionJobs)
    .where(inArray(extractionJobs.documentId, projectDocs.length ? projectDocs.map((d) => d.id) : ["00000000-0000-0000-0000-000000000000"]));
  const latestJob = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) {
    const existing = latestJob.get(job.documentId);
    if (!existing || job.createdAt > existing.createdAt) latestJob.set(job.documentId, job);
  }

  async function handleUpload(formData: FormData) {
    "use server";
    formData.set("docType", "hookup");
    await uploadDocument(projectId!, formData);
  }

  // ---- verification -------------------------------------------------------
  const requestedIso = params.iso && isoDocs.some((d) => d.id === params.iso) ? params.iso : undefined;
  // A line carried by exactly one ISO needs no choosing: that is the one to
  // verify. Where two documents carry it (a full set beside a partial one, say)
  // the person picks.
  const isoId = requestedIso ?? (chosenLine && isoDocs.length === 1 ? isoDocs[0].id : undefined);
  const sheets = await loadHookupSheets(hookupDocs.map((d) => d.id));
  // The check itself is in lib/hookupVerification.ts, shared with a line's
  // summary so the two cannot disagree.
  const { results, isoLineNumber, lineService, serviceBasis } =
    isoId && sheets.length > 0
      ? await verifyIsoHookup({ projectDocs, sheets, isoId, chosenLineKey: chosenLine?.key })
      : { results: [] as HookupVerification["results"], isoLineNumber: null, lineService: null, serviceBasis: null };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Instrument Hookup"
        back={
          chosenLine && !canManage
            ? { href: `/projects/${projectId}?line=${encodeURIComponent(chosenLine.lineNumber)}`, label: chosenLine.lineNumber }
            : { href: `/projects/${projectId}`, label: myProjects.find((p) => p.id === projectId)?.name ?? "Project" }
        }
        description={
          <>
            A P&amp;ID simplifies an instrument to a bubble and a tap, so the valves that really sit between the line and the
            instrument &mdash; the root valve above all &mdash; never appear on it. This checks the ISO, which is the shop drawing,
            against the project&apos;s hook-up typicals so those components are visible before fabrication. Only the{" "}
            <strong>piping</strong> side of each typical&apos;s discipline break is checked; tubing, tube fittings and the valve
            manifold are the instrument department&apos;s supply.
          </>
        }
      />

      {/* A user whose line has one ISO has nothing to choose: it is verified as
          soon as they arrive. */}
      {(canManage || isoDocs.length > 1) && (
        <HookupSelectors
          projects={myProjects.map((p) => ({
            id: p.id,
            // Project names are not unique -- two "YAMAMA"s exist across orgs --
            // so a duplicated name is qualified rather than left ambiguous.
            label: myProjects.filter((o) => o.name === p.name).length > 1 ? `${p.name} (${p.id.slice(0, 8)})` : p.name,
          }))}
          projectId={projectId}
          showProject={canManage}
          line={chosenLine?.lineNumber}
          isos={isoDocs.map((d) => ({ id: d.id, label: d.fileName }))}
          isoId={isoId ?? ""}
        />
      )}

      {/* The hook-up set is not an ISO, so a user neither uploads it nor sees its
          files -- only the verification below, which they read like any result.
          The upload and delete actions enforce this again on the server. */}
      {canManage && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <form action={handleUpload} className="card flex flex-col gap-4">
            <div>
              <h2 className="card-title">Upload hook-up drawings</h2>
              <p className="card-description">
                The project&apos;s typical instrument hook-up set &mdash; one sheet per instrument type and service. Each sheet&apos;s bill of
                materials is split at the drawn &quot;BY PIPING / BY INSTR.&quot; break so only your scope is checked.
              </p>
            </div>
            <div>
              <label htmlFor="hookup-file" className="field-label">
                PDF file <span className="font-normal text-muted-foreground">(max {MAX_UPLOAD_MB} MB)</span>
              </label>
              <input id="hookup-file" type="file" name="file" accept="application/pdf" required className="input input-file" />
            </div>
            <button className="btn btn-primary self-start">
              <IconUpload size={16} />
              Upload
            </button>
          </form>

          <div className="card card-flush">
            <div className="card-header">
              <h2 className="card-title">Hook-up drawings in this project</h2>
            </div>
            <div className="table-wrap">
              <table className="table table-plain">
                <tbody>
                  {hookupDocs.map((doc) => {
                    const job = latestJob.get(doc.id);
                    return (
                      <tr key={doc.id}>
                        <td>
                          <span className="flex items-center gap-2.5">
                            <IconFile size={16} className="flex-none text-muted-foreground" />
                            <span className="break-all font-medium">{doc.fileName}</span>
                          </span>
                        </td>
                        <td>
                          <JobStatus job={job} errorMaxChars={80} />
                        </td>
                        <td className="text-right">
                          <DeleteDocumentButton
                            fileName={doc.fileName}
                            onDelete={async () => {
                              "use server";
                              await deleteDocument(projectId!, doc.id);
                            }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                  {hookupDocs.length === 0 && (
                    <tr>
                      <td colSpan={3}>
                        <EmptyState icon={<IconFile />} title="None uploaded yet" />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {sheets.length > 0 && (
              <p className="border-t px-5 py-3 text-xs text-muted-foreground">
                {sheets.length} typical{sheets.length > 1 ? "s" : ""} extracted:{" "}
                {sheets.map((s) => [s.instrumentType, s.service].filter(Boolean).join(" / ") || s.title || `sheet ${s.sheet}`).join("; ")}
              </p>
            )}
          </div>
        </div>
      )}

      {isoId && sheets.length === 0 && (
        <Alert tone="info">
          {canManage ? "Upload and extract a hook-up drawing set before verifying." : "No hook-up typicals are available for this project yet."}
        </Alert>
      )}

      {results.length > 0 && (
        <HookupResults results={results} isoLineNumber={isoLineNumber} lineService={lineService} serviceBasis={serviceBasis} />
      )}

      {isoId && results.length === 0 && sheets.length > 0 && (
        <Alert tone="info">No instruments found in that ISO&apos;s bill of material, so there is no hook-up to check.</Alert>
      )}
    </div>
  );
}
