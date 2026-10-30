import Link from "next/link";
import { Badge, type Tone } from "@/components/ui/primitives";
import { IconChevronRight, IconClipboard } from "@/components/ui/icons";
import type { LineReview } from "@/lib/progress";
import { CHANGED, SOURCE_LABEL, type LineSource, type SourceComparison, type SourceStatus } from "@/lib/lineSources";

// "What this check was based on": every document a line's checks read, as it was
// when the line was marked done and as it is now, in words a checker does not
// have to decode. It answers the question a re-check raises -- WHAT changed, and
// where do I look -- with one link per changed document straight to the change.

const day = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

const STATUS: Record<SourceStatus, { label: string; tone: Tone; hint?: string }> = {
  same: { label: "Unchanged", tone: "success" },
  sameRow: { label: "Unchanged", tone: "success", hint: "A newer line list was uploaded, but this line's row in it is the same." },
  updated: { label: "Updated", tone: "warning" },
  rowChanged: { label: "Row changed", tone: "warning", hint: "A newer line list was uploaded and this line's row in it is different." },
  new: { label: "New", tone: "warning", hint: "This document applies to the line now but did not when it was checked." },
  gone: { label: "Removed", tone: "danger", hint: "This document was checked against but is no longer in the project." },
  updatedSince: { label: "Issued since", tone: "warning", hint: "Uploaded after this line was marked done, so it cannot have been checked." },
};

const version = (s: LineSource) => (s.revision ? `Rev ${s.revision}` : `uploaded ${day.format(new Date(s.uploadedAt))}`);

export function CheckedAgainst({
  projectId,
  review,
  comparisons,
  drawingHref,
}: {
  projectId: string;
  review: LineReview;
  comparisons: SourceComparison[];
  /** Where an earlier ISO revision of this line opens. */
  drawingHref: (documentId: string) => string;
}) {
  const who = review.reviewedByName ? ` by ${review.reviewedByName}` : "";
  const changed = comparisons.filter((c) => CHANGED.has(c.status));

  // The one place to go for each change: the two P&ID revisions laid over each
  // other, the ISO revision that was checked, or the new document itself.
  const action = (c: SourceComparison): { href: string; label: string } | null => {
    if (!CHANGED.has(c.status)) return null;
    if (c.kind === "pid" && c.was && c.now) return { href: `/projects/${projectId}/pid-compare?before=${c.was.documentId}&after=${c.now.documentId}`, label: "See what changed" };
    if (c.kind === "iso" && c.was && c.status === "updated") return { href: drawingHref(c.was.documentId), label: "Open the revision you checked" };
    if (c.now) return { href: `/projects/${projectId}/documents/${c.now.documentId}`, label: "Open" };
    return null;
  };

  const unchanged = comparisons.filter((c) => !CHANGED.has(c.status));
  const row = (c: SourceComparison) => {
    const s = STATUS[c.status];
    const isChange = CHANGED.has(c.status);
    const go = action(c);
    const doc = c.now ?? c.was!;
    return (
      <li key={`${c.kind}:${doc.documentId}`} className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-3 ${isChange ? "bg-warning-soft/40" : ""}`}>
        <span className="w-28 flex-none">
          <Badge tone={s.tone} dot title={s.hint}>
            {s.label}
          </Badge>
        </span>
        <span className="min-w-[12rem] flex-1">
          <span className="block text-sm font-medium">{SOURCE_LABEL[c.kind]}</span>
          <span className="block break-all text-xs text-muted-foreground">{doc.fileName}</span>
        </span>
        {/* What was checked, then what is in force now -- side by side, nothing
            struck out: the checked revision is still a fact worth reading. */}
        <span className="flex flex-col text-sm">
          {isChange ? (
            <>
              <span className="text-xs text-muted-foreground">Checked: {c.was ? version(c.was) : "—"}</span>
              <span className="font-semibold text-warning">Now: {c.now ? version(c.now) : "removed"}</span>
            </>
          ) : (
            <span className="text-muted-foreground">{version(doc)}</span>
          )}
        </span>
        <span className="ml-auto w-48 flex-none text-right">
          {go && (
            <Link href={go.href} className="inline-flex items-center gap-1 text-sm font-medium text-link hover:underline">
              {go.label}
              <IconChevronRight size={14} />
            </Link>
          )}
        </span>
      </li>
    );
  };

  return (
    <section className="card card-flush">
      <div className="card-header justify-start gap-3">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-primary-soft text-link">
          <IconClipboard size={18} />
        </span>
        <div className="text-left">
          <h2 className="card-title">What this check was based on</h2>
          <p className="card-description">
            Marked done{who} on {day.format(review.reviewedAt)}.
          </p>
        </div>
      </div>

      {review.basis === null && comparisons.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          This line was marked done before the app recorded which documents a check used. Nothing it depends on has been uploaded since,
          so nothing needs looking at. Mark it done again to record the exact revisions.
        </p>
      ) : (
        <>
          <div
            className={`mx-5 mt-4 rounded-lg border px-4 py-3 text-sm ${
              changed.length > 0 ? "border-warning-border bg-warning-soft" : "border-success bg-success-soft"
            }`}
          >
            {changed.length > 0 ? (
              <>
                <strong>
                  {changed.length === 1 ? "1 document has" : `${changed.length} documents have`} changed since this line was marked done.
                </strong>{" "}
                Look at what changed below, then mark the line done again.
              </>
            ) : (
              <strong>Nothing has changed since this line was marked done.</strong>
            )}
          </div>

          {/* What changed stays in view; everything that did not folds away, so a
              line with one revised P&ID among a dozen documents leads with the P&ID. */}
          <ul className="mt-2 divide-y divide-border">
            {comparisons.filter((c) => CHANGED.has(c.status)).map(row)}
          </ul>
          {unchanged.length > 0 && (
            <details className="group border-t border-border" open={changed.length === 0 && unchanged.length <= 3}>
              <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3 text-sm font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground [&::-webkit-details-marker]:hidden">
                <IconChevronRight size={15} className="transition-transform group-open:rotate-90" />
                {unchanged.length === 1 ? "1 unchanged document" : `${unchanged.length} unchanged documents`}
              </summary>
              <ul className="divide-y divide-border border-t border-border">{unchanged.map(row)}</ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
