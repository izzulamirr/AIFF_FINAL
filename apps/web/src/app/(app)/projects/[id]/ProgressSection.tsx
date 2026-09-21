import { ProgressBar } from "@/components/progress/ProgressBar";
import { Alert, Badge, Stat } from "@/components/ui/primitives";
import { IconChevronDown } from "@/components/ui/icons";
import type { ProjectProgress } from "@/lib/progress";
import { setTotalLines } from "../projects/[id]/progressActions";

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });

// How far the checkers are through ONE project's lines: the total Document
// Control states, the lines marked done, and which -- and where Document Control
// enters that total.
//
// `progress` is null until supabase/line-progress.sql has been run -- see
// lib/progress.ts -- and the section says so rather than showing zeros that look
// like nobody has checked anything.
export function ProgressSection({ progress }: { progress: ProjectProgress | null }) {
  if (progress === null) {
    return (
      <section className="flex flex-col gap-4">
        <h2 className="section-title">Line progress</h2>
        <Alert tone="warning">
          Progress tracking needs a one-time database update before it can store anything. Run <span className="font-mono">supabase/line-progress.sql</span>{" "}
          in the Supabase SQL editor; it only adds two tables and is safe to run more than once.
        </Alert>
      </section>
    );
  }

  const checked = progress.reviews.length;
  const total = progress.total;
  const complete = total != null && total > 0 && checked >= total;

  return (
    <section className="flex flex-col gap-4">
      <h2 className="section-title">Line progress</h2>

      <div className="card card-flush">
        <div className="card-header">
          {total != null ? (
            <Badge tone={complete ? "success" : "neutral"} dot={complete}>
              {checked} of {total} lines checked
            </Badge>
          ) : (
            <Badge>{checked} checked &middot; no total set</Badge>
          )}

          {/* Document Control's figure: how many lines this project holds. */}
          <form action={setTotalLines.bind(null, progress.projectId)} className="flex items-center gap-2">
            <label htmlFor="total-lines" className="text-xs font-medium text-muted-foreground">
              Total lines
            </label>
            <input
              id="total-lines"
              name="total"
              type="number"
              min={0}
              max={100000}
              step={1}
              inputMode="numeric"
              defaultValue={total ?? ""}
              placeholder="e.g. 40"
              className="input input-sm w-24"
            />
            <button type="submit" className="btn btn-secondary btn-sm">
              Save
            </button>
          </form>
        </div>

        <div className="flex flex-col gap-4 p-5">
          {total != null ? (
            <ProgressBar value={checked} max={total} label="Line progress" />
          ) : (
            <p className="text-sm text-muted-foreground">Enter the total number of lines to measure progress.</p>
          )}

          <div className="flex flex-wrap gap-4">
            <Stat label="Checked" value={checked} tone={complete ? "good" : "neutral"} />
            <Stat label="Total lines" value={total ?? "—"} />
            {total != null && <Stat label="Remaining" value={Math.max(0, total - checked)} />}
            <Stat label="ISO lines uploaded" value={progress.uploaded} hint="read from the drawings so far" />
          </div>

          {total != null && checked > total && (
            <Alert tone="warning">More lines are marked done than the total you entered. The total may be out of date.</Alert>
          )}

          <details open className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
              <IconChevronDown size={16} className="text-muted-foreground transition-transform group-open:rotate-180" />
              Checked lines <span className="font-normal text-muted-foreground">({checked})</span>
            </summary>
            <div className="mt-3">
              {checked === 0 ? (
                <p className="text-sm text-muted-foreground">No line has been marked done yet.</p>
              ) : (
                <div className="max-h-80 overflow-auto rounded-lg border">
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th>Line number</th>
                        <th>Checked by</th>
                        <th>When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {progress.reviews.map((r) => (
                        <tr key={r.lineKey}>
                          <td className="break-all font-mono text-xs font-medium">{r.lineNumber}</td>
                          <td>{r.reviewedByName ?? "-"}</td>
                          <td className="whitespace-nowrap text-muted-foreground">{when.format(r.reviewedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}
