import Link from "next/link";
import { and, eq, inArray } from "drizzle-orm";
import { documents, extractedTags, extractionJobs, organizationMembers, projects } from "@easy/db";
import { createClient } from "@/lib/supabase/server";
import { getDb } from "@/lib/db";
import { MAX_UPLOAD_MB } from "@/lib/uploadLimits";
import { uploadDocument } from "../projects/[id]/actions";
import { deleteDocument } from "../projects/[id]/actions";
import { DeleteDocumentButton } from "../projects/[id]/DeleteDocumentButton";
import { groupHookupSheets, verifyHookup } from "@/lib/verifyHookup";
import { classifyComponent, classifyInstrument, mergeIsoLineSheets } from "@/lib/verifyIso";
import { enrichIsoLineAttrs } from "@easy/shared";
import { HookupOverride } from "./HookupOverride";
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
export default async function HookupPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; iso?: string; [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const db = getDb();
  const memberships = await db
    .select({ organizationId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, user.id));
  const orgIds = memberships.map((m) => m.organizationId);
  const myProjects = orgIds.length
    ? await db.select().from(projects).where(inArray(projects.organizationId, orgIds))
    : [];

  const projectId = params.project && myProjects.some((p) => p.id === params.project) ? params.project : myProjects[0]?.id;
  if (!projectId) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold">Instrument Hookup</h1>
        <p className="text-gray-500">
          You need a project first --{" "}
          <Link href="/projects" className="underline">
            create one
          </Link>
          .
        </p>
      </div>
    );
  }

  const projectDocs = await db.select().from(documents).where(eq(documents.projectId, projectId));
  const hookupDocs = projectDocs.filter((d) => d.docType === "hookup");
  const isoDocs = projectDocs.filter((d) => d.docType === "iso");

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
  const isoId = params.iso && isoDocs.some((d) => d.id === params.iso) ? params.iso : undefined;
  let sheets = groupHookupSheets([]);
  let results: ReturnType<typeof verifyHookup> = [];
  let isoLineNumber: string | null = null;
  let lineService: string | null = null;

  if (hookupDocs.length > 0) {
    const hookupTags = await db
      .select()
      .from(extractedTags)
      .where(and(inArray(extractedTags.documentId, hookupDocs.map((d) => d.id)), eq(extractedTags.tagType, "hookup_item")));
    sheets = groupHookupSheets(hookupTags);
  }

  if (isoId && sheets.length > 0) {
    const isoTags = await db.select().from(extractedTags).where(eq(extractedTags.documentId, isoId));
    const isoBom = isoTags.filter((t) => t.tagType === "bom_item").map((t) => t.attributes as Record<string, unknown>);
    const [line] = mergeIsoLineSheets(isoTags.filter((t) => t.tagType === "line"));
    if (line) {
      isoLineNumber = line.tagNumber;
      const attrs = enrichIsoLineAttrs(line.tagNumber, line.attributes as Record<string, unknown>);
      lineService = typeof attrs.service === "string" ? attrs.service : null;
      // The PLL states the fluid phase explicitly; prefer it over the ISO's
      // free-text service, which is a name ("HBFW") not a phase.
      const pllDocs = projectDocs.filter((d) => d.docType === "pll");
      if (pllDocs.length > 0) {
        const pllTags = await db
          .select()
          .from(extractedTags)
          .where(and(inArray(extractedTags.documentId, pllDocs.map((d) => d.id)), eq(extractedTags.tagType, "line")));
        const match = pllTags.find((t) => t.tagNumberNormalized === line.tagNumberNormalized);
        const phase = match ? (match.attributes as Record<string, unknown>).fluid_phase : null;
        if (typeof phase === "string" && phase.trim()) lineService = phase;
      }
    }

    // The ISO's own instrument entries -- BOM rows that name a measuring
    // device. classifyComponent is what decides: a control valve reads as an
    // instrument by tag ("FV-0003") but is a valve, and a valve has no
    // instrument hook-up to check.
    const isoInstruments = isoBom
      .map((row) => {
        const text = `${row.component_type ?? ""} ${row.description ?? ""}`;
        const category = classifyComponent(text);
        const label = category && classifyInstrument(text) === category ? category : null;
        if (!label) return null;
        const tag = String(row.description ?? "").match(/\b[A-Z]{2,4}-[A-Z]?\d+\b/)?.[0] ?? String(row.description ?? "").trim();
        return { tag, text };
      })
      .filter((v): v is { tag: string; text: string } => v !== null);

    const overrides: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key.startsWith("hk_") && typeof value === "string") overrides[key.slice(3)] = value;
    }
    results = verifyHookup(sheets, isoInstruments, isoBom, lineService, overrides);
  }

  const statusColor = { present: "text-green-600", missing: "text-red-600", "not checkable": "text-gray-500" } as const;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Instrument Hookup</h1>
      <p className="max-w-3xl text-sm text-gray-600">
        A P&amp;ID simplifies an instrument to a bubble and a tap, so the valves that really sit between the line and the
        instrument &mdash; the root valve above all &mdash; never appear on it. This checks the ISO, which is the shop drawing, against
        the project&apos;s hook-up typicals so those components are visible before fabrication. Only the <strong>piping</strong>{" "}
        side of
        each typical&apos;s discipline break is checked; tubing, tube fittings and the valve manifold are the instrument
        department&apos;s supply.
      </p>

      <HookupSelectors
        projects={myProjects.map((p) => ({
          id: p.id,
          // Project names are not unique -- two "YAMAMA"s exist across orgs --
          // so a duplicated name is qualified rather than left ambiguous.
          label: myProjects.filter((o) => o.name === p.name).length > 1 ? `${p.name} (${p.id.slice(0, 8)})` : p.name,
        }))}
        projectId={projectId}
        isos={isoDocs.map((d) => ({ id: d.id, label: d.fileName }))}
        isoId={isoId ?? ""}
      />

      <div className="flex flex-wrap gap-4">
        <form action={handleUpload} className="flex max-w-md flex-col gap-2 rounded border p-4">
          <p className="text-sm font-medium">Upload hook-up drawings</p>
          <p className="text-xs text-gray-500">
            The project&apos;s typical instrument hook-up set &mdash; one sheet per instrument type and service. Each sheet&apos;s bill of
            materials is split at the drawn &quot;BY PIPING / BY INSTR.&quot; break so only your scope is checked.
          </p>
          <label className="text-sm">
            PDF file (max {MAX_UPLOAD_MB} MB)
            <input type="file" name="file" accept="application/pdf" required className="mt-1 block w-full" />
          </label>
          <button className="rounded bg-black px-4 py-2 text-white">Upload</button>
        </form>

        <div className="min-w-[22rem] flex-1 rounded border p-4">
          <p className="mb-2 text-sm font-medium">Hook-up drawings in this project</p>
          <table className="w-full text-left text-sm">
            <tbody>
              {hookupDocs.map((doc) => {
                const job = latestJob.get(doc.id);
                return (
                  <tr key={doc.id} className="border-b">
                    <td className="py-1">{doc.fileName}</td>
                    <td className="text-gray-500">
                      {job?.status ?? "no job"}
                      {job?.status === "failed" && job.errorMessage ? `: ${job.errorMessage.slice(0, 80)}` : ""}
                    </td>
                    <td className="py-1 text-right">
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
                  <td className="py-2 text-gray-500">None uploaded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
          {sheets.length > 0 && (
            <p className="mt-2 text-xs text-gray-500">
              {sheets.length} typical{sheets.length > 1 ? "s" : ""} extracted:{" "}
              {sheets.map((s) => [s.instrumentType, s.service].filter(Boolean).join(" / ") || s.title || `sheet ${s.sheet}`).join("; ")}
            </p>
          )}
        </div>
      </div>

      {isoId && sheets.length === 0 && (
        <p className="text-sm text-gray-500">Upload and extract a hook-up drawing set before verifying.</p>
      )}

      {results.length > 0 && (
        <div className="flex flex-col gap-4">
          <h2 className="font-medium">
            {isoLineNumber ? (
              <>
                Line <span className="font-mono">{isoLineNumber}</span>
              </>
            ) : (
              "Selected ISO"
            )}
            <span className="ml-2 text-sm font-normal text-gray-500">
              {results.length} instrument{results.length > 1 ? "s" : ""}
              {lineService ? ` -- service ${lineService}` : ""}
            </span>
          </h2>

          {results.map((result) => (
            <div key={result.instrumentTag} className="rounded border p-4">
              <p className="mb-1 text-sm">
                <span className="font-mono">{result.instrumentTag}</span>
                <span className="ml-2 text-gray-500">{result.instrumentLabel}</span>
                {result.missingCount > 0 ? (
                  <span className="ml-2 text-red-600">
                    {result.missingCount} piping item{result.missingCount > 1 ? "s" : ""} not found on the ISO
                  </span>
                ) : result.sheet ? (
                  <span className="ml-2 text-green-600">all piping-scope items present</span>
                ) : null}
              </p>
              {result.sheet ? (
                <p className="mb-2 text-xs text-gray-500">
                  Typical: {[result.sheet.instrumentType, result.sheet.service].filter(Boolean).join(" / ") || result.sheet.title}
                  {result.sheet.sheet ? ` (sheet ${result.sheet.sheet})` : ""}
                  {result.overridden ? " -- chosen by you" : " -- matched automatically"}
                  {result.sheet.mounting ? ` | ${result.sheet.mounting}` : ""}
                  {result.sheet.slope ? ` | slope ${result.sheet.slope}` : ""}
                </p>
              ) : (
                <p className="mb-2 text-xs text-red-600">
                  No typical in this set covers a {result.measuredVariable ?? "?"} instrument
                  {result.service ? ` on ${result.service} service` : ""} -- pick one below if the set uses different wording.
                </p>
              )}

              <HookupOverride
                instrumentTag={result.instrumentTag}
                selectedKey={result.sheet?.key ?? ""}
                sheets={sheets.map((s) => ({
                  key: s.key,
                  label: [s.instrumentType, s.service].filter(Boolean).join(" / ") || s.title || `sheet ${s.sheet}`,
                }))}
              />

              {result.checks.length > 0 && (
                <table className="mt-2 w-full text-left text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="w-16 py-1">Item</th>
                      <th>Hook-up component (piping scope)</th>
                      <th className="w-28">Size</th>
                      <th className="w-16">Qty</th>
                      <th className="w-56">Found on the ISO</th>
                      <th className="w-28">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.checks.map((check, i) => (
                      <tr key={`${check.item.itemNo ?? check.item.description}-${i}`} className="border-b">
                        <td className="py-1">{check.item.itemNo ?? ""}</td>
                        <td>
                          {/* The component is named from the HOOK-UP, never
                              from the ISO. The ISO is the document under
                              audit -- taking its answer would both invert the
                              check and inherit its errors. Where the hook-up
                              defers the type, that deferral is shown as the
                              answer, because it is the answer. */}
                          {check.item.description}
                          {check.item.typeDeferredTo ? (
                            <div className="text-xs text-gray-400">
                              type not fixed by this sheet &mdash; per {check.item.typeDeferredTo}
                            </div>
                          ) : null}
                          {check.item.implied ? (
                            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                              not in the hook-up BOM
                              {check.item.deferredTo ? ` -- per ${check.item.deferredTo}` : ""}
                            </span>
                          ) : null}
                          {check.item.disciplineBasis ? (
                            <span className="ml-2 text-xs text-gray-400">({check.item.disciplineBasis})</span>
                          ) : null}
                        </td>
                        <td>
                          {check.item.size ?? "-"}
                          {check.item.sizeIndicative ? <span className="ml-1 text-xs text-gray-400">(indicative)</span> : null}
                          {check.item.sizeBasis ? <div className="text-xs text-gray-400">{check.item.sizeBasis}</div> : null}
                        </td>
                        <td>{check.item.quantity ?? "-"}</td>
                        <td className="text-xs text-gray-600">{check.isoDetail ?? "-"}</td>
                        <td className={statusColor[check.status]}>{check.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {result.sheet && result.checks.length === 0 && (
                <p className="text-xs text-gray-500">This typical places every component on the instrument side of the break -- nothing for piping to carry.</p>
              )}
            </div>
          ))}
        </div>
      )}

      {isoId && results.length === 0 && sheets.length > 0 && (
        <p className="text-sm text-gray-500">
          No instruments found in that ISO&apos;s bill of material, so there is no hook-up to check.
        </p>
      )}
    </div>
  );
}
