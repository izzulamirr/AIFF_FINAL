"use client";

import { useState } from "react";
import type { AdminVariant } from "@easy/shared";
import type { AdminFieldComparison } from "@/lib/verifySpecCrossCheck";

// One admin line, pre-resolved server-side (see buildAdminRows in page.tsx) --
// this component only ever filters, groups and renders what it is given, it
// never re-derives a verdict itself. Ported from the sibling AIFF_LATEST
// project and restyled onto this repo's own tokens.
export interface AdminMatchRow {
  reference: string;
  fields: AdminFieldComparison[];
  description: string;
  hasMismatch: boolean;
  /**
   * 90 / 45 degree, eccentric / concentric, straight / reduced -- null for a
   * component with no variants. Lets the lines under ONE client row be split
   * into the separate procurement items they really are.
   */
  variant: AdminVariant | null;
}

const FILTERS = ["all", "mismatch", "ok"] as const;
type Filter = (typeof FILTERS)[number];
const FILTER_LABELS: Record<Filter, string> = { all: "All", mismatch: "Mismatches", ok: "OK" };

// A dot and a value, not a pill: this table is dense, and a rounded badge on
// every one of five cells on every one of a hundred rows is mostly padding.
// The colour still carries the verdict; the tooltip still carries both sides.
function FieldVerdict({ comparison }: { comparison: AdminFieldComparison }) {
  const title = `Admin: ${comparison.adminValue}  ·  Client: ${comparison.clientValue}`;
  if (comparison.verdict === "unknown") {
    return (
      <span className="text-muted-foreground" title={title}>
        {comparison.adminValue}
      </span>
    );
  }
  const match = comparison.verdict === "match";
  return (
    <span className={`inline-flex items-center gap-1.5 font-medium ${match ? "text-success" : "text-danger"}`} title={title}>
      <span className={`h-1.5 w-1.5 flex-none rounded-full ${match ? "bg-success-solid" : "bg-danger-solid"}`} aria-hidden="true" />
      {comparison.adminValue}
      <span className="sr-only">{match ? "matches" : "differs"}</span>
    </span>
  );
}

function LinesTable({ rows }: { rows: AdminMatchRow[] }) {
  return (
    <div className="table-wrap">
      <table className="table table-compact min-w-[44rem] text-xs">
        <thead>
          <tr>
            <th>Reference</th>
            <th>Size</th>
            <th>Material</th>
            <th>Schedule / Class</th>
            <th>End</th>
            <th>Standard</th>
            <th>Admin description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td className="whitespace-nowrap font-mono">{row.reference || "-"}</td>
              {row.fields.map((f) => (
                <td key={f.field} className="whitespace-nowrap">
                  <FieldVerdict comparison={f} />
                </td>
              ))}
              <td className="text-muted-foreground">{row.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Lets a reviewer narrow a row's (sometimes 100+) admin lines down to just the
// ones that disagree with the client spec on at least one field, or just the
// ones that don't -- filtering client-side (not a server round-trip) since
// every row's already been resolved server-side; this is purely a view over
// data that's already fully present.
//
// Where the lines under this one client row are really SEVERAL components --
// 90 and 45 degree elbows, eccentric and concentric reducers -- they are split
// into a block each, so a reviewer reads "the 45 degree lines" rather than
// finding them among the 90s. Only when there is more than one variant: a
// single variant is just the row's own name and a header saying so is noise.
export function AdminMatchesTable({ rows }: { rows: AdminMatchRow[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const mismatchCount = rows.filter((r) => r.hasMismatch).length;
  const counts: Record<Filter, number> = { all: rows.length, mismatch: mismatchCount, ok: rows.length - mismatchCount };
  const passes = (r: AdminMatchRow) => (filter === "all" ? true : filter === "mismatch" ? r.hasMismatch : !r.hasMismatch);

  // Every variant present, judged on ALL rows, not the filtered ones: filtering
  // to "Mismatches" must not collapse a two-variant split into one plain table
  // and hide which variant the mismatches are in.
  const variants = new Map<string, AdminVariant>();
  for (const r of rows) if (r.variant) variants.set(r.variant.key, r.variant);
  // A line with no variant among lines that have one must not drop out of the
  // split -- it gets a block of its own rather than vanishing from the count.
  if (variants.size > 1 && rows.some((r) => !r.variant)) variants.set("other", { key: "other", label: "Other", order: 1000 });
  const split = variants.size > 1;
  const ordered = [...variants.values()].sort((a, b) => a.order - b.order);

  return (
    <div className="mt-2 flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
              filter === f ? "border-transparent bg-primary-soft text-link" : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {FILTER_LABELS[f]} <span className="tabular-nums">{counts[f]}</span>
          </button>
        ))}
      </div>

      {rows.filter(passes).length === 0 ? (
        <p className="text-xs text-muted-foreground">No {FILTER_LABELS[filter].toLowerCase()} lines.</p>
      ) : split ? (
        ordered.map((variant) => {
          const own = rows.filter((r) => (r.variant?.key ?? "other") === variant.key);
          const shown = own.filter(passes);
          if (shown.length === 0) return null;
          const bad = own.filter((r) => r.hasMismatch).length;
          return (
            <div key={variant.key} className="overflow-hidden rounded-lg border">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/50 px-3 py-1.5 text-xs">
                <span className="font-semibold">{variant.label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {own.length} line{own.length === 1 ? "" : "s"}
                  {bad > 0 && <span className="font-medium text-danger"> &middot; {bad} mismatch{bad === 1 ? "" : "es"}</span>}
                </span>
              </div>
              <LinesTable rows={shown} />
            </div>
          );
        })
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <LinesTable rows={rows.filter(passes)} />
        </div>
      )}
    </div>
  );
}
