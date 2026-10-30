// Which drawing of a line is the CURRENT one, and which have been superseded.
//
// A line's revision is the one PRINTED IN THE TITLE BLOCK -- the ISO extraction
// already reads it into the line tag's `attributes.revision`. It is not counted
// from how many times somebody has uploaded: a sheet stamped REV 2 is rev 2 even
// if rev 1 never reached this app, and uploading an old drawing by mistake must
// not promote it. The drawing is the record.
//
// THE SAFE DIRECTION IS TO SHOW TOO MUCH, NEVER TOO LITTLE. Superseding a
// document hides its spools, its BOM and its welds from every page that filters
// by line. So a revision that cannot be read, or two that cannot be ordered
// against each other, leaves EVERYTHING current and says the order is unknown --
// the alternative is hiding real material because a REV box was smudged.

/** One drawing carrying a line, and the revision printed on it. */
export interface DocumentRevision {
  documentId: string;
  /** Exactly as printed, e.g. "0", "1", "A", "REV 2". Null where the box was blank or could not be read. */
  revision: string | null;
  uploadedAt: Date;
}

/** What decided which drawing is current -- null when nothing could. */
export type RevisionOrder = "the printed revision";

export interface CurrentRevision {
  /** The drawings in force. Several, where a line is carried by more than one drawing at the same revision. */
  current: DocumentRevision[];
  /** Replaced by a later revision. Kept and openable, never deleted. */
  superseded: DocumentRevision[];
  /** The revision now in force, as printed. Null when it could not be determined. */
  revision: string | null;
  /** Which rule decided, so a reader can tell a read answer from an unknown one. */
  decidedBy: RevisionOrder | null;
}

/**
 * Strip the decoration a title block puts round a revision, leaving the value.
 * "REV 1", "Rev. 1", " 1 " and "1" are one revision; "" and "-" are no revision.
 */
export function normalizeRevision(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const value = raw
    .trim()
    .toUpperCase()
    .replace(/^REV(ISION)?\s*[.:]?\s*/, "")
    .trim();
  // A dash or an N/A is a draughtsman's way of writing "none", not a revision.
  if (!value || value === "-" || value === "--" || value === "N/A" || value === "NA") return null;
  return value;
}

/**
 * Order two printed revisions. Returns a negative number, zero, a positive
 * number -- or NULL where they cannot be compared with confidence, which is a
 * real answer and not a failure.
 *
 * Two conventions are in use and both are ordered within themselves:
 *
 *   numeric   0, 1, 2 ...   issued revisions
 *   alpha     A, B, C ...   preliminary revisions
 *
 * Across the two there is NO safe ordering. Some offices issue A before 0, some
 * after; getting it wrong would hide the current drawing. So mixed pairs come
 * back null and the caller leaves both in force.
 */
export function compareRevisions(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = normalizeRevision(a);
  const y = normalizeRevision(b);
  if (x === null || y === null) return null;
  if (x === y) return 0;

  const numeric = /^\d+$/;
  const alpha = /^[A-Z]+$/;

  if (numeric.test(x) && numeric.test(y)) return Number(x) - Number(y);
  if (alpha.test(x) && alpha.test(y)) {
    // Length first, so AA comes after Z the way a revision sequence runs.
    if (x.length !== y.length) return x.length - y.length;
    return x < y ? -1 : 1;
  }
  return null;
}

/**
 * Split a line's drawings into the current revision and the superseded ones.
 *
 * Everything stays current unless the revisions are ALL readable and ALL
 * mutually comparable. One blank REV box, or one drawing at "A" beside one at
 * "1", and the whole line is left as it is today -- shown in full, with
 * `decidedBy` null so the page can say the revision was not read rather than
 * quietly dropping a drawing.
 */
export function resolveRevisions(docs: DocumentRevision[]): CurrentRevision {
  const unknown = (): CurrentRevision => ({ current: [...docs], superseded: [], revision: null, decidedBy: null });

  if (docs.length === 0) return { current: [], superseded: [], revision: null, decidedBy: null };
  if (docs.some((d) => normalizeRevision(d.revision) === null)) return unknown();

  // One drawing, or several all at the same revision: nothing is superseded, but
  // the revision IS known and worth reporting.
  let highest = docs[0];
  for (const doc of docs.slice(1)) {
    const order = compareRevisions(doc.revision, highest.revision);
    if (order === null) return unknown();
    if (order > 0) highest = doc;
  }

  // Every drawing at the winning revision stays in force -- a line split across
  // two drawings at the same revision has two current documents, not one.
  const current: DocumentRevision[] = [];
  const superseded: DocumentRevision[] = [];
  for (const doc of docs) {
    const order = compareRevisions(doc.revision, highest.revision);
    if (order === null) return unknown();
    (order === 0 ? current : superseded).push(doc);
  }

  return { current, superseded, revision: normalizeRevision(highest.revision), decidedBy: "the printed revision" };
}

/**
 * Does a check made at `checkedAt` still stand against `current`?
 *
 * Only a revision that is KNOWN to have moved on calls for a re-check. A review
 * recorded before revisions were tracked carries no revision at all, and an
 * unreadable REV box gives nothing to compare -- neither is evidence that the
 * drawing changed, and raising a re-check on them would cry wolf on every line
 * at once.
 */
export function needsRecheck(checkedAt: string | null | undefined, current: string | null | undefined): boolean {
  const was = normalizeRevision(checkedAt);
  const now = normalizeRevision(current);
  if (was === null || now === null) return false;
  return was !== now;
}

// ---- Every other kind of document ------------------------------------------
//
// An ISO states its revision on the drawing, which is what the above reads. A
// P&ID, line list, spec, legend or hook-up set is uploaded again under the same
// name when it changes, so the version is worked out from the FILE: a revision
// token in the name where there is one, and the upload date where not.

/** The revision a file name carries -- `...PD-04002_E.pdf` is at E, `..._A_NEW.xlsx` at A. */
export function revisionFromFileName(fileName: string): { base: string; revision: string } | null {
  const m = /^(.+?)[_\s]([A-Z]{1,2}|\d{1,2})(?:[_\s](?:NEW|FINAL|CLEAN))?\.[A-Za-z0-9]+$/i.exec(fileName.trim());
  return m ? { base: m[1], revision: m[2].toUpperCase() } : null;
}

/**
 * What identifies "the same document" across uploads: its type and its name with
 * the revision token, a copy marker like " (2)" and the case taken off. The
 * extension stays, because AC03N.pdf (the client spec) and AC03N.xlsx (the
 * admin item list) are two documents that share a name.
 */
export function documentFamily(docType: string, fileName: string): string {
  const name = fileName.trim();
  const ext = (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? "").toLowerCase();
  const stem = (revisionFromFileName(name)?.base ?? name.replace(/\.[A-Za-z0-9]+$/, ""))
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return `${docType}|${stem}|${ext}`;
}

export interface DocumentVersionInput {
  id: string;
  docType: string;
  fileName: string;
  uploadedAt: Date;
  /** Set by hand on the document; wins over a revision in the file name. */
  revision?: string | null;
}

export interface DocumentVersion {
  id: string;
  /** From the file name or, for an ISO, the title block. Null where neither says. */
  revision: string | null;
  /** False once a later version of the same document has been uploaded. */
  current: boolean;
  /** The document that replaced this one. */
  supersededBy: string | null;
  /** How this family was ordered -- null for a document that stands alone. */
  orderedBy: "the revision in the file name" | "upload date" | null;
}

/** What is already known about a document's revision, from outside its file name. */
export type KnownRevisions = Map<string, { revision: string | null; current: boolean; supersededBy?: string | null }>;

/**
 * Which uploads of each document are in force. One current per family: the
 * highest revision in the name where every upload has one and they can be
 * ordered, otherwise the latest upload. Nothing is deleted -- a superseded
 * document stays listed and openable.
 *
 * `known` overrides the file name for documents whose revision is read from the
 * drawing itself (an ISO): it says what revision each is at and whether it is
 * still current, and such a document is left out of the family ordering.
 */
export function resolveDocumentVersions(docs: DocumentVersionInput[], known: KnownRevisions = new Map()): Map<string, DocumentVersion> {
  const out = new Map<string, DocumentVersion>();
  const families = new Map<string, DocumentVersionInput[]>();

  for (const doc of docs) {
    const fixed = known.get(doc.id);
    if (fixed) {
      out.set(doc.id, { id: doc.id, revision: fixed.revision, current: fixed.current, supersededBy: fixed.supersededBy ?? null, orderedBy: null });
      continue;
    }
    const key = documentFamily(doc.docType, doc.fileName);
    families.set(key, [...(families.get(key) ?? []), doc]);
  }

  const newestFirst = (a: DocumentVersionInput, b: DocumentVersionInput) => b.uploadedAt.getTime() - a.uploadedAt.getTime();

  for (const members of families.values()) {
    const revisions = new Map(members.map((d) => [d.id, d.revision?.trim() || revisionFromFileName(d.fileName)?.revision || null] as const));

    let ordered = [...members].sort(newestFirst);
    let orderedBy: DocumentVersion["orderedBy"] = "upload date";

    // Every upload must carry a revision, and every pair must be orderable: one
    // pair that is not (A against 0) means the names cannot decide, and the
    // upload date does instead.
    if (members.every((d) => revisions.get(d.id) !== null)) {
      const byRevision = [...members].sort((a, b) => (compareRevisions(revisions.get(b.id), revisions.get(a.id)) ?? 0) || newestFirst(a, b));
      const allOrderable = members.every((a) => members.every((b) => a === b || compareRevisions(revisions.get(a.id), revisions.get(b.id)) !== null));
      if (allOrderable) {
        ordered = byRevision;
        orderedBy = "the revision in the file name";
      }
    }

    const current = ordered[0];
    for (const doc of members) {
      const isCurrent = doc.id === current.id;
      out.set(doc.id, {
        id: doc.id,
        revision: revisions.get(doc.id) ?? null,
        current: isCurrent,
        supersededBy: isCurrent ? null : current.id,
        orderedBy: members.length > 1 ? orderedBy : null,
      });
    }
  }
  return out;
}

/** Only the documents in force -- what a check reads, so it never reads a replaced one. */
export function currentDocuments<T extends DocumentVersionInput>(docs: T[], known?: KnownRevisions): T[] {
  const versions = resolveDocumentVersions(docs, known);
  return docs.filter((d) => versions.get(d.id)?.current !== false);
}
