// What changed between two P&IDs: an earlier issue and the one replacing it.
//
// Both documents have already been through the ordinary P&ID extraction, so this
// is a comparison of two sets of extracted tags and costs nothing to run. The
// person picks the pair -- which upload is the earlier one is theirs to say, as
// the P&ID extraction does not read the REV box (see revisions.ts for why
// upload order is never taken as revision order).
//
// What is matched to what:
//
//   lines                   by line number
//   tagged valves,          by tag
//   instruments, others
//   untagged valves and     by COUNT per line, symbol, size and class -- they have
//   fittings                no tag, so "which one" has no answer; "how many" does
//
// A line that disappears while another with the same size, class and both ends
// appears is reported as POSSIBLY renumbered, never silently merged: a
// battery-limit renumbering and a real replacement look the same in the data,
// and only the checker can tell them apart.
//
// Values are compared after trimming, upper-casing and collapsing whitespace, so
// "ac03n " and "AC03N" are one value -- two readings of one drawing differ that
// way all the time, and reporting it would bury the real changes.

import { normalizeTagNumber, DEFAULT_STRIP_PATTERN } from "./normalize";

export interface CompareTag {
  tagType: string;
  tagNumber: string;
  sourcePage: number | null;
  attributes: unknown;
}

export type ChangeStatus = "added" | "removed" | "changed";

export interface FieldChange {
  field: string;
  before: string | null;
  after: string | null;
}

export interface TaggedChange {
  status: ChangeStatus;
  tagType: string;
  tagNumber: string;
  /** The line it sits on, newer reading first, for grouping on the page. */
  lineNumber: string | null;
  sheet: string | null;
  /** For a change, the fields that differ; for an addition or removal, every field it was read with. */
  changes: FieldChange[];
}

export interface RenumberedLine {
  before: string;
  after: string;
  sheet: string | null;
  /** Anything else about the line that also differs. */
  changes: FieldChange[];
}

export interface CountChange {
  status: ChangeStatus;
  tagType: string;
  /** The symbol as read, e.g. "ball valve", "spec break (AC03N / AC70N)". */
  kind: string;
  lineNumber: string | null;
  size: string | null;
  specClass: string | null;
  before: number;
  after: number;
}

export interface SheetPair {
  sheet: string;
  inBefore: boolean;
  inAfter: boolean;
  /** Changes of any kind found on this sheet in the newer reading (or the older, for removals). */
  changeCount: number;
}

export interface PidComparison {
  sheets: SheetPair[];
  lines: TaggedChange[];
  renumbered: RenumberedLine[];
  tagged: TaggedChange[];
  counts: CountChange[];
  unchanged: { lines: number; tagged: number; counts: number };
}

// Reasoning the model wrote about HOW it read something, not a property of the
// thing. It differs between two readings of an identical drawing.
const IGNORED_FIELDS = new Set(["source"]);

type Attrs = Record<string, unknown>;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function attrsOf(t: CompareTag): Attrs {
  const a = t.attributes;
  return a && typeof a === "object" && !Array.isArray(a) ? (a as Attrs) : {};
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
  const trimmed = s.trim();
  return trimmed === "" ? null : trimmed;
}

const same = (a: string | null, b: string | null) => (a ?? "").replace(/\s+/g, " ").toUpperCase() === (b ?? "").replace(/\s+/g, " ").toUpperCase();

const key = (raw: string | null) => (raw ? normalizeTagNumber(raw, DEFAULT_STRIP_PATTERN) : "");

const str = (attrs: Attrs, field: string) => text(attrs[field]);

function fieldChanges(before: Attrs, after: Attrs): FieldChange[] {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: FieldChange[] = [];
  for (const field of [...fields].sort()) {
    if (IGNORED_FIELDS.has(field)) continue;
    const b = text(before[field]);
    const a = text(after[field]);
    if (!same(b, a)) out.push({ field, before: b, after: a });
  }
  return out;
}

const isUntagged = (t: CompareTag) => t.tagType === "fitting" || (t.tagType === "valve" && attrsOf(t).untagged === true);

function quantity(attrs: Attrs): number {
  const n = Number.parseInt(String(attrs.quantity ?? "1"), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Index by key; a tag read twice keeps every reading so a duplicate is not lost. */
function index(tags: CompareTag[], keyOf: (t: CompareTag) => string) {
  const map = new Map<string, CompareTag[]>();
  for (const t of tags) {
    const k = keyOf(t);
    if (!k) continue;
    const list = map.get(k) ?? [];
    list.push(t);
    map.set(k, list);
  }
  return map;
}

// A line running across two sheets is read once per sheet, so one key can hold
// several readings. Readings are compared sheet to sheet -- comparing whichever
// came first would report the sheet number as changed whenever the order differs.
// Sheets the item moved on or off are a change of their own.
function readingChanges(olds: CompareTag[], news: CompareTag[]): FieldChange[] {
  const sheet = (t: CompareTag) => str(attrsOf(t), "sheet_number") ?? "";
  const withoutSheet = (t: CompareTag) => {
    const { sheet_number: _ignored, ...rest } = attrsOf(t);
    return rest;
  };
  const oldSheets = [...new Set(olds.map(sheet))].sort(collator.compare);
  const newSheets = [...new Set(news.map(sheet))].sort(collator.compare);
  const out: FieldChange[] = [];

  if (oldSheets.join("\u0000") !== newSheets.join("\u0000")) {
    out.push({ field: "sheet_number", before: oldSheets.filter(Boolean).join(" / ") || null, after: newSheets.filter(Boolean).join(" / ") || null });
  }

  const common = oldSheets.filter((s) => newSheets.includes(s));
  const pairs: Array<[CompareTag, CompareTag]> =
    common.length > 0 ? common.map((s) => [olds.find((t) => sheet(t) === s)!, news.find((t) => sheet(t) === s)!]) : [[olds[0], news[0]]];
  const seen = new Set<string>();
  for (const [o, n] of pairs) {
    for (const change of fieldChanges(withoutSheet(o), withoutSheet(n))) {
      if (seen.has(change.field)) continue;
      seen.add(change.field);
      out.push(change);
    }
  }

  // The same item drawn twice on one sheet, and now once (or the other way).
  for (const s of common) {
    const nb = olds.filter((t) => sheet(t) === s).length;
    const na = news.filter((t) => sheet(t) === s).length;
    if (nb !== na) out.push({ field: s ? `times shown on ${s}` : "times shown", before: String(nb), after: String(na) });
  }
  return out;
}

function diffByKey(before: CompareTag[], after: CompareTag[], keyOf: (t: CompareTag) => string) {
  const b = index(before, keyOf);
  const a = index(after, keyOf);
  const changes: TaggedChange[] = [];
  let unchanged = 0;

  const describe = (status: ChangeStatus, t: CompareTag, changes: FieldChange[]): TaggedChange => {
    const attrs = attrsOf(t);
    return {
      status,
      tagType: t.tagType,
      tagNumber: t.tagNumber,
      lineNumber: t.tagType === "line" ? t.tagNumber : str(attrs, "line_number") ?? str(attrs, "line_or_equipment_ref"),
      sheet: str(attrs, "sheet_number"),
      changes,
    };
  };

  for (const [k, olds] of b) {
    const news = a.get(k);
    if (!news) {
      changes.push(describe("removed", olds[0], fieldChanges(attrsOf(olds[0]), {})));
      continue;
    }
    const diff = readingChanges(olds, news);
    if (diff.length > 0) changes.push(describe("changed", news[0], diff));
    else unchanged++;
  }
  for (const [k, news] of a) if (!b.has(k)) changes.push(describe("added", news[0], fieldChanges({}, attrsOf(news[0]))));
  return { changes, unchanged };
}

// Same physical line under a new number: same size and class, and both ends
// read and the same. One end blank is not enough to call it.
function pairRenumbered(removed: CompareTag[], added: CompareTag[]) {
  const pairs: Array<{ before: CompareTag; after: CompareTag }> = [];
  const used = new Set<CompareTag>();
  for (const old of removed) {
    const o = attrsOf(old);
    const from = str(o, "from_equipment");
    const to = str(o, "to_equipment");
    if (!from || !to) continue;
    const candidates = added.filter((n) => {
      if (used.has(n)) return false;
      const x = attrsOf(n);
      return (
        same(from, str(x, "from_equipment")) &&
        same(to, str(x, "to_equipment")) &&
        same(str(o, "size"), str(x, "size")) &&
        same(str(o, "spec_class"), str(x, "spec_class"))
      );
    });
    // Two candidates is a guess between them; leave both as they are.
    if (candidates.length !== 1) continue;
    used.add(candidates[0]);
    pairs.push({ before: old, after: candidates[0] });
  }
  return pairs;
}

function diffCounts(before: CompareTag[], after: CompareTag[]) {
  type Bucket = { sample: CompareTag; n: number };
  const keyOf = (t: CompareTag) => {
    const x = attrsOf(t);
    const kind = str(x, t.tagType === "valve" ? "valve_type" : "fitting_type") ?? t.tagNumber;
    return [t.tagType, key(str(x, "line_number")), kind, str(x, "size"), str(x, "spec_class")]
      .map((s) => (s ?? "").replace(/\s+/g, " ").toUpperCase())
      .join("\u0000");
  };
  const tally = (tags: CompareTag[]) => {
    const m = new Map<string, Bucket>();
    for (const t of tags) {
      const k = keyOf(t);
      const bucket = m.get(k) ?? { sample: t, n: 0 };
      bucket.n += quantity(attrsOf(t));
      m.set(k, bucket);
    }
    return m;
  };
  const b = tally(before);
  const a = tally(after);
  const changes: CountChange[] = [];
  let unchanged = 0;
  for (const k of new Set([...b.keys(), ...a.keys()])) {
    const nb = b.get(k)?.n ?? 0;
    const na = a.get(k)?.n ?? 0;
    if (nb === na) {
      unchanged++;
      continue;
    }
    const t = (a.get(k) ?? b.get(k))!.sample;
    const x = attrsOf(t);
    changes.push({
      status: nb === 0 ? "added" : na === 0 ? "removed" : "changed",
      tagType: t.tagType,
      kind: str(x, t.tagType === "valve" ? "valve_type" : "fitting_type") ?? t.tagNumber,
      lineNumber: str(x, "line_number"),
      size: str(x, "size"),
      specClass: str(x, "spec_class"),
      before: nb,
      after: na,
    });
  }
  return { changes, unchanged };
}

const STATUS_ORDER: Record<ChangeStatus, number> = { changed: 0, added: 1, removed: 2 };

/** Compare an earlier P&ID's extracted tags with a later one's. */
export function comparePids(before: CompareTag[], after: CompareTag[]): PidComparison {
  const skip = (t: CompareTag) => t.tagType === "legend_item";
  const b = before.filter((t) => !skip(t));
  const a = after.filter((t) => !skip(t));

  const lineKey = (t: CompareTag) => key(t.tagNumber);
  const lineDiff = diffByKey(
    b.filter((t) => t.tagType === "line"),
    a.filter((t) => t.tagType === "line"),
    lineKey,
  );

  // Pull renumbered pairs out of the added/removed lines.
  const removedLines = b.filter((t) => t.tagType === "line" && lineDiff.changes.some((c) => c.status === "removed" && key(c.tagNumber) === lineKey(t)));
  const addedLines = a.filter((t) => t.tagType === "line" && lineDiff.changes.some((c) => c.status === "added" && key(c.tagNumber) === lineKey(t)));
  const pairs = pairRenumbered(removedLines, addedLines);
  const paired = new Set(pairs.flatMap((p) => [`removed:${lineKey(p.before)}`, `added:${lineKey(p.after)}`]));
  const lines = lineDiff.changes.filter((c) => !paired.has(`${c.status}:${key(c.tagNumber)}`));
  const renumbered: RenumberedLine[] = pairs.map((p) => ({
    before: p.before.tagNumber,
    after: p.after.tagNumber,
    sheet: str(attrsOf(p.after), "sheet_number"),
    changes: fieldChanges(attrsOf(p.before), attrsOf(p.after)),
  }));

  const taggedOf = (tags: CompareTag[]) => tags.filter((t) => t.tagType !== "line" && !isUntagged(t));
  const tagged = diffByKey(taggedOf(b), taggedOf(a), (t) => `${t.tagType}\u0000${key(t.tagNumber)}`);
  const counts = diffCounts(b.filter(isUntagged), a.filter(isUntagged));

  // Sheets: paired by drawing number, with how many changes landed on each.
  const sheetNames = new Set<string>();
  const sheetsOf = (tags: CompareTag[]) => new Set(tags.map((t) => str(attrsOf(t), "sheet_number")).filter((s): s is string => Boolean(s)));
  const sb = sheetsOf(b);
  const sa = sheetsOf(a);
  for (const s of [...sb, ...sa]) sheetNames.add(s);
  const changesOnSheet = (sheet: string) =>
    lines.filter((c) => c.sheet === sheet).length +
    renumbered.filter((r) => r.sheet === sheet).length +
    tagged.changes.filter((c) => c.sheet === sheet).length;
  const sheets: SheetPair[] = [...sheetNames]
    .sort(collator.compare)
    .map((sheet) => ({ sheet, inBefore: sb.has(sheet), inAfter: sa.has(sheet), changeCount: changesOnSheet(sheet) }));

  const byStatusThenName = (x: TaggedChange, y: TaggedChange) =>
    STATUS_ORDER[x.status] - STATUS_ORDER[y.status] || collator.compare(x.lineNumber ?? "", y.lineNumber ?? "") || collator.compare(x.tagNumber, y.tagNumber);

  return {
    sheets,
    lines: lines.sort(byStatusThenName),
    renumbered,
    tagged: tagged.changes.sort(byStatusThenName),
    counts: counts.changes.sort(
      (x, y) => collator.compare(x.lineNumber ?? "", y.lineNumber ?? "") || collator.compare(x.kind, y.kind) || STATUS_ORDER[x.status] - STATUS_ORDER[y.status],
    ),
    unchanged: { lines: lineDiff.unchanged, tagged: tagged.unchanged, counts: counts.unchanged },
  };
}
