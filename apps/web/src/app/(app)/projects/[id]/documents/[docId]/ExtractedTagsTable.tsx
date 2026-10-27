"use client";

import { Fragment, useMemo, useState } from "react";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { IconChevronDown, IconChevronRight, IconFile } from "@/components/ui/icons";

export interface TagRow {
  id: number;
  tagType: string;
  tagNumber: string;
  sourcePage: number | null;
  attributes: unknown;
}

export interface TagGroup {
  tag: TagRow;
  accessories: TagRow[];
}

// Extracted tags, one table per tag type, with each type's attributes as real
// columns instead of a name/value list per row. Display only: every attribute
// the extraction stored is still shown -- as a column, as a flag beside the tag,
// as a note line under the row, or (sheet_number on a one-sheet document) once
// in the toolbar. Nothing is reworded; the raw JSON is still further down the page.

type Attrs = Record<string, unknown>;

function attrsOf(t: TagRow): Attrs {
  const a = t.attributes;
  if (a && typeof a === "object" && !Array.isArray(a)) return a as Attrs;
  return a === null || a === undefined ? {} : { attributes: a };
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === "";

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (value === "") return '""';
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

const humanize = (key: string) => {
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// The order a reader scans a piping row in: what it is, what it sits on, its
// class, then where it runs. Keys not listed follow alphabetically.
const PREFERRED = [
  "valve_type",
  "instrument_type",
  "fitting_type",
  "size",
  "line_number",
  "line_or_equipment_ref",
  "spec_class",
  "spec_break_to",
  "service",
  "__route",
  "from_equipment",
  "to_equipment",
  "continues_on",
  "quantity",
  "slope",
  "parent_valve",
  "parent_instrument",
  "sheet_number",
];

const TYPE_ORDER = ["line", "equipment", "valve", "fitting", "instrument", "stream"];
const TYPE_LABEL: Record<string, string> = {
  line: "Lines",
  equipment: "Equipment",
  valve: "Valves",
  fitting: "Fittings",
  instrument: "Instruments",
  stream: "Streams",
  legend_item: "Legend items",
  spec_class: "Spec classes",
};
const typeLabel = (t: string) => TYPE_LABEL[t] ?? humanize(t);

// A value this long reads as a sentence, not a cell -- it goes on its own line
// under the row so it doesn't stretch the column for every other row.
const NOTE_MIN_LENGTH = 60;

interface Layout {
  columns: string[];
  flags: string[];
  notes: string[];
}

function layoutFor(rows: TagRow[], hidden: ReadonlySet<string>): Layout {
  const values = new Map<string, unknown[]>();
  for (const r of rows) {
    for (const [k, v] of Object.entries(attrsOf(r))) {
      if (hidden.has(k) || isEmpty(v)) continue;
      const list = values.get(k) ?? [];
      list.push(v);
      values.set(k, list);
    }
  }

  const flags: string[] = [];
  const notes: string[] = [];
  const plain: string[] = [];
  for (const [k, vs] of values) {
    if (vs.every((v) => typeof v === "boolean")) flags.push(k);
    else if (!PREFERRED.includes(k) && vs.some((v) => typeof v === "string" && v.length > NOTE_MIN_LENGTH)) notes.push(k);
    else plain.push(k);
  }

  const columns = plain.filter((k) => k !== "from_equipment" && k !== "to_equipment");
  if (plain.includes("from_equipment") || plain.includes("to_equipment")) columns.push("__route");
  const rank = (k: string) => {
    const i = PREFERRED.indexOf(k);
    return i === -1 ? PREFERRED.length : i;
  };
  columns.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return { columns, flags: flags.sort(), notes: notes.sort() };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const sortKey = (t: TagRow) => {
  const line = attrsOf(t).line_number;
  return `${typeof line === "string" ? line : ""}\u0000${t.tagNumber}`;
};

function matches(t: TagRow, q: string): boolean {
  if (t.tagNumber.toLowerCase().includes(q)) return true;
  return Object.values(attrsOf(t)).some((v) => !isEmpty(v) && formatValue(v).toLowerCase().includes(q));
}

function Cell({ attrs, column }: { attrs: Attrs; column: string }) {
  if (column === "__route") {
    const from = attrs.from_equipment;
    const to = attrs.to_equipment;
    if (isEmpty(from) && isEmpty(to)) return <span className="text-muted-foreground">—</span>;
    return (
      <span className="inline-flex flex-wrap items-center gap-x-1.5">
        <span className={isEmpty(from) ? "text-muted-foreground" : ""}>{isEmpty(from) ? "—" : formatValue(from)}</span>
        <span aria-label="to" className="text-muted-foreground">
          &rarr;
        </span>
        <span className={isEmpty(to) ? "text-muted-foreground" : ""}>{isEmpty(to) ? "—" : formatValue(to)}</span>
      </span>
    );
  }
  const v = attrs[column];
  if (isEmpty(v)) return <span className="text-muted-foreground">—</span>;
  return <span className="break-words">{formatValue(v)}</span>;
}

const columnLabel = (k: string) => (k === "__route" ? "From → To" : humanize(k));

// One type's rows. Also used, compact, for a valve's sub-instruments, which
// carry different attributes from the valve and so get columns of their own.
function TagTable({
  rows,
  accessoriesOf,
  hidden,
  collapsed,
  onToggle,
  compact = false,
}: {
  rows: TagRow[];
  accessoriesOf?: (id: number) => TagRow[];
  hidden: ReadonlySet<string>;
  collapsed?: ReadonlySet<number>;
  onToggle?: (id: number) => void;
  compact?: boolean;
}) {
  const { columns, flags, notes } = layoutFor(rows, hidden);
  const span = columns.length + 2;

  return (
    <div className="table-wrap">
      <table className={`table table-top ${compact ? "table-compact table-plain" : ""}`}>
        <thead>
          <tr>
            <th>Tag</th>
            <th className="w-12">Page</th>
            {columns.map((c) => (
              <th key={c}>{columnLabel(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const attrs = attrsOf(t);
            const subs = accessoriesOf?.(t.id) ?? [];
            const open = subs.length > 0 && !collapsed?.has(t.id);
            const rowNotes = notes.filter((k) => !isEmpty(attrs[k]));
            const joined = rowNotes.length > 0 || open;
            return (
              <Fragment key={t.id}>
                <tr className={joined ? "[&>td]:border-b-0" : ""}>
                  <td className="min-w-[14rem]">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {subs.length > 0 ? (
                        <button
                          onClick={() => onToggle?.(t.id)}
                          aria-expanded={open}
                          className="inline-flex items-center gap-1 text-left font-medium hover:underline"
                        >
                          {open ? (
                            <IconChevronDown size={15} className="flex-none text-muted-foreground" />
                          ) : (
                            <IconChevronRight size={15} className="flex-none text-muted-foreground" />
                          )}
                          <span className="break-all">{t.tagNumber}</span>
                        </button>
                      ) : (
                        <span className="break-all font-medium">{t.tagNumber}</span>
                      )}
                      {flags
                        .filter((k) => attrs[k] === true)
                        .map((k) => (
                          <Badge key={k}>{humanize(k)}</Badge>
                        ))}
                      {subs.length > 0 && (
                        <Badge tone="info">
                          {subs.length} sub-instrument{subs.length > 1 ? "s" : ""}
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="tabular-nums text-muted-foreground">{t.sourcePage ?? "-"}</td>
                  {columns.map((c) => (
                    <td key={c}>
                      <Cell attrs={attrs} column={c} />
                    </td>
                  ))}
                </tr>
                {rowNotes.length > 0 && (
                  <tr className={open ? "[&>td]:border-b-0" : ""}>
                    <td colSpan={span} className="!pt-0">
                      <dl className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                        {rowNotes.map((k) => (
                          <div key={k} className="flex gap-2">
                            <dt className="flex-none font-medium">{humanize(k)}:</dt>
                            <dd className="break-words">{formatValue(attrs[k])}</dd>
                          </div>
                        ))}
                      </dl>
                    </td>
                  </tr>
                )}
                {open && (
                  <tr>
                    <td colSpan={span} className="!pt-0">
                      <div className="ml-5 rounded-md border bg-muted/40">
                        <TagTable rows={subs} hidden={hidden} compact />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ExtractedTagsTable({ groups }: { groups: TagGroup[] }) {
  const [query, setQuery] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const sheets = useMemo(() => {
    const all = new Set<string>();
    for (const g of groups)
      for (const t of [g.tag, ...g.accessories]) {
        const s = attrsOf(t).sheet_number;
        if (typeof s === "string" && s) all.add(s);
      }
    return [...all].sort(collator.compare);
  }, [groups]);
  // One sheet: say it once in the toolbar instead of on every row.
  const hidden = useMemo(() => new Set(sheets.length <= 1 ? ["sheet_number"] : []), [sheets]);

  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of groups) counts.set(g.tag.tagType, (counts.get(g.tag.tagType) ?? 0) + 1);
    const rank = (t: string) => (TYPE_ORDER.includes(t) ? TYPE_ORDER.indexOf(t) : TYPE_ORDER.length);
    return [...counts].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  }, [groups]);

  const accessories = useMemo(() => new Map(groups.map((g) => [g.tag.id, g.accessories])), [groups]);
  const assemblyIds = groups.filter((g) => g.accessories.length > 0).map((g) => g.tag.id);
  const allCollapsed = assemblyIds.length > 0 && assemblyIds.every((id) => collapsed.has(id));

  const q = query.trim().toLowerCase();
  const visible = groups.filter(
    (g) =>
      (!type || g.tag.tagType === type) &&
      (!sheet || attrsOf(g.tag).sheet_number === sheet) &&
      (!q || matches(g.tag, q) || g.accessories.some((a) => matches(a, q))),
  );
  const filtering = Boolean(q || type || sheet);

  const toggle = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (groups.length === 0) return <EmptyState icon={<IconFile />} title="No tags extracted" />;

  return (
    <>
      <div className="flex flex-col gap-3 border-b px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tag, line, spec, equipment…"
            aria-label="Search extracted tags"
            className="input input-sm max-w-xs"
          />
          {sheets.length > 1 ? (
            <select
              value={sheet ?? ""}
              onChange={(e) => setSheet(e.target.value || null)}
              aria-label="Sheet"
              className="input input-sm w-auto max-w-xs"
            >
              <option value="">All sheets ({sheets.length})</option>
              {sheets.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          ) : (
            sheets.length === 1 && (
              <span className="text-xs text-muted-foreground">
                Sheet <span className="font-mono text-foreground">{sheets[0]}</span>
              </span>
            )
          )}
          {assemblyIds.length > 0 && (
            <button
              onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(assemblyIds))}
              className="btn btn-secondary btn-xs ml-auto"
            >
              {allCollapsed ? "Expand" : "Collapse"} {assemblyIds.length} assembl{assemblyIds.length === 1 ? "y" : "ies"}
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tag type">
          {[[null, groups.length] as const, ...types].map(([t, n]) => {
            const active = type === t;
            return (
              <button
                key={t ?? "all"}
                onClick={() => setType(t)}
                aria-pressed={active}
                className={`btn btn-xs ${active ? "btn-primary" : "btn-secondary"}`}
              >
                {t ? typeLabel(t) : "All"}
                <span className={active ? "opacity-80" : "text-muted-foreground"}>{n}</span>
              </button>
            );
          })}
        </div>
      </div>

      {visible.length === 0 && <EmptyState icon={<IconFile />} title="No tags match" />}

      {types
        .map(([t]) => t)
        .filter((t) => visible.some((g) => g.tag.tagType === t))
        .map((t) => {
          const rows = visible
            .filter((g) => g.tag.tagType === t)
            .map((g) => g.tag)
            .sort((a, b) => collator.compare(sortKey(a), sortKey(b)));
          const total = types.find(([x]) => x === t)?.[1] ?? rows.length;
          return (
            <section key={t} className="border-b last:border-b-0">
              <h3 className="flex items-center gap-2 bg-muted/60 px-5 py-2 text-sm font-semibold">
                {typeLabel(t)}
                <span className="font-normal text-muted-foreground">{filtering && rows.length !== total ? `${rows.length} of ${total}` : total}</span>
              </h3>
              <TagTable
                rows={rows}
                accessoriesOf={(id) => accessories.get(id) ?? []}
                hidden={hidden}
                collapsed={collapsed}
                onToggle={toggle}
              />
            </section>
          );
        })}
    </>
  );
}
