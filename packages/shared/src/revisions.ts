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
