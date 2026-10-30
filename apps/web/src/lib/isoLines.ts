import { and, eq } from "drizzle-orm";
import { documents, extractedTags } from "@easy/db";
import { normalizeRevision, normalizeTagNumber, resolveRevisions, type DocumentRevision, type KnownRevisions } from "@easy/shared";
import { getDb } from "@/lib/db";

// A project's ISO line numbers -- what a plain user picks from, and what every
// feature page then filters to.
//
// A line number is the tag number of an ISO's `line` tag. A multi-sheet drawing
// carries one such tag per sheet, all with the same number, and the same line
// can appear in more than one document -- a REVISION, or a full set beside a
// partial one. So a line is identified by its normalized number, and it knows
// which documents carry it.
//
// REVISIONS. `documentIds` is the CURRENT revision only. That is the one seam
// every feature page filters through (spooling, containers, hookup, and the line
// summary all do `line.documentIds.includes(doc.id)`), so superseding a drawing
// here removes its spools, welds and BOM from all of them at once, without any
// of those pages knowing revisions exist. Superseded drawings are kept in
// `superseded` and are still openable -- nothing is deleted.
//
// Which drawing is current comes from the REV PRINTED IN ITS TITLE BLOCK, which
// the ISO extraction already reads. See @easy/shared/revisions for the ordering
// and, more importantly, for when it refuses to order at all.

/** One drawing carrying a line, with the revision printed on it. */
export interface LineDrawing extends DocumentRevision {
  fileName: string;
  /** `line` tags on this drawing -- one per sheet. */
  sheets: number;
}

export interface IsoLine {
  /** As printed on the drawing: what the page shows and what goes in the URL. */
  lineNumber: string;
  /** The normalized number lines are matched on. */
  key: string;
  /** The ISO documents carrying the CURRENT revision of this line. */
  documentIds: string[];
  /** Those same drawings in full -- file name, upload date, revision. */
  current: LineDrawing[];
  /** Sheets across those documents (one `line` tag per sheet). */
  sheets: number;
  /** The revision in force, as printed. Null when it could not be read or ordered. */
  revision: string | null;
  /** Replaced by a later revision -- kept, openable, and excluded from every check. */
  superseded: LineDrawing[];
  /** False when the drawings could not be ordered, so everything is being shown. */
  revisionKnown: boolean;
}

/** Two spellings of one line number compare equal -- the same rule the ISO pages already use to match sheets. */
export const lineKey = (raw: string) => normalizeTagNumber(raw);

/**
 * The revision one DRAWING is at.
 *
 * A drawing's sheets all carry the same REV, so the sheets should agree. Where
 * they do not, one of them was misread and there is no way to tell which -- so
 * the drawing's revision is unknown, which leaves it current rather than letting
 * a misread sheet supersede a drawing that is still in force.
 */
function revisionOfDrawing(sheetRevisions: Array<string | null>): string | null {
  const distinct = new Set(sheetRevisions.map(normalizeRevision));
  return distinct.size === 1 ? [...distinct][0] : null;
}

export async function isoLinesOf(projectId: string): Promise<IsoLine[]> {
  const rows = await getDb()
    .select({
      documentId: extractedTags.documentId,
      tagNumber: extractedTags.tagNumber,
      attributes: extractedTags.attributes,
      fileName: documents.fileName,
      uploadedAt: documents.uploadedAt,
    })
    .from(extractedTags)
    .innerJoin(documents, eq(documents.id, extractedTags.documentId))
    .where(and(eq(extractedTags.projectId, projectId), eq(extractedTags.tagType, "line"), eq(documents.docType, "iso")));

  // line key -> document id -> what that drawing says, one entry per sheet.
  interface Draft {
    lineNumber: string;
    drawings: Map<string, { fileName: string; uploadedAt: Date; sheetRevisions: Array<string | null> }>;
  }
  const byKey = new Map<string, Draft>();

  for (const row of rows) {
    const key = lineKey(row.tagNumber);
    if (!key) continue;

    const draft = byKey.get(key) ?? { lineNumber: row.tagNumber.trim(), drawings: new Map() };
    const drawing = draft.drawings.get(row.documentId) ?? {
      fileName: row.fileName,
      uploadedAt: row.uploadedAt,
      sheetRevisions: [] as Array<string | null>,
    };

    const revision = (row.attributes as Record<string, unknown> | null)?.revision;
    drawing.sheetRevisions.push(typeof revision === "string" ? revision : null);

    draft.drawings.set(row.documentId, drawing);
    byKey.set(key, draft);
  }

  const lines: IsoLine[] = [];
  for (const [key, draft] of byKey) {
    const drawings: LineDrawing[] = [...draft.drawings].map(([documentId, d]) => ({
      documentId,
      fileName: d.fileName,
      uploadedAt: d.uploadedAt,
      sheets: d.sheetRevisions.length,
      revision: revisionOfDrawing(d.sheetRevisions),
    }));

    const resolved = resolveRevisions(drawings);
    const isCurrent = new Set(resolved.current.map((d) => d.documentId));
    const current = drawings.filter((d) => isCurrent.has(d.documentId));

    lines.push({
      lineNumber: draft.lineNumber,
      key,
      documentIds: current.map((d) => d.documentId),
      current,
      sheets: current.reduce((n, d) => n + d.sheets, 0),
      revision: resolved.revision,
      superseded: drawings.filter((d) => !isCurrent.has(d.documentId)).sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime()),
      revisionKnown: resolved.decidedBy !== null,
    });
  }

  return lines.sort((a, b) => a.lineNumber.localeCompare(b.lineNumber, undefined, { numeric: true }));
}

/**
 * Every ISO document's revision and whether it is still in force, from the REV
 * printed on the drawing -- the form `resolveDocumentVersions` takes, so ISOs sit
 * in the same revision tracking as every other document. A drawing is superseded
 * only if it is superseded on every line it carries.
 */
export async function isoVersionsOf(projectId: string): Promise<KnownRevisions> {
  const known: KnownRevisions = new Map();
  for (const line of await isoLinesOf(projectId)) {
    for (const [drawings, current] of [[line.current, true], [line.superseded, false]] as const) {
      for (const d of drawings) {
        const seen = known.get(d.documentId);
        known.set(d.documentId, {
          revision: d.revision,
          current: current || Boolean(seen?.current),
          supersededBy: current ? null : (seen?.supersededBy ?? line.current[0]?.documentId ?? null),
        });
      }
    }
  }
  return known;
}

/** The line a `?line=` value names, or undefined if this project has no such line. */
export function findLine(lines: IsoLine[], requested: string | undefined): IsoLine | undefined {
  if (!requested) return undefined;
  const key = lineKey(requested);
  return lines.find((l) => l.key === key);
}
