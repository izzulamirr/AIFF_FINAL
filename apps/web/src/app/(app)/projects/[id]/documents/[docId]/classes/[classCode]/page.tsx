import Link from "next/link";
import { and, asc, eq, inArray } from "drizzle-orm";
import { documents, documentPages, extractedTags, projects } from "@easy/db";
import { adminVariant, normalizeTagNumber, type AdminVariant } from "@easy/shared";
import { getDb } from "@/lib/db";
import { canReadOrganization } from "@/lib/access";
import { getSessionUser } from "@/lib/session";
import { extractSheetItems, combineAdminText, narrowAdminMatches, type AdminAttributeMismatch, type SheetItem } from "@/lib/parseSheetPage";
import {
  normalizeSpecClassCode,
  formatNpsInches,
  dnToNpsInches,
  DN_TO_NPS_INCHES,
  groupAdminItemsByClassRow,
  findAdminItemsUnmatchedBySize,
  mergeAdjacentClassRows,
  compareAdminItemToClientRow,
  type SpecCategory,
  type MergedClassRow,
  type AdminFieldComparison,
} from "@/lib/verifySpecCrossCheck";
import { isoSpecClasses } from "@/lib/verifyIso";
import { crossCheckBomItem, resolveBomItemSpecClass, normalizeBomSpecClass, BOM_STATUS_TONE, type BomCrossCheckResult } from "@/lib/verifyBomCrossCheck";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert, Badge, EmptyState } from "@/components/ui/primitives";
import { IconAlert, IconChevronDown, IconFile } from "@/components/ui/icons";
import { recheckClassAction } from "./actions";
import { AdminMatchesTable, type AdminMatchRow } from "./AdminMatchesTable";

// Ported from the sibling AIFF_LATEST project -- checking a client spec_sheet's
// extracted piping classes against the company's own admin item-list export
// and an ISO's own bill of material. All of the matching logic lives in
// lib/verifySpecCrossCheck.ts, lib/verifyBomCrossCheck.ts and
// lib/parseSheetPage.ts and is unchanged from the sibling project. This page's
// markup was restyled onto this repo's own primitives and made compact, and the
// access guard below was added -- the source page predates this repo's
// canReadOrganization convention and had no membership check of its own.
//
// A line's own MTO card (LineReviewView) runs the same BOM cross-check for a
// whole line without picking documents; this page is the per-class view, for
// reading the client spec's bands against the admin list line by line.

const CATEGORY_CONFIG: Array<{ key: SpecCategory; label: string }> = [
  { key: "pipes", label: "Pipe" },
  { key: "fittings", label: "Fittings" },
  { key: "flanges", label: "Flanges" },
  { key: "valves", label: "Valves" },
];

const SIZING_LEGEND = Object.entries(DN_TO_NPS_INCHES)
  .map(([mm, inches]) => ({ mm: Number(mm), inches }))
  .sort((a, b) => a.mm - b.mm);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The admin lines under ONE client band, resolved and ready to render.
//
// The comparison is a purely visual reviewer aid -- this app's cross-check
// logic (see verifySpecCrossCheck.ts's module comment) deliberately dropped
// free-text material/description comparison as a verdict driver because it
// produced false failures unrelated to real spec discrepancies, so nothing
// here reintroduces one. All comparison happens server-side, here;
// AdminMatchesTable only filters, groups and renders what it is given.
//
// `variant` is what lets 90 / 45 degree elbows, eccentric / concentric
// reducers and straight / reduced tees be told apart -- see
// packages/shared/src/specVariants.ts.
function buildAdminRows(
  items: SheetItem[],
  category: SpecCategory,
  client: MergedClassRow,
  pipeRows: Array<Record<string, unknown>>
): AdminMatchRow[] {
  return items.map((item) => {
    const inches = dnToNpsInches(item.sizeP1);
    const adminSize = { mm: item.sizeP1 ? `${item.sizeP1} mm` : "-", inch: inches == null ? "" : formatNpsInches(inches) };
    const fields = compareAdminItemToClientRow(item, category, client, adminSize, pipeRows);
    return {
      reference: item.reference,
      fields,
      description: combineAdminText(item),
      hasMismatch: fields.some((f) => f.verdict === "differs"),
      variant: adminVariant(item),
    };
  });
}

// Admin lines whose type genuinely matches something in this class/category
// but whose OWN size falls outside every declared band's range (see
// findAdminItemsUnmatchedBySize) -- these never land in adminGroups at all,
// so without a dedicated row they were invisible. One extra row PER TYPE (not
// one per whole category -- confirmed on a real class where lumping every
// unmatched flange line together mixed unrelated types like Spectacle blind
// and Gasket into one undifferentiated block under a misleading single
// heading). Every line is flagged a Size mismatch: there is no single client
// row to compare Schedule/End Type/Standard against, so those stay "unknown"
// rather than guessing one.
function buildUnmatchedRows(items: SheetItem[], typeLabel: string): AdminMatchRow[] {
  return items.map((item) => {
    const inches = dnToNpsInches(item.sizeP1);
    const adminSize = item.sizeP1 ? `${inches == null ? "" : `${formatNpsInches(inches)}" `}(${item.sizeP1} mm)` : "-";
    const fields: AdminFieldComparison[] = [
      { field: "Size", adminValue: adminSize, clientValue: `not covered by any "${typeLabel}" row`, verdict: "differs" },
      { field: "Material", adminValue: "-", clientValue: "-", verdict: "unknown" },
      { field: "Schedule / Class", adminValue: "-", clientValue: "-", verdict: "unknown" },
      { field: "End Type", adminValue: "-", clientValue: "-", verdict: "unknown" },
      { field: "Standard", adminValue: "-", clientValue: "-", verdict: "unknown" },
    ];
    return { reference: item.reference, fields, description: combineAdminText(item), hasMismatch: true, variant: adminVariant(item) };
  });
}

/** Per-variant counts, in display order -- what the summary chips show. */
function variantTally(rows: AdminMatchRow[]): Array<{ variant: AdminVariant; n: number; bad: number }> {
  const byKey = new Map<string, { variant: AdminVariant; n: number; bad: number }>();
  for (const r of rows) {
    if (!r.variant) continue;
    const entry = byKey.get(r.variant.key) ?? { variant: r.variant, n: 0, bad: 0 };
    entry.n += 1;
    if (r.hasMismatch) entry.bad += 1;
    byKey.set(r.variant.key, entry);
  }
  return [...byKey.values()].sort((a, b) => a.variant.order - b.variant.order);
}

// What sits in a band's last column: a one-line SUMMARY of its admin lines --
// how many, split by variant where there is one, and whether they agree --
// with the lines themselves one click inside. It used to print the first
// line's description truncated, which said nothing about the other thirty.
function AdminCell({ rows, adminSelected }: { rows: AdminMatchRow[]; adminSelected: boolean }) {
  if (!adminSelected) return <span className="text-xs text-muted-foreground">-</span>;
  if (rows.length === 0) return <Badge>No admin match</Badge>;

  const mismatches = rows.filter((r) => r.hasMismatch).length;
  const tally = variantTally(rows);
  const split = tally.length > 1;

  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-1.5 text-xs [&::-webkit-details-marker]:hidden">
        {split ? (
          tally.map(({ variant, n, bad }) => (
            <Badge key={variant.key} tone={bad > 0 ? "danger" : "neutral"} title={bad > 0 ? `${plural(bad, "mismatch", "mismatches")}` : undefined}>
              {variant.label} <span className="tabular-nums">{n}</span>
            </Badge>
          ))
        ) : (
          <Badge>{plural(rows.length, "admin line")}</Badge>
        )}
        {mismatches === 0 ? (
          <Badge tone="success" dot>
            No mismatches
          </Badge>
        ) : (
          !split && (
            <Badge tone="danger" dot>
              {plural(mismatches, "mismatch", "mismatches")}
            </Badge>
          )
        )}
        <IconChevronDown size={14} className="flex-none text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <AdminMatchesTable rows={rows} />
    </details>
  );
}

// A merged band collapses several of a category's own source rows (see
// mergeAdjacentClassRows) into one displayed row -- its admin matches are
// the union of every source row's own matches, deduped by reference (an
// admin item can only land on more than one source row when its own size
// range genuinely spans several of them, e.g. a combined "8-12" column).
function collectMatches(groups: Map<string, SheetItem[]>, category: SpecCategory, rowIndices: number[]): SheetItem[] {
  const seen = new Set<SheetItem>();
  const out: SheetItem[] = [];
  for (const index of rowIndices) {
    for (const item of groups.get(`${category}:${index}`) ?? []) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

export default async function ClassDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; docId: string; classCode: string }>;
  searchParams: Promise<{ adminDocId?: string; isoDocId?: string; bomSpec?: string }>;
}) {
  const { id: projectId, docId, classCode } = await params;
  const { adminDocId, isoDocId, bomSpec } = await searchParams;
  const db = getDb();

  const session = await getSessionUser();
  if (!session) return null;

  // Same guard as this document's own page: an account reads the
  // organizations it is a member of and no others, and this page is reached
  // by a typed URL as easily as by a link.
  const [project] = await db.select({ organizationId: projects.organizationId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project || !(await canReadOrganization(session, project.organizationId))) return <p>Document not found.</p>;

  // A spec sheet is never an ISO, and a checker only reads ISO documents
  // (see the document page's own rule) -- this page is Document Control's.
  if (!session.isDcc) return <p>Not found.</p>;

  const [document] = await db.select().from(documents).where(eq(documents.id, docId)).limit(1);
  if (!document || document.projectId !== projectId) return <p>Document not found.</p>;
  if (document.docType !== "spec_sheet") return <p>Not a spec sheet document.</p>;

  const specClassTags = await db
    .select()
    .from(extractedTags)
    .where(and(eq(extractedTags.documentId, docId), eq(extractedTags.tagType, "spec_class")));
  const wantedCode = normalizeSpecClassCode(classCode);
  const classTag = specClassTags.find((t) => normalizeSpecClassCode(t.tagNumber) === wantedCode);
  if (!classTag) return <p>Class &quot;{classCode}&quot; not found in this document.</p>;

  const attrs = classTag.attributes as Record<string, unknown>;

  const siblings = await db.select().from(documents).where(eq(documents.projectId, projectId));
  const adminOptions = siblings.filter((d) => d.id !== docId && d.docType === "spec_sheet" && d.fileName.toLowerCase().endsWith(".xlsx"));

  const adminItems: SheetItem[] = [];
  if (adminDocId) {
    const adminPages = await db.select().from(documentPages).where(eq(documentPages.documentId, adminDocId)).orderBy(asc(documentPages.pageNumber));
    for (const p of adminPages) adminItems.push(...extractSheetItems(p.pageText));
  }
  const adminGroups = adminDocId ? groupAdminItemsByClassRow(classTag.tagNumber, attrs, adminItems) : new Map<string, SheetItem[]>();
  const unmatchedBySize = adminDocId ? findAdminItemsUnmatchedBySize(classTag.tagNumber, attrs, adminItems) : [];

  // BOM cross-check: an ISO drawing's own Bill of Material vs this same
  // class's client spec -- and, when the selected spec matches THIS page's own
  // class, the SAME admin-confirmed rows adminGroups above already resolved.
  // See verifyBomCrossCheck.ts's module comment for why classification reads
  // free text rather than trusting component_type alone, and CategoryHint's own
  // comment (verifySpecCrossCheck.ts) for why it reuses that exact matching
  // logic instead of re-solving the same Tee/Reducer, Blind/Spectacle,
  // Flange/Orifice collisions a second time.
  interface BomRow {
    itemNo: string;
    componentType: string;
    size: string;
    quantity: string;
    description: string;
    result: BomCrossCheckResult;
    // The actual matched admin item lines (not just whether any exist) --
    // shown as their own real text (RTEXT+XTEXT, see combineAdminText) so a
    // reviewer sees WHAT confirmed the BOM line, not just a bare yes/no.
    adminMatches: SheetItem[] | null;
    // Attributes the BOM states that the admin group contradicts -- see
    // narrowAdminMatches. Empty when they agree or the admin sheet is silent.
    adminMismatches: AdminAttributeMismatch[];
  }
  // One block per ISO SHEET, same "divide by sheet" pattern this project's
  // own ISO document page uses for its "BOM by spec, per sheet" view (see
  // lib/isoChecks.ts's bomBySpec) -- a multi-sheet drawing carries a
  // separate BOM per sheet, so cross-checking them lumped together as one
  // flat list hid which sheet a mismatch was actually on.
  interface BomSheetGroup {
    lineNumber: string;
    sheetLabel: string;
    page: number | null;
    rows: BomRow[];
  }
  const isoOptions = siblings.filter((d) => d.docType === "iso");
  let bomAvailableSpecs: string[] = [];
  let selectedBomSpec: string | null = null;
  let bomBySheet: BomSheetGroup[] = [];
  if (isoDocId) {
    const isoLineTags = await db.select().from(extractedTags).where(and(eq(extractedTags.documentId, isoDocId), eq(extractedTags.tagType, "line")));
    const isoBomTags = await db.select().from(extractedTags).where(and(eq(extractedTags.documentId, isoDocId), eq(extractedTags.tagType, "bom_item")));

    // A single BOM can carry 2-3 different classes (a spec break along the
    // run) -- collect every class ANY of this ISO's lines reference, not
    // just the title-block one, so the selector covers all of them.
    const specSet = new Set<string>();
    for (const line of isoLineTags) for (const cls of isoSpecClasses(line.attributes as Record<string, unknown>)) specSet.add(cls);
    bomAvailableSpecs = [...specSet];

    selectedBomSpec =
      bomSpec && bomAvailableSpecs.includes(bomSpec)
        ? bomSpec
        : (bomAvailableSpecs.find((s) => normalizeBomSpecClass(s) === wantedCode) ?? bomAvailableSpecs[0] ?? null);

    if (selectedBomSpec) {
      const normalizedSelected = normalizeBomSpecClass(selectedBomSpec);

      // A multi-spec BOM can reference a class defined in a DIFFERENT
      // spec_sheet document than this page's own (e.g. this page is
      // AC03N1's document, but the BOM's spec break also touches BC70N,
      // extracted from a sibling document) -- resolved project-wide, only
      // when actually needed, rather than assuming it's always this page's
      // own class.
      let clientClass: Record<string, unknown> | undefined;
      if (normalizedSelected === wantedCode) {
        clientClass = attrs;
      } else {
        const allSpecClassTags = await db
          .select()
          .from(extractedTags)
          .where(and(inArray(extractedTags.documentId, siblings.map((d) => d.id)), eq(extractedTags.tagType, "spec_class")));
        clientClass = allSpecClassTags.find((t) => normalizeSpecClassCode(t.tagNumber) === normalizedSelected)?.attributes as Record<string, unknown> | undefined;
      }

      bomBySheet = [...isoLineTags]
        .sort((a, b) => (a.sourcePage ?? 0) - (b.sourcePage ?? 0))
        .map((line) => {
          const lineAttrs = line.attributes as Record<string, unknown>;
          const norm = normalizeTagNumber(line.tagNumber);

          const rows = isoBomTags
            .filter((tag) => {
              // Scope to this sheet -- a bom_item's own sourcePage is the
              // page its sheet was extracted from, same field the ISO
              // document's own per-sheet BOM view keys off of.
              if (line.sourcePage != null && tag.sourcePage !== line.sourcePage) return false;
              const ln = (tag.attributes as Record<string, unknown>).line_number;
              return typeof ln === "string" && normalizeTagNumber(ln) === norm;
            })
            .map((tag) => {
              const item = tag.attributes as Record<string, unknown>;
              const itemClass = resolveBomItemSpecClass(item, lineAttrs);
              if (normalizeBomSpecClass(itemClass) !== normalizedSelected) return null;

              const result = crossCheckBomItem(item, clientClass);
              const adminNarrowing =
                normalizedSelected === wantedCode && adminDocId && result.matchedCategory != null && result.matchedRowIndex != null
                  ? narrowAdminMatches(adminGroups.get(`${result.matchedCategory}:${result.matchedRowIndex}`) ?? [], item)
                  : null;

              return {
                itemNo: tag.tagNumber,
                componentType: String(item.component_type ?? "-"),
                size: String(item.size ?? "-"),
                quantity: String(item.quantity ?? "-"),
                description: String(item.description ?? "-"),
                result,
                adminMatches: adminNarrowing?.matches ?? null,
                adminMismatches: adminNarrowing?.mismatches ?? [],
              };
            })
            .filter((r): r is BomRow => r !== null);

          if (rows.length === 0) return null;
          const sheetLabel = typeof lineAttrs.sheet === "string" && lineAttrs.sheet ? lineAttrs.sheet : line.sourcePage != null ? `page ${line.sourcePage}` : "";
          return { lineNumber: line.tagNumber, sheetLabel, page: line.sourcePage, rows };
        })
        .filter((v): v is BomSheetGroup => v !== null);
    }
  }

  const headerLine = [
    attrs.service,
    attrs.material,
    attrs.asme_class ? `CL ${attrs.asme_class}${attrs.flange_facing ? ` ${attrs.flange_facing}` : ""}` : null,
    attrs.design_code,
  ]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(" · ");
  const maxPressure = typeof attrs.max_pressure === "string" && attrs.max_pressure ? attrs.max_pressure : "-";
  const tempRange = typeof attrs.temp_range === "string" && attrs.temp_range ? attrs.temp_range : "-";
  const ends = typeof attrs.ends === "string" && attrs.ends ? attrs.ends : "-";

  const warnings = [
    ...((attrs.band_validation_issues as string[] | undefined) ?? []),
    ...((attrs.notes_validation_issues as string[] | undefined) ?? []),
  ];

  const isoFileName = isoOptions.find((d) => d.id === isoDocId)?.fileName;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={<span className="break-all">Class Detail: {classTag.tagNumber}</span>}
        back={{ href: `/projects/${projectId}/documents/${docId}`, label: "Back to spec sheet" }}
        description={headerLine || undefined}
        meta={
          <>
            <Badge>Max pressure {maxPressure}</Badge>
            <Badge>Temp range {tempRange}</Badge>
            <Badge>Ends {ends}</Badge>
          </>
        }
      />

      {warnings.length > 0 && (
        <details className="card card-flush card-warning group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <span className="flex items-center gap-2">
              <IconAlert size={16} />
              {plural(warnings.length, "extraction warning")} &mdash; re-verify against the source page
            </span>
            <IconChevronDown size={16} className="flex-none transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t p-4">
            <form action={recheckClassAction.bind(null, docId, classTag.tagNumber)} className="flex flex-wrap items-center gap-3">
              <button className="btn btn-secondary btn-sm">Recheck extracted data</button>
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                Re-sorts every category into true ascending size order and re-runs the overlap/notes checks on that corrected data. No AI
                call &mdash; gap checks against the source page still need a full re-extraction.
              </p>
            </form>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        </details>
      )}

      {/* The two documents this page compares against, in ONE row. It was two
          cards with a form each, every one carrying hidden fields to preserve
          the other's choice; one form with both selects says the same in a
          third of the height. Applying resets the class pick in the BOM check
          below, which is what choosing a different ISO should do anyway. */}
      <section className="card card-flush">
        <form className="flex flex-wrap items-end gap-3 p-4">
          <div className="min-w-[15rem] flex-1">
            <label htmlFor="adminDocId" className="field-label">
              Admin item list <span className="font-normal text-muted-foreground">(.xlsx) &middot; compared with each band below</span>
            </label>
            <select id="adminDocId" name="adminDocId" defaultValue={adminDocId ?? ""} className="input input-sm">
              <option value="">None</option>
              {adminOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.fileName}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[15rem] flex-1">
            <label htmlFor="isoDocId" className="field-label">
              ISO drawing <span className="font-normal text-muted-foreground">(.pdf) &middot; its BOM is checked against this class</span>
            </label>
            <select id="isoDocId" name="isoDocId" defaultValue={isoDocId ?? ""} className="input input-sm">
              <option value="">None</option>
              {isoOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.fileName}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary btn-sm">Apply</button>
        </form>
        {(adminOptions.length === 0 || isoOptions.length === 0) && (
          <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
            {adminOptions.length === 0 && "No admin item list (.xlsx) has been uploaded to this project yet. "}
            {isoOptions.length === 0 && "No ISO drawing has been uploaded to this project yet."}
          </p>
        )}
      </section>

      <details className="card card-flush group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
          <span>
            Sizing legend <span className="font-normal text-muted-foreground">&middot; NPS &harr; DN</span>
          </span>
          <IconChevronDown size={16} className="flex-none text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        {/* A grid of pairs, not a two-column table: 41 rows down the page is
            the whole viewport for a reference nobody reads top to bottom. */}
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(6.75rem,1fr))] gap-x-5 gap-y-1 border-t px-4 py-3 text-xs tabular-nums">
          {SIZING_LEGEND.map(({ mm, inches }) => (
            <li key={mm} className="flex items-baseline justify-between gap-2 border-b border-dashed pb-0.5">
              <span className="font-medium">{formatNpsInches(inches)}&quot;</span>
              <span className="text-muted-foreground">DN{mm}</span>
            </li>
          ))}
        </ul>
      </details>

      {isoDocId && (
        <section className="card card-flush">
          <div className="card-header">
            <div className="min-w-0">
              <h2 className="card-title">BOM check</h2>
              <p className="card-description break-all">
                {isoFileName ? `${isoFileName} — ` : ""}checked against this class&apos;s client spec
                {adminDocId ? ", and the admin lines that confirm each match" : ""}.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-3 p-4">
            {bomAvailableSpecs.length === 0 && <p className="text-sm text-muted-foreground">This drawing has no line/BOM data extracted.</p>}

            {bomAvailableSpecs.length > 0 && (
              <>
                {bomAvailableSpecs.length > 1 && (
                  <Alert tone="warning">
                    This drawing&apos;s BOM spans {bomAvailableSpecs.length} classes (a spec break along the run) &mdash; pick which one to
                    check below.
                  </Alert>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {bomAvailableSpecs.map((spec) => (
                    <Link
                      key={spec}
                      href={`?adminDocId=${encodeURIComponent(adminDocId ?? "")}&isoDocId=${encodeURIComponent(isoDocId)}&bomSpec=${encodeURIComponent(spec)}`}
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
                        spec === selectedBomSpec ? "border-transparent bg-primary-soft text-link" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      }`}
                    >
                      {spec}
                      {normalizeBomSpecClass(spec) === wantedCode ? " (this class)" : ""}
                    </Link>
                  ))}
                </div>

                {normalizeBomSpecClass(selectedBomSpec ?? "") !== wantedCode && (
                  <p className="text-xs text-link">
                    Checking against class &quot;{selectedBomSpec}&quot;&apos;s own client spec. Admin-confirmed detail isn&apos;t shown here
                    &mdash; open that class&apos;s own page and load an admin list to see it.
                  </p>
                )}

                {bomBySheet.length === 0 && (
                  <p className="text-sm text-muted-foreground">No BOM items resolved to spec &quot;{selectedBomSpec}&quot; on this drawing.</p>
                )}

                {bomBySheet.map(({ lineNumber, sheetLabel, page, rows }) => (
                  <div key={`${lineNumber}-${page ?? sheetLabel}`} className="overflow-hidden rounded-lg border">
                    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b bg-muted/50 px-3 py-1.5 text-xs">
                      <p className="font-medium">
                        Sheet {sheetLabel || "?"} <span className="font-normal text-muted-foreground">&middot; line</span>{" "}
                        <span className="font-mono font-normal">{lineNumber}</span>
                      </p>
                      <span className="tabular-nums text-muted-foreground">{plural(rows.length, "item")}</span>
                    </div>
                    <div className="table-wrap">
                      <table className="table table-compact text-xs">
                        <thead>
                          <tr>
                            <th>Item</th>
                            <th>Type</th>
                            <th>Size</th>
                            <th>Qty</th>
                            <th>Description</th>
                            <th>Client spec</th>
                            <th>Admin</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row, i) => (
                            <tr key={i}>
                              <td className="whitespace-nowrap font-mono">{row.itemNo}</td>
                              <td className="text-muted-foreground">{row.componentType}</td>
                              <td className="whitespace-nowrap">{row.size}</td>
                              <td className="tabular-nums">{row.quantity}</td>
                              <td className="max-w-xs text-muted-foreground">{row.description}</td>
                              <td className="max-w-xs">
                                {/* Status in the badge (a short word); the matched client
                                    spec text -- a whole clause, sometimes a whole sentence
                                    -- as ordinary wrapped text below it. A badge is
                                    `white-space: nowrap`, so a long description inside one
                                    doesn't wrap, it overflows past the column and over
                                    whatever sits next to it. */}
                                <Badge tone={BOM_STATUS_TONE[row.result.status]}>{row.result.label}</Badge>
                                {row.result.clientDescription && (
                                  <p className="mt-1 text-muted-foreground">
                                    {row.result.clientDescription}
                                    {row.result.clientSize ? ` (${row.result.clientSize})` : ""}
                                  </p>
                                )}
                              </td>
                              <td className="max-w-xs">
                                {row.adminMatches == null ? (
                                  <span className="text-muted-foreground">-</span>
                                ) : row.adminMatches.length > 0 ? (
                                  <>
                                    <span className={row.adminMismatches.length > 0 ? "text-warning" : "text-success"}>
                                      {row.adminMatches.map((m) => combineAdminText(m)).join("; ")}
                                    </span>
                                    {row.adminMismatches.map((m) => (
                                      <div key={m.attribute} className="mt-1 font-medium text-danger">
                                        {m.attribute} differs &mdash; BOM says {m.wanted}, admin sheet has only {m.found.join(" / ")}
                                      </div>
                                    ))}
                                  </>
                                ) : (
                                  <span className="text-danger">No admin line</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </section>
      )}

      {CATEGORY_CONFIG.map(({ key, label }) => {
        const rows = (attrs[key] as Array<Record<string, unknown>> | undefined) ?? [];
        if (rows.length === 0) return null;
        const bands = mergeAdjacentClassRows(key, rows);
        const pipeRows = (attrs.pipes as Array<Record<string, unknown>> | undefined) ?? [];

        // Resolved once per band, up here, so the card's own header can total
        // them -- how many admin lines this category holds and how many of them
        // disagree -- without a second pass over the same comparison.
        const bandRows = bands.map((band) => buildAdminRows(collectMatches(adminGroups, key, band.rowIndices), key, band, pipeRows));
        const unmatched = unmatchedBySize
          .filter((g) => g.category === key)
          .sort((a, b) => a.typeLabel.localeCompare(b.typeLabel))
          .map((g) => ({ typeLabel: g.typeLabel, rows: buildUnmatchedRows(g.items, g.typeLabel) }));
        const allRows = [...bandRows.flat(), ...unmatched.flatMap((u) => u.rows)];
        const mismatchTotal = allRows.filter((r) => r.hasMismatch).length;

        return (
          <section key={key} className="card card-flush">
            <div className="card-header">
              <h2 className="card-title">
                {label} <span className="font-normal text-muted-foreground">({bands.length})</span>
              </h2>
              {adminDocId && (
                <span className="ml-auto flex flex-wrap items-center gap-1.5">
                  <Badge>{plural(allRows.length, "admin line")}</Badge>
                  {mismatchTotal > 0 && (
                    <Badge tone="danger" dot>
                      {plural(mismatchTotal, "mismatch", "mismatches")}
                    </Badge>
                  )}
                </span>
              )}
            </div>
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Size</th>
                    <th>End</th>
                    <th>Class / Sch.</th>
                    <th>Client spec</th>
                    <th className="border-l">Admin item list</th>
                  </tr>
                </thead>
                <tbody>
                  {bands.map((band, i) => (
                    <tr key={i}>
                      <td className="whitespace-nowrap font-medium">{band.type}</td>
                      <td className="whitespace-nowrap tabular-nums">{band.size}</td>
                      <td className="whitespace-nowrap">{band.endType}</td>
                      <td className="text-xs text-muted-foreground">{band.classRating}</td>
                      <td className="max-w-md text-xs text-muted-foreground">{band.description}</td>
                      <td className="border-l">
                        <AdminCell rows={bandRows[i]} adminSelected={Boolean(adminDocId)} />
                      </td>
                    </tr>
                  ))}
                  {unmatched.map(({ typeLabel, rows: unmatchedRows }) => (
                    <tr key={typeLabel} className="bg-danger-soft/40">
                      <td className="text-muted-foreground" colSpan={5}>
                        <span className="font-medium text-foreground">{typeLabel}</span> &mdash; admin lines outside every size band
                      </td>
                      <td className="border-l">
                        <AdminCell rows={unmatchedRows} adminSelected />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      {CATEGORY_CONFIG.every(({ key }) => !((attrs[key] as unknown[] | undefined) ?? []).length) && (
        <div className="card">
          <EmptyState icon={<IconFile />} title="Nothing extracted for this class">
            Re-run this document&apos;s extraction, or check the source page directly.
          </EmptyState>
        </div>
      )}
    </div>
  );
}
