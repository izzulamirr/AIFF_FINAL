import { Alert, Badge } from "@/components/ui/primitives";
import { IconCheckCircle } from "@/components/ui/icons";
import type { LineReview } from "@/lib/progress";
import { markLineReviewed, reopenLine } from "./progressActions";

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
// `readOnly` is for Document Control, which reviews a line the same way but does
// not mark it -- only a checker's mark counts as progress. It sees where the line
// stands and has no button to change it.
export function ReviewControl({
  projectId,
  lineNumber,
  review,
  readOnly = false,
}: {
  projectId: string;
  lineNumber: string;
  review: LineReview | undefined;
  readOnly?: boolean;
}) {
  const status = review ? (
    <Badge tone="success" dot>
      Done{review.reviewedByName ? ` by ${review.reviewedByName}` : ""} &middot; {when.format(review.reviewedAt)}
    </Badge>
  ) : (
    <Badge>Not marked done by a checker yet</Badge>
  );

  if (readOnly) return status;

  if (review) {
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

  return (
    <form action={markLineReviewed.bind(null, projectId, lineNumber)}>
      <button type="submit" className="btn btn-primary">
        <IconCheckCircle size={16} />
        Mark as done
      </button>
    </form>
  );
}
