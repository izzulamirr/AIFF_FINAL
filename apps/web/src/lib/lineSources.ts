import { eq, inArray } from "drizzle-orm";
import { documentPages, documents, extractedTags, extractionJobs } from "@easy/db";
import { compareRevisions, currentDocuments, documentFamily, revisionFromFileName } from "@easy/shared";
import { getDb } from "@/lib/db";
import { kindOfDocument } from "@/lib/docTypes";
import { lineKey, type IsoLine } from "@/lib/isoLines";

// What a line's check is BASED ON -- every document its checks read -- and whether
// any of it has changed since a checker marked the line done.
//
// The ISO's own revision was the only thing tracked before, so a "Done" stayed
// green while the P&ID went from D to E or a new line list arrived. Now the whole
// basis is recorded with the check (line_reviews.basis), and a later version of
// ANY of it puts the line back to re-check.
//
// Drawings are compared by WHICH DOCUMENT is in force, never by their extracted
// contents: each P&ID is read by AI separately, and two readings of an unchanged
// sheet differ in wording. A table row is different -- the line list is checked
// field by field -- so where a new line list has replaced the old one, this
// line's row is compared too, and an upload that leaves the row alone is not a
// reason to look again.

export type SourceKind = "iso" | "pid" | "pll" | "admin_spec" | "client_spec" | "hookup" | "legend";

/** In the order a reviewer thinks of them. The admin item list is not tracked (see sourcesOfLines). */
export const SOURCE_KINDS: SourceKind[] = ["iso", "pid", "pll", "client_spec", "hookup", "legend"];

export const SOURCE_LABEL: Record<SourceKind, string> = {
  iso: "ISO drawing",
  pid: "P&ID",
  pll: "Line list",
  admin_spec: "Pipe spec (item list)",
  client_spec: "Pipe spec (client)",
  hookup: "Instrument hook-up",
  legend: "P&ID legend",
};

/** One document a check was based on, as it stood. Stored as JSON, so dates are strings. */
export interface LineSource {
  kind: SourceKind;
  documentId: string;
  fileName: string;
  revision: string | null;
  uploadedAt: string;
  /** Line list only: this line's row, reduced to the fields the checks compare. */
  row?: string | null;
  /**
   * Earlier revisions of this same document that it has replaced, oldest first --
   * so a line nobody has checked yet can still say "D was issued and never
   * checked; E is current". Not part of what a check is compared on.
   */
  earlier?: Array<{ documentId: string; fileName: string; revision: string | null; uploadedAt: string }>;
}

export type SourceStatus =
  | "same" // the document checked against is still the one in force
  | "sameRow" // a newer line list, but this line's row in it is unchanged
  | "updated" // replaced by a later revision or upload
  | "rowChanged" // a newer line list, and this line's row in it differs
  | "new" // a document that applies now and did not then (a P&ID newly carrying the line)
  | "gone" // no longer in force, and nothing replaced it
  | "updatedSince"; // no record of what was checked, but this was uploaded AFTER the check

export interface SourceComparison {
  kind: SourceKind;
  status: SourceStatus;
  /** As checked. Null for a source that is new since. */
  was: LineSource | null;
  /** In force now. Null for a source that is gone. */
  now: LineSource | null;
}

/** Statuses that mean the check no longer stands. */
export const CHANGED: ReadonlySet<SourceStatus> = new Set(["updated", "rowChanged", "new", "gone", "updatedSince"]);

// The line-list fields the ISO is checked against. Anything else in the row (a
// remark, a P&ID number) changing is not a reason to re-check the ISO.
const PLL_FIELDS = [
  "spec_class",
  "size",
  "design_pressure",
  "design_temperature",
  "operating_pressure",
  "operating_temperature",
  "test_pressure",
  "insulation_code",
  "insulation_thickness",
  "heat_trace",
  "paint_system",
  "ndt_percent",
  "pwht",
] as const;

// Case and spacing are how two readings of one cell most often differ, so they are
// not a change.
const rowOf = (attrs: Record<string, unknown>) =>
  PLL_FIELDS.map((k) => `${k}=${String(attrs[k] ?? "").replace(/\s+/g, "").toUpperCase()}`).join("|");

// "AC03N", "AC03N-P", "ac03n" -> AC03N.
const classCode = (value: unknown) => /^[A-Z]{2}\d{2}[A-Z]?/.exec(String(value ?? "").trim().toUpperCase())?.[0] ?? null;

/**
 * The sources of each of these lines as things stand now, keyed by line key.
 * Batched: one pass over the project's documents serves every line.
 */
export async function sourcesOfLines(projectId: string, lines: IsoLine[]): Promise<Map<string, LineSource[]>> {
  const out = new Map<string, LineSource[]>();
  if (lines.length === 0) return out;
  const db = getDb();

  const docs = await db.select().from(documents).where(eq(documents.projectId, projectId));
  const docById = new Map(docs.map((d) => [d.id, d]));
  const jobs = docs.length
    ? await db
        .select({ documentId: extractionJobs.documentId, status: extractionJobs.status, createdAt: extractionJobs.createdAt })
        .from(extractionJobs)
        .where(inArray(extractionJobs.documentId, docs.map((d) => d.id)))
    : [];
  const latest = new Map<string, (typeof jobs)[number]>();
  for (const j of jobs) {
    const seen = latest.get(j.documentId);
    if (!seen || j.createdAt > seen.createdAt) latest.set(j.documentId, j);
  }
  // Only what has been read can have been checked against. A newer upload still
  // being read leaves the one before it in force until it is done.
  const read = docs.filter((d) => latest.get(d.id)?.status === "succeeded" && d.docType !== "iso");
  const current = currentDocuments(read);
  const kindOf = (d: (typeof docs)[number]) => kindOfDocument(d.docType, d.fileName)?.key;
  const pids = current.filter((d) => d.docType === "pid");
  const plls = current.filter((d) => d.docType === "pll");
  const clientSpecs = current.filter((d) => d.docType === "spec_sheet" && kindOf(d) === "client_spec");
  const hookups = current.filter((d) => d.docType === "hookup");
  const legends = current.filter((d) => d.docType === "pid_legend");

  const isoIds = [...new Set(lines.flatMap((l) => l.documentIds))];
  // Every read hook-up, earlier uploads included: their REV is read off their rows.
  const readHookups = read.filter((d) => d.docType === "hookup");

  // A line list states its revision once, in its header ("REVISION B"), not per
  // row -- so it is read off the sheet's text, for every upload of it.
  const readPlls = read.filter((d) => d.docType === "pll");
  const pllPages = readPlls.length
    ? await db
        .select({ documentId: documentPages.documentId, pageNumber: documentPages.pageNumber, pageText: documentPages.pageText })
        .from(documentPages)
        .where(inArray(documentPages.documentId, readPlls.map((d) => d.id)))
    : [];
  const pllRevisionOf = new Map<string, string>();
  for (const p of [...pllPages].sort((a, b) => a.pageNumber - b.pageNumber)) {
    if (pllRevisionOf.has(p.documentId)) continue;
    const m = /\bREVISION\s*[:.]?\s*([A-Z]{1,2}|\d{1,2})\b/.exec(p.pageText ?? "");
    if (m) pllRevisionOf.set(p.documentId, m[1].toUpperCase());
  }
  const tagDocIds = [...pids, ...plls, ...clientSpecs, ...readHookups].map((d) => d.id).concat(isoIds);
  const tags = tagDocIds.length
    ? await db
        .select({ documentId: extractedTags.documentId, tagType: extractedTags.tagType, tagNumber: extractedTags.tagNumber, attributes: extractedTags.attributes })
        .from(extractedTags)
        .where(inArray(extractedTags.documentId, tagDocIds))
    : [];
  const tagsOf = new Map<string, typeof tags>();
  for (const t of tags) tagsOf.set(t.documentId, [...(tagsOf.get(t.documentId) ?? []), t]);
  const attrs = (t: (typeof tags)[number]) => (t.attributes ?? {}) as Record<string, unknown>;

  const revisionOf = (d: (typeof docs)[number]) => d.revision?.trim() || revisionFromFileName(d.fileName)?.revision || null;
  // The uploads a current document replaced: same family, read, not this one.
  const earlierOf = (d: (typeof docs)[number]) =>
    read
      .filter((o) => o.id !== d.id && documentFamily(o.docType, o.fileName) === documentFamily(d.docType, d.fileName) && o.uploadedAt < d.uploadedAt)
      .sort((a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime())
      .map((o) => ({ documentId: o.id, fileName: o.fileName, revision: revisionOf(o), uploadedAt: o.uploadedAt.toISOString() }));
  const source = (kind: SourceKind, d: (typeof docs)[number], extra: Partial<LineSource> = {}): LineSource => ({
    kind,
    documentId: d.id,
    fileName: d.fileName,
    revision: revisionOf(d),
    uploadedAt: d.uploadedAt.toISOString(),
    earlier: earlierOf(d),
    ...extra,
  });

  // The REV printed on a hook-up set's sheets, where its read rows agree on one;
  // "A" -- a first issue -- where nothing was read.
  const hookupRevision = (docId: string) => {
    const revs = new Set(
      (tagsOf.get(docId) ?? []).map((t) => String(attrs(t).revision ?? "").trim().toUpperCase()).filter((r) => r && r !== "-")
    );
    return revs.size === 1 ? [...revs][0] : "A";
  };
  // The latest of a set of revisions (E over D); null where none can be ordered.
  const highestRevision = (revs: Array<string | null>) =>
    revs.filter((r): r is string => Boolean(r)).reduce<string | null>((best, r) => (best === null || (compareRevisions(r, best) ?? 0) > 0 ? r : best), null);

  for (const line of lines) {
    const list: LineSource[] = [];

    for (const drawing of line.current) {
      const d = docById.get(drawing.documentId);
      // An ISO revision is a new file under a new name, so its earlier revisions
      // are the line's superseded drawings, not the file's family.
      const earlier = line.superseded.map((s) => ({ documentId: s.documentId, fileName: s.fileName, revision: s.revision, uploadedAt: s.uploadedAt.toISOString() }));
      if (d) list.push(source("iso", d, { revision: drawing.revision, earlier }));
    }

    // The P&IDs that actually carry this line -- not every P&ID in the project.
    for (const d of pids) {
      if ((tagsOf.get(d.id) ?? []).some((t) => t.tagType === "line" && lineKey(t.tagNumber) === line.key)) list.push(source("pid", d));
    }

    for (const d of plls) {
      const row = (tagsOf.get(d.id) ?? []).find((t) => t.tagType === "line" && lineKey(t.tagNumber) === line.key);
      if (row) {
        const earlier = earlierOf(d).map((e) => ({ ...e, revision: e.revision ?? pllRevisionOf.get(e.documentId) ?? null }));
        list.push(source("pll", d, { row: rowOf(attrs(row)), revision: revisionOf(d) ?? pllRevisionOf.get(d.id) ?? null, earlier }));
      }
    }

    // The piping classes this line runs in, spec breaks included.
    const isoTags = line.documentIds.flatMap((id) => tagsOf.get(id) ?? []);
    const classes = new Set<string>();
    for (const t of isoTags) {
      if (t.tagType !== "line" || lineKey(t.tagNumber) !== line.key) continue;
      const a = attrs(t);
      const main = classCode(a.spec_class);
      if (main) classes.add(main);
      for (const b of Array.isArray(a.spec_breaks) ? (a.spec_breaks as Array<Record<string, unknown>>) : []) {
        const c = classCode(b?.spec_class);
        if (c) classes.add(c);
      }
    }
    // The admin item list is not tracked per line: Document Control decided it
    // is not one of the documents a line's check is re-done for.
    for (const d of clientSpecs) {
      if ((tagsOf.get(d.id) ?? []).some((t) => t.tagType === "spec_class" && classes.has(classCode(t.tagNumber) ?? ""))) list.push(source("client_spec", d));
    }

    // The hook-up set and the P&ID legend are the project's, so every line is
    // checked against them -- an up-rev of either applies to all lines alike.
    // The hook-up carries the REV read off its own sheets (A where none was read);
    // the legend is issued with the P&IDs, so it is at the revision of the P&ID
    // this line is on.
    for (const d of hookups) {
      const earlier = earlierOf(d).map((e) => ({ ...e, revision: e.revision ?? hookupRevision(e.documentId) }));
      list.push(source("hookup", d, { revision: revisionOf(d) ?? hookupRevision(d.id), earlier }));
    }
    const pidSources = list.filter((s) => s.kind === "pid");
    const pidRev = highestRevision(pidSources.map((s) => s.revision));
    // The legend is issued with the P&IDs, so its history is theirs: the earlier
    // revisions of the P&ID that sets its revision stand as its own.
    const pidEarlier = pidSources.find((s) => s.revision === pidRev)?.earlier ?? [];
    for (const d of legends) list.push(source("legend", d, { revision: revisionOf(d) ?? pidRev, earlier: revisionOf(d) ? earlierOf(d) : pidEarlier }));

    out.set(line.key, list);
  }
  return out;
}

// Two uploads of one document share a family (see documentFamily), so D and E of a
// P&ID pair up as "updated" rather than as one gone and one new. A line's ISO
// drawings are compared as a set: a revision is a new file under a new name.
const keyOf = (s: LineSource) => (s.kind === "iso" ? "iso" : `${s.kind}|${documentFamily(s.kind, s.fileName)}`);

/**
 * What the check was based on, against what is in force now, one entry per
 * source.
 *
 * Null `recorded` is a check made before sources were tracked. There is no list
 * to compare, but there is a date: anything the line depends on that was
 * uploaded AFTER it was marked done cannot have been looked at, so it is reported
 * as `updatedSince`. That is what lets an up-rev P&ID flag every done line on it,
 * old checks included.
 */
export function compareSources(recorded: LineSource[] | null, current: LineSource[], checkedAt?: Date): SourceComparison[] {
  if (!recorded) {
    if (!checkedAt) return [];
    return legendFollowsPid(
      current
        .filter((s) => new Date(s.uploadedAt) > checkedAt)
        .map((s): SourceComparison => ({ kind: s.kind, status: "updatedSince", was: null, now: s }))
        .sort((a, b) => SOURCE_KINDS.indexOf(a.kind) - SOURCE_KINDS.indexOf(b.kind)),
      current
    );
  }
  const group = (list: LineSource[]) => {
    const m = new Map<string, LineSource[]>();
    for (const s of list) m.set(keyOf(s), [...(m.get(keyOf(s)) ?? []), s]);
    return m;
  };
  // A check recorded while the admin item list was still tracked carries it; it
  // is no longer one of the sources, so it is left out rather than read as gone.
  const was = group(recorded.filter((s) => SOURCE_KINDS.includes(s.kind)));
  const now = group(current);

  const result: SourceComparison[] = [];
  for (const key of new Set([...was.keys(), ...now.keys()])) {
    const w = was.get(key) ?? [];
    const n = now.get(key) ?? [];
    const kind = (w[0] ?? n[0]).kind;
    let status: SourceStatus;
    // A document that applies now but was not recorded with the check. If it was
    // already in force when the line was checked -- the hook-up and legend, now
    // counted for every line, on a line checked before they were -- it has not
    // changed since, and is not a reason to look again.
    if (w.length === 0) status = checkedAt && n.every((s) => new Date(s.uploadedAt) <= checkedAt) ? "same" : "new";
    else if (n.length === 0) status = "gone";
    else {
      const sameDocs = w.map((s) => s.documentId).sort().join() === n.map((s) => s.documentId).sort().join();
      if (sameDocs) status = "same";
      else if (kind === "pll") status = w[0].row != null && w[0].row === n[0].row ? "sameRow" : "rowChanged";
      else status = "updated";
    }
    result.push({ kind, status, was: w[0] ?? null, now: n[0] ?? null });
  }
  return legendFollowsPid(
    result.sort((a, b) => SOURCE_KINDS.indexOf(a.kind) - SOURCE_KINDS.indexOf(b.kind)),
    current
  );
}

// THE LEGEND MOVES WITH THE P&ID. It is issued as part of the P&ID set, so when the
// P&ID a line is on goes up a revision the legend has too, even where the same
// legend file is still in force -- it is reported as updated alongside the P&ID,
// D -> E. A legend re-issued on its own is already caught by its own comparison.
function legendFollowsPid(result: SourceComparison[], current: LineSource[]): SourceComparison[] {
  const pidMove = result.find((c) => c.kind === "pid" && CHANGED.has(c.status));
  if (!pidMove) return result;
  const fromRev = pidMove.was?.revision ?? null;
  const out = result.map((c) =>
    c.kind === "legend" && !CHANGED.has(c.status) && c.now
      ? { ...c, status: "updated" as const, was: { ...(c.was ?? c.now), revision: fromRev } }
      : c
  );
  // A legend not in the comparison at all (an old check that never recorded one)
  // still moves with the P&ID.
  if (!out.some((c) => c.kind === "legend")) {
    const legend = current.find((s) => s.kind === "legend");
    if (legend) out.push({ kind: "legend", status: pidMove.status, was: pidMove.was ? { ...legend, revision: fromRev } : null, now: legend });
  }
  return out.sort((a, b) => SOURCE_KINDS.indexOf(a.kind) - SOURCE_KINDS.indexOf(b.kind));
}

/** "P&ID updated · Line list row changed" -- the reason a line needs re-checking, in a few words. */
export function changeSummary(comparisons: SourceComparison[]): string {
  const phrases = comparisons
    .filter((c) => CHANGED.has(c.status))
    .map((c) => {
      const label = SOURCE_LABEL[c.kind];
      if (c.status === "rowChanged") return "Line list row changed";
      if (c.status === "new") return `New ${label}`;
      if (c.status === "gone") return `${label} removed`;
      if (c.status === "updatedSince") return c.now?.revision ? `${label} Rev ${c.now.revision} issued since` : `${label} updated since`;
      if (c.kind === "iso" && c.now?.revision) return `ISO now Rev ${c.now.revision}`;
      if (c.now?.revision) return `${label} now Rev ${c.now.revision}`;
      return `${label} updated`;
    });
  return [...new Set(phrases)].join(" · ");
}
