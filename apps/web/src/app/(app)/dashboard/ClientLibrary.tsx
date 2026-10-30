import Link from "next/link";
import { Badge, EmptyState, JobStatus } from "@/components/ui/primitives";
import { IconDownload, IconFile, IconLibrary } from "@/components/ui/icons";
import { LIBRARY_UPLOAD_KINDS, labelForDocument } from "@/lib/docTypes";
import type { DocumentVersion } from "@easy/shared";
import { CATEGORY_LABEL, LIBRARY_CATEGORIES, isLibraryCategory, type LibraryItem } from "@/lib/library";

// Every project's reference, in one place, GROUPED BY TYPE -- the roll-up the
// Dashboard's per-project rows cannot show, because each of those is scoped to
// one project. This is the opposite cut: "every P&ID we hold for this client",
// not "everything YAMAMA holds".
//
// Two kinds of reference, same as a project's own Library page, both grouped
// the same way whether the item belongs to one project or is shared by every
// project of the client:
//
//   READ BY THE APP     `documents` rows -- P&ID, legend, line list, H&MB, PFD,
//                        GA, client pipe spec. Extracted; a check depends on it.
//   KEPT FOR REFERENCE   `library_items` rows -- standards, templates, client
//                        specs kept and handed back, never read.
//
// This is a SUMMARY, not an editor. Uploading, deleting and moving a document
// stay on the project (or client library) page they belong to -- this only
// answers "what do we have, and of what kind", with a link to each file or the
// project that holds it.

const day = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

export interface ReferenceDocEntry {
  id: string;
  fileName: string;
  docType: string;
  pageCount: number | null;
  projectId: string;
  projectName: string;
  job:
    | { status: string; progressPhase: string | null; progressCurrent: number | null; progressTotal: number | null; errorMessage: string | null }
    | undefined;
  uploadedAt: Date;
  /** Revision tracking: which upload is in force. Null where it was not worked out. */
  version: DocumentVersion | null;
}

export interface LibraryItemEntry extends LibraryItem {
  /** The project this item belongs to, or null for the client's shared library. */
  projectName: string | null;
}

/** Bucket items by a key, in a fixed preferred order; anything else falls in after, alphabetically. */
function groupInOrder<T>(items: T[], keyOf: (item: T) => string, order: readonly string[]): Array<{ label: string; items: T[] }> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  const groups: Array<{ label: string; items: T[] }> = [];
  for (const label of order) {
    const bucket = buckets.get(label);
    if (bucket) {
      groups.push({ label, items: bucket });
      buckets.delete(label);
    }
  }
  for (const [label, bucket] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    groups.push({ label, items: bucket });
  }
  return groups;
}

// The order reference documents are uploaded in (legend first, since it has to
// be) is the order worth grouping them in too.
const REFERENCE_TYPE_ORDER = LIBRARY_UPLOAD_KINDS.map((k) => k.label);

export function ReferenceLibrarySection({
  clientName,
  docs,
  activeType = null,
  basePath,
}: {
  clientName: string;
  docs: ReferenceDocEntry[];
  /** Show only this type (?type=<label>). Ignored when no document is of it. */
  activeType?: string | null;
  /** Where the filter links point; no filter is offered without it. */
  basePath?: string;
}) {
  const typeOf = (d: ReferenceDocEntry) => labelForDocument(d.docType, d.fileName);
  const allGroups = groupInOrder(docs, typeOf, REFERENCE_TYPE_ORDER);
  const active = activeType && allGroups.some((g) => g.label === activeType) ? activeType : null;
  // Revisions of one document next to each other, newest first.
  const groups = allGroups
    .filter((g) => !active || g.label === active)
    .map((g) => ({
      ...g,
      items: [...g.items].sort(
        (a, b) =>
          a.projectName.localeCompare(b.projectName) ||
          a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: "base" }) ||
          b.uploadedAt.getTime() - a.uploadedAt.getTime()
      ),
    }));
  const typeHref = (type: string | null) => `${basePath}${type ? `?type=${encodeURIComponent(type)}` : ""}`;

  return (
    <section className="card card-flush">
      <div className="card-header">
        <div>
          <h2 className="card-title">Read by the app</h2>
          <p className="card-description">Every project&apos;s P&amp;IDs, legends, line lists and client specs across {clientName}.</p>
        </div>
        {docs.length > 0 && <Badge className="ml-auto">{docs.length}</Badge>}
      </div>

      {basePath && allGroups.length > 1 && (
        <nav aria-label="Filter by type" className="flex flex-wrap gap-2 border-b border-border px-5 py-3">
          {[null, ...allGroups.map((g) => g.label)].map((type) => (
            <Link
              key={type ?? "all"}
              href={typeHref(type)}
              aria-current={type === active ? "true" : undefined}
              className={`btn btn-xs ${type === active ? "btn-primary" : "btn-secondary"}`}
            >
              {type ?? "All"}{" "}
              <span className="opacity-70">{type ? allGroups.find((g) => g.label === type)!.items.length : docs.length}</span>
            </Link>
          ))}
        </nav>
      )}

      {docs.length === 0 ? (
        <EmptyState icon={<IconFile />} title="No reference yet">
          Add a project&apos;s P&amp;ID legend, line list or P&amp;IDs from its Library page.
        </EmptyState>
      ) : (
        <div className="divide-y divide-border">
          {groups.map((group) => (
            <div key={group.label} className="px-5 py-4">
              <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label} <span className="font-normal normal-case text-muted-foreground">({group.items.length})</span>
              </h3>
              <ul className="flex flex-col gap-2.5">
                {group.items.map((doc) => (
                  <li key={doc.id} className={`flex flex-wrap items-center gap-2.5 ${doc.version && !doc.version.current ? "opacity-60" : ""}`}>
                    <IconFile size={15} className="flex-none text-muted-foreground" />
                    {doc.job?.status === "succeeded" ? (
                      <Link href={`/projects/${doc.projectId}/documents/${doc.id}`} className="link break-all text-sm font-medium">
                        {doc.fileName}
                      </Link>
                    ) : (
                      <span className="break-all text-sm font-medium">{doc.fileName}</span>
                    )}
                    {doc.version?.revision && <Badge tone={doc.version.current ? "info" : "neutral"}>Rev {doc.version.revision}</Badge>}
                    {doc.version && !doc.version.current && (
                      <Badge tone="warning" title="A later upload of this document is in force; checks do not read this one.">
                        Superseded
                      </Badge>
                    )}
                    {doc.version?.current && !doc.version.revision && doc.version.orderedBy === "upload date" && (
                      <Badge title="The newest upload of this document">Latest</Badge>
                    )}
                    <Link href={`/projects/${doc.projectId}`} className="text-xs text-muted-foreground hover:text-foreground">
                      {doc.projectName}
                    </Link>
                    <span className="ml-auto flex-none">
                      <JobStatus job={doc.job} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const CATEGORY_ORDER = LIBRARY_CATEGORIES.map((c) => CATEGORY_LABEL[c]);

export function KeptLibrarySection({ clientName, items }: { clientName: string; items: LibraryItemEntry[] | null }) {
  const groups = items ? groupInOrder(items, (i) => (isLibraryCategory(i.category) ? CATEGORY_LABEL[i.category] : i.category), CATEGORY_ORDER) : [];

  return (
    <>

      <section className="card card-flush">
        <div className="card-header">
          <div>
            <h2 className="card-title">Kept for reference</h2>
            <p className="card-description">
              Standards, client specs and templates across {clientName} &mdash; shared and per project. Stored and handed back, never
              read.
            </p>
          </div>
          {items && items.length > 0 && <Badge className="ml-auto">{items.length}</Badge>}
        </div>

        {items !== null &&
          (items.length === 0 ? (
            <EmptyState icon={<IconLibrary />} title="Nothing kept yet">
              Add files from a project&apos;s Library page.
            </EmptyState>
          ) : (
            <div className="divide-y divide-border">
              {groups.map((group) => (
                <div key={group.label} className="px-5 py-4">
                  <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.label} <span className="font-normal normal-case text-muted-foreground">({group.items.length})</span>
                  </h3>
                  <ul className="flex flex-col gap-2.5">
                    {group.items.map((item) => (
                      <li key={item.id} className="flex flex-wrap items-center gap-2.5">
                        <IconFile size={15} className="flex-none text-muted-foreground" />
                        <span className="break-all text-sm font-medium">{item.title}</span>
                        {/* Shared items and a project's own look the same everywhere
                            else in the app; here, where several projects sit side
                            by side, which one it belongs to is the fact worth a
                            badge -- "Shared" reads as its own kind of place, not
                            as a project that happens to be named that. */}
                        <Badge tone={item.projectName ? "neutral" : "info"}>{item.projectName ?? "Shared"}</Badge>
                        <span className="text-xs text-muted-foreground">{day.format(item.createdAt)}</span>
                        <a href={`/library/file/${item.id}`} className="btn btn-secondary btn-xs ml-auto" aria-label={`Download ${item.title}`}>
                          <IconDownload size={13} />
                          Download
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
      </section>
    </>
  );
}
