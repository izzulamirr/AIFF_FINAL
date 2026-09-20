import { Badge } from "@/components/ui/primitives";
import { IconCheckCircle } from "@/components/ui/icons";
import type { LineReview } from "@/lib/progress";
import { markLineReviewed, reopenLine } from "./progressActions";

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

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
