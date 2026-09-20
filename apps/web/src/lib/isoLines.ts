import { and, eq } from "drizzle-orm";
import { documents, extractedTags } from "@easy/db";
import { normalizeTagNumber } from "@easy/shared";
import { getDb } from "@/lib/db";

// A project's ISO line numbers -- what a plain user picks from, and what every
// feature page then filters to.
//
// A line number is the tag number of an ISO's `line` tag. A multi-sheet drawing
// carries one such tag per sheet, all with the same number, and the same line
// can appear in more than one document (a revision, or a full set beside a
// partial one). So a line is identified by its normalized number, and it knows
// which documents carry it.

export interface IsoLine {
  /** As printed on the drawing: what the page shows and what goes in the URL. */
  lineNumber: string;
  /** The normalized number lines are matched on. */
  key: string;
  /** The ISO documents that carry this line. */
  documentIds: string[];
  /** Sheets across those documents (one `line` tag per sheet). */
  sheets: number;
}

/** Two spellings of one line number compare equal -- the same rule the ISO pages already use to match sheets. */
export const lineKey = (raw: string) => normalizeTagNumber(raw);

export async function isoLinesOf(projectId: string): Promise<IsoLine[]> {
  const rows = await getDb()
    .select({ documentId: extractedTags.documentId, tagNumber: extractedTags.tagNumber })
    .from(extractedTags)
    .innerJoin(documents, eq(documents.id, extractedTags.documentId))
    .where(and(eq(extractedTags.projectId, projectId), eq(extractedTags.tagType, "line"), eq(documents.docType, "iso")));

  const byKey = new Map<string, IsoLine>();
  for (const row of rows) {
    const key = lineKey(row.tagNumber);
    if (!key) continue;
    const line = byKey.get(key) ?? { lineNumber: row.tagNumber.trim(), key, documentIds: [], sheets: 0 };
    if (!line.documentIds.includes(row.documentId)) line.documentIds.push(row.documentId);
    line.sheets += 1;
    byKey.set(key, line);
  }

  return [...byKey.values()].sort((a, b) => a.lineNumber.localeCompare(b.lineNumber, undefined, { numeric: true }));
}

/** The line a `?line=` value names, or undefined if this project has no such line. */
export function findLine(lines: IsoLine[], requested: string | undefined): IsoLine | undefined {
  if (!requested) return undefined;
  const key = lineKey(requested);
  return lines.find((l) => l.key === key);
}
