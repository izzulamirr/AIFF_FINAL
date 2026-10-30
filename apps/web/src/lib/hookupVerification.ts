import { and, eq, inArray } from "drizzle-orm";
import { documents, extractedTags } from "@easy/db";
import { currentDocuments, enrichIsoLineAttrs } from "@easy/shared";
import { getDb } from "@/lib/db";
import { fluidPhaseOf, groupHookupSheets, verifyHookup } from "@/lib/verifyHookup";
import { classifyComponent, classifyInstrument, isoBomRowText, mergeIsoLineSheets } from "@/lib/verifyIso";
import { lineKey } from "@/lib/isoLines";

// Instrument hook-up verification: the ISO checked against the project's
// hook-up typicals.
//
// A P&ID simplifies an instrument to a bubble and a tap -- the root valve
// that really sits between the line and the instrument is not drawn there.
// So an ISO checked only against a P&ID can be missing it and still look
// complete. The hook-up typical is the document that says what must be
// there, and this checks the ISO against it.
//
// Only the PIPING side of each typical's discipline break is checked: the
// tubing, tube fittings and valve manifold are the instrument department's
// supply, not something a piping ISO can be held to.
//
// Lived inside the hook-up page until a line's summary needed the same answer;
// it is here so the page and the summary read one computation and cannot drift.

type DocumentRow = typeof documents.$inferSelect;
export type HookupSheets = ReturnType<typeof groupHookupSheets>;

/** The project's hook-up typicals, read from its hook-up drawings. */
export async function loadHookupSheets(hookupDocIds: string[]): Promise<HookupSheets> {
  if (hookupDocIds.length === 0) return groupHookupSheets([]);
  const hookupTags = await getDb()
    .select()
    .from(extractedTags)
    .where(and(inArray(extractedTags.documentId, hookupDocIds), eq(extractedTags.tagType, "hookup_item")));
  return groupHookupSheets(hookupTags);
}

export interface HookupVerification {
  results: ReturnType<typeof verifyHookup>;
  isoLineNumber: string | null;
  lineService: string | null;
  /** How a service CODE was turned into a phase, so the auto-match is auditable. */
  serviceBasis: string | null;
  /** Page -> the sheet its title block prints ("4 of 5", "4/5"). */
  sheetByPage: Record<number, string>;
}

/**
 * Verify one ISO document. `chosenLineKey` picks which line to verify when the
 * document holds more than one; without it, the first.
 */
export async function verifyIsoHookup({
  projectDocs,
  sheets,
  isoId,
  chosenLineKey,
}: {
  projectDocs: DocumentRow[];
  sheets: HookupSheets;
  isoId: string;
  chosenLineKey?: string;
}): Promise<HookupVerification> {
  const db = getDb();
  let isoLineNumber: string | null = null;
  let lineService: string | null = null;
  let serviceBasis: string | null = null;

  const isoTags = await db.select().from(extractedTags).where(eq(extractedTags.documentId, isoId));
  const isoBom = isoTags.filter((t) => t.tagType === "bom_item").map((t) => t.attributes as Record<string, unknown>);
  const lineTags = mergeIsoLineSheets(isoTags.filter((t) => t.tagType === "line"));
  // A document can hold more than one line; verify the chosen one.
  const line = (chosenLineKey ? lineTags.find((t) => lineKey(t.tagNumber) === chosenLineKey) : undefined) ?? lineTags[0];
  if (line) {
    isoLineNumber = line.tagNumber;
    const attrs = enrichIsoLineAttrs(line.tagNumber, line.attributes as Record<string, unknown>);
    lineService = typeof attrs.service === "string" ? attrs.service : null;
    // The PLL states the fluid phase explicitly; prefer it over the ISO's
    // free-text service, which is a name ("HBFW") not a phase.
    const pllDocs = currentDocuments(projectDocs.filter((d) => d.docType === "pll"));
    if (pllDocs.length > 0) {
      const pllTags = await db
        .select()
        .from(extractedTags)
        .where(and(inArray(extractedTags.documentId, pllDocs.map((d) => d.id)), eq(extractedTags.tagType, "line")));
      const match = pllTags.find((t) => t.tagNumberNormalized === line.tagNumberNormalized);
      const phase = match ? (match.attributes as Record<string, unknown>).fluid_phase : null;
      if (typeof phase === "string" && phase.trim()) lineService = phase;
    }

    // Still a CODE rather than a phase? The P&ID legend defines what the
    // code means ("CRD -- CRUDE OIL"), and crude oil is a liquid service.
    // Expanding it here is what lets the right typical be chosen without
    // asking: the hook-up set is indexed by phase, and no amount of
    // matching on "crd" will ever reach a sheet headed "LIQUID SERVICE".
    if (lineService && !fluidPhaseOf(lineService)) {
      const legendDocs = currentDocuments(projectDocs.filter((d) => d.docType === "pid_legend"));
      if (legendDocs.length > 0) {
        const newest = [...legendDocs].sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())[0];
        const codes = await db
          .select()
          .from(extractedTags)
          .where(and(eq(extractedTags.documentId, newest.id), eq(extractedTags.tagType, "legend_item")));
        const wanted = lineService.trim().toUpperCase();
        const hit = codes.find(
          (t) => (t.attributes as Record<string, unknown>).category === "service_code" && t.tagNumber.trim().toUpperCase() === wanted
        );
        const phase = hit ? fluidPhaseOf((hit.attributes as Record<string, unknown>).meaning) : null;
        if (phase) {
          serviceBasis = `${wanted} = ${String((hit!.attributes as Record<string, unknown>).meaning)} (P&ID legend) -- ${phase} service`;
          lineService = phase;
        }
      }
    }
  }

  // The ISO's own instrument entries -- BOM rows that name a measuring
  // device. classifyComponent is what decides: a control valve reads as an
  // instrument by tag ("FV-0003") but is a valve, and a valve has no
  // instrument hook-up to check.
  const isoInstruments = isoTags
    .filter((t) => t.tagType === "bom_item")
    .map((t) => {
      const row = t.attributes as Record<string, unknown>;
      // isoBomRowText restores the hyphen on a bare tag ("FT0003" -> "FT-0003"), which is how an
      // ISO prints it and the only form the instrument classifier decodes.
      const text = isoBomRowText(row);
      const category = classifyComponent(text);
      const label = category && classifyInstrument(text) === category ? category : null;
      if (!label) return null;
      const tag = text.toUpperCase().match(/\b[A-Z]{2,4}-[A-Z]?\d+\b/)?.[0] ?? String(row.description ?? "").trim();
      return { tag, text, page: t.sourcePage };
    })
    .filter((v): v is { tag: string; text: string; page: number | null } => v !== null);

  // The sheet each page prints in its title block, so an instrument can be
  // reported as "sheet 4" rather than as a page of the PDF.
  const sheetByPage: Record<number, string> = {};
  for (const t of isoTags) {
    const sheet = (t.attributes as Record<string, unknown>).sheet;
    if (t.tagType === "line" && t.sourcePage != null && typeof sheet === "string" && sheet.trim()) sheetByPage[t.sourcePage] = sheet.trim();
  }

  return { results: verifyHookup(sheets, isoInstruments, isoBom, lineService), isoLineNumber, lineService, serviceBasis, sheetByPage };
}
