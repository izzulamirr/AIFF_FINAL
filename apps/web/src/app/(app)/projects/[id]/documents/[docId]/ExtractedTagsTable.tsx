"use client";

import { Fragment, useState } from "react";
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

// A tag's attributes as name / value pairs rather than a JSON blob. Faithful:
// strings are shown as they are, numbers and booleans as text, and anything
// nested is shown as its JSON -- nothing is dropped or reworded. The raw
// extraction result is still on the page for anyone who wants the JSON itself.
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (value === "") return '""';
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function Attributes({ value }: { value: unknown }) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-muted-foreground">—</span>;
    return (
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
        {entries.map(([key, v]) => (
          <Fragment key={key}>
            <dt className="font-mono text-muted-foreground">{key}</dt>
            <dd className="break-words">{formatValue(v)}</dd>
          </Fragment>
        ))}
      </dl>
    );
  }
  return <pre className="whitespace-pre-wrap font-mono text-xs">{JSON.stringify(value, null, 2)}</pre>;
}

// Extracted-tags table with valve assemblies collapsible: each valve that
// has sub-instruments (its accessories carry parent_valve) can be expanded
// or hidden. Groups with no accessories render as a plain row. Server passes
// the grouping down pre-computed (see page.tsx) so this component only owns
// the open/closed UI state.
export function ExtractedTagsTable({ groups }: { groups: TagGroup[] }) {
  const parentIdsWithSubs = groups.filter((g) => g.accessories.length > 0).map((g) => g.tag.id);
  // Default: everything expanded (matches the previous always-shown view);
  // the user can collapse any assembly, or all of them at once.
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const toggle = (id: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allCollapsed = parentIdsWithSubs.length > 0 && parentIdsWithSubs.every((id) => collapsed.has(id));
  const toggleAll = () => setCollapsed(allCollapsed ? new Set() : new Set(parentIdsWithSubs));

  return (
    <>
      {parentIdsWithSubs.length > 0 && (
        <div className="flex items-center justify-between gap-3 border-b px-5 py-2.5">
          <p className="text-xs text-muted-foreground">
            {parentIdsWithSubs.length} valve assembl{parentIdsWithSubs.length === 1 ? "y" : "ies"} with sub-instruments
          </p>
          <button onClick={toggleAll} className="btn btn-secondary btn-xs">
            {allCollapsed ? "Expand all assemblies" : "Collapse all assemblies"}
          </button>
        </div>
      )}
      <div className="table-wrap">
        <table className="table table-top">
          <thead>
            <tr>
              <th>Tag type</th>
              <th>Tag number</th>
              <th>Page</th>
              <th>Attributes</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(({ tag, accessories }) => {
              const hasSubs = accessories.length > 0;
              const isOpen = hasSubs && !collapsed.has(tag.id);
              return (
                <Fragment key={tag.id}>
                  <tr>
                    <td>
                      <Badge mono>{tag.tagType}</Badge>
                    </td>
                    <td>
                      {hasSubs ? (
                        <button
                          onClick={() => toggle(tag.id)}
                          aria-expanded={isOpen}
                          className="inline-flex items-center gap-1.5 text-left font-medium hover:underline"
                        >
                          {isOpen ? (
                            <IconChevronDown size={15} className="flex-none text-muted-foreground" />
                          ) : (
                            <IconChevronRight size={15} className="flex-none text-muted-foreground" />
                          )}
                          <span className="break-all">{tag.tagNumber}</span>
                          <Badge className="ml-1">
                            {accessories.length} sub-instrument{accessories.length > 1 ? "s" : ""}
                          </Badge>
                        </button>
                      ) : (
                        <span className="break-all font-medium">{tag.tagNumber}</span>
                      )}
                    </td>
                    <td className="tabular-nums text-muted-foreground">{tag.sourcePage ?? "-"}</td>
                    <td>
                      <Attributes value={tag.attributes} />
                    </td>
                  </tr>
                  {isOpen &&
                    accessories.map((acc) => (
                      <tr key={acc.id} className="bg-muted/40">
                        <td className="pl-8">
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            <span aria-hidden="true">&#8627;</span>
                            <Badge mono>{acc.tagType}</Badge>
                          </span>
                        </td>
                        <td>
                          <span className="break-all">{acc.tagNumber}</span>
                        </td>
                        <td className="tabular-nums text-muted-foreground">{acc.sourcePage ?? "-"}</td>
                        <td>
                          <Attributes value={acc.attributes} />
                        </td>
                      </tr>
                    ))}
                </Fragment>
              );
            })}
            {groups.length === 0 && (
              <tr>
                <td colSpan={4}>
                  <EmptyState icon={<IconFile />} title="No tags extracted" />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
