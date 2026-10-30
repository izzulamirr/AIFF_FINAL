import { Alert, Badge } from "@/components/ui/primitives";
import { IconCheckCircle } from "@/components/ui/icons";
import { lineStateOf, type LineReview } from "@/lib/progress";
import { changeSummary, compareSources, type LineSource } from "@/lib/lineSources";
import { checkPrintLabel, type CheckPrint, type NextStep } from "@/lib/checkPrints";
import { issueCheckPrint, issueFinal, markLineReviewed, reopenLine } from "./progressActions";

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

// Progress needs two tables that supabase/line-progress.sql creates, and until it
// has been run `progressOfProject` returns null (see lib/progress.ts).
//
// This used to render NOTHING in that case -- no button, no badge, no reason --
// so a checker looking for "Mark as done" saw a line page that simply did not
// have one, indistinguishable from the feature never having been built. A
// missing capability has to SAY it is missing, or the only way to find out is to
// read the source.
//
// Two audiences, two messages: a checker cannot fix this and should be told who
// can, while Document Control is told exactly what to run.
export function MarkingNotSetUp({ canMark }: { canMark: boolean }) {
  return (
    <Alert tone="warning">
      {canMark ? (
        <>
          <strong>Lines can&apos;t be marked done yet.</strong> Marking needs a one-time database update that Document Control has to run.
          Everything else on this page works as normal.
        </>
      ) : (
        <>
          <strong>Line progress is not set up.</strong> Run <span className="font-mono">supabase/line-progress.sql</span> in the Supabase SQL
          editor — it only adds two tables and is safe to run more than once. Until then no checker can mark a line done.
        </>
      )}
    </Alert>
  );
}

/** The same fact, small enough to sit in a page header beside the title. */
export function MarkingNotSetUpBadge() {
  return (
    <Badge tone="warning" dot title="Marking needs supabase/line-progress.sql to have been run">
      Marking not set up
    </Badge>
  );
}

// The checker's mark on a line: "Mark as done" once they have reviewed it, and once
// they have, who did and when, with a way to take it back if it was a mistake.
// Document Control sees the result on its dashboard.
//
// THREE states, not two, because of revisions:
//
//   open      nobody has checked this line
//   done      checked against the drawing now in force
//   recheck   checked, but against a drawing a later revision has replaced
//
// A revision does NOT erase the check. Who checked it and when are still true
// and are still shown -- what changed is the drawing under them, so the line is
// highlighted for RE-CHECK and the button comes back. Deleting the tick would
// throw away a fact somebody earned and make progress lurch backwards for a
// revision that may have altered one dimension.
//
// `readOnly` is for Document Control, which reviews a line the same way but does
// not mark it -- only a checker's mark counts as progress. It sees where the line
// stands and has no button to change it.
export function ReviewControl({
  projectId,
  lineNumber,
  review,
  currentRevision,
  currentSources,
  next,
  lastPrint,
  errorCount,
  readOnly = false,
}: {
  projectId: string;
  lineNumber: string;
  review: LineReview | undefined;
  /** The revision in force, to judge the review against. */
  currentRevision: string | null;
  /** What the line is based on now, to judge the review's recorded sources against. */
  currentSources?: LineSource[];
  /** The line's next check-print step. Absent where check prints are not set up: plain "Mark as done" then. */
  next?: NextStep;
  /** The line's most recent check print, if any. */
  lastPrint?: CheckPrint;
  /** Errors on the line now, as the error report counts them. */
  errorCount?: number | null;
  readOnly?: boolean;
}) {
  const state = lineStateOf(review, currentRevision, currentSources);

  // The next step in the check-print cycle: CP-01..03 while errors remain, Final
  // (which marks the line done) once there are none.
  const errors = errorCount ?? 0;
  const mark = (fallback: string) => {
    if (!next) {
      return (
        <form action={markLineReviewed.bind(null, projectId, lineNumber)}>
          <button type="submit" className="btn btn-primary">
            <IconCheckCircle size={16} />
            {fallback}
          </button>
        </form>
      );
    }
    if (next.step === "final") {
      return (
        <form action={issueFinal.bind(null, projectId, lineNumber)}>
          <button type="submit" className="btn btn-primary" title="No errors on this line. Issuing Final marks it done.">
            <IconCheckCircle size={16} />
            Issue Final
          </button>
        </form>
      );
    }
    if (next.step === "cp") {
      return (
        <form action={issueCheckPrint.bind(null, projectId, lineNumber)}>
          <button type="submit" className="btn btn-secondary" title={`Send the ISO back to the designer with its ${errors} error${errors === 1 ? "" : "s"}.`}>
            Issue {next.label}
          </button>
        </form>
      );
    }
    if (next.step === "waiting") {
      return (
        <Badge tone="info" dot title="The next check print can be issued once the revised ISO is uploaded.">
          {next.label} with designer &middot; waiting for revised ISO
        </Badge>
      );
    }
    return (
      <Badge tone="danger" dot title="All three check prints have been issued. Final is only possible with zero errors.">
        {next.label} issued &middot; fix {errors} error{errors === 1 ? "" : "s"} for Final
      </Badge>
    );
  };

  if (state === "open") {
    const status = lastPrint ? (
      <Badge tone="info" dot title={`Issued ${when.format(lastPrint.issuedAt)}${lastPrint.issuedByName ? ` by ${lastPrint.issuedByName}` : ""}`}>
        {checkPrintLabel(lastPrint)} issued &middot; {lastPrint.errorCount} error{lastPrint.errorCount === 1 ? "" : "s"}
      </Badge>
    ) : (
      <Badge>Not checked yet</Badge>
    );
    return readOnly ? (
      status
    ) : (
      <div className="flex flex-wrap items-center gap-3">
        {lastPrint && status}
        {mark("Mark as done")}
      </div>
    );
  }

  // Non-null from here: only a review can produce "done" or "recheck".
  const checked = review!;
  const who = checked.reviewedByName ? ` by ${checked.reviewedByName}` : "";

  if (state === "recheck") {
    // The revision is named on BOTH sides. "Needs re-checking" alone invites the
    // question this badge exists to answer -- which drawing was checked, and
    // which is in front of you now.
    // Said in plain words: WHAT changed, not just that something did. The ISO's
    // own revision comes first where it moved; otherwise the other documents.
    const isoMoved = checked.revision && currentRevision && checked.revision !== currentRevision;
    const reason = isoMoved
      ? `ISO was Rev ${checked.revision}, now Rev ${currentRevision}`
      : currentSources
        ? changeSummary(compareSources(checked.basis, currentSources, checked.reviewedAt))
        : "";
    // It stays DONE -- the check was made, by this person, on this day -- and the
    // warning sits beside it saying what has changed since.
    const status = (
      <>
        <Badge tone="success" dot>
          Done{who} &middot; {when.format(checked.reviewedAt)}
          {checked.revision ? ` · rev ${checked.revision}` : ""}
        </Badge>
        <Badge tone="warning" dot title="A document this check was based on has changed since it was marked done">
          Needs re-check{reason ? ` · ${reason}` : ""}
        </Badge>
      </>
    );
    return readOnly ? (
      <div className="flex flex-wrap items-center gap-2">{status}</div>
    ) : (
      <div className="flex flex-wrap items-center gap-3">
        {status}
        {mark("Mark as done again")}
        <form action={reopenLine.bind(null, projectId, lineNumber)}>
          <button type="submit" className="btn btn-secondary btn-sm">
            Reopen
          </button>
        </form>
      </div>
    );
  }

  const status = (
    <Badge tone="success" dot>
      Done{who} &middot; {when.format(checked.reviewedAt)}
      {checked.revision ? ` · rev ${checked.revision}` : ""}
    </Badge>
  );

  if (readOnly) return status;

  return (
    <div className="flex flex-wrap items-center gap-3">
      {status}
      <form action={reopenLine.bind(null, projectId, lineNumber)}>
        <button type="submit" className="btn btn-secondary btn-sm">
          Reopen
        </button>
      </form>
    </div>
  );
}
