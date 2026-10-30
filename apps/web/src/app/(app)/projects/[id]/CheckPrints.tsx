import { Badge } from "@/components/ui/primitives";
import { IconClipboard } from "@/components/ui/icons";
import { checkPrintLabel, MAX_CHECK_PRINTS, type CheckPrint, type NextStep } from "@/lib/checkPrints";

// The line's check prints as four steps -- CP-01, CP-02, CP-03, Final -- so where
// the line is in the cycle reads at a glance: what has been issued (with the ISO
// revision and the errors it went back with), and what comes next.

const day = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

export function CheckPrints({
  prints,
  allPrints = prints,
  revision,
  next,
  errorCount,
  done,
}: {
  /** This line's check prints on the ISO revision now in force, oldest first. */
  prints: CheckPrint[];
  /** Every check print on the line, earlier revisions included. */
  allPrints?: CheckPrint[];
  /** The ISO revision now in force. */
  revision: string | null;
  next: NextStep | undefined;
  errorCount: number | null;
  /** The line is marked done (issued Final). */
  done: boolean;
}) {
  const cps = prints.filter((p) => p.kind === "cp");
  const final = prints.filter((p) => p.kind === "final").pop();
  const steps = [
    ...Array.from({ length: MAX_CHECK_PRINTS }, (_, i) => ({ label: checkPrintLabel({ kind: "cp", seq: i + 1 }), print: cps[i] })),
    { label: "Final", print: final },
  ];
  const nextLabel = next && (next.step === "cp" || next.step === "final") ? next.label : null;
  const earlierRevisions = [
    ...allPrints
      .filter((p) => (p.isoRevision ?? null) !== (revision ?? null))
      .reduce((m, p) => m.set(p.isoRevision ?? "—", [...(m.get(p.isoRevision ?? "—") ?? []), p]), new Map<string, CheckPrint[]>()),
  ];

  const summary =
    errorCount === null
      ? "The checks could not be run on this line, so nothing can be issued."
      : done && final
        ? "Issued Final with no errors. The line is done."
        : errorCount === 0
          ? "No errors on this line. Issue it Final to mark it done."
          : next?.step === "waiting"
            ? `${next.label} has gone back to the designer. The next check print is issued on the revised ISO.`
            : next?.step === "blocked"
              ? `All ${MAX_CHECK_PRINTS} check prints have been issued and ${errorCount} error${errorCount === 1 ? "" : "s"} remain. Final needs them fixed.`
              : `${errorCount} error${errorCount === 1 ? "" : "s"} on this line. Issue ${nextLabel ?? "a check print"} to send it back to the designer.`;

  return (
    <section className="card card-flush">
      <div className="card-header justify-start gap-3">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-primary-soft text-link">
          <IconClipboard size={18} />
        </span>
        <div className="text-left">
          <h2 className="card-title">Check prints{revision ? ` · REV ${revision}` : ""}</h2>
          <p className="card-description">{summary}</p>
        </div>
      </div>
      <ol className="grid grid-cols-2 gap-3 p-5 md:grid-cols-4">
        {steps.map(({ label, print }) => {
          const isNext = !print && label === nextLabel;
          const tone = print
            ? print.kind === "final"
              ? "border-success bg-success-soft"
              : "border-border bg-card"
            : isNext
              ? "border-link border-dashed bg-primary-soft/40"
              : "border-dashed border-border bg-muted/30";
          return (
            <li key={label} className={`flex flex-col gap-1 rounded-lg border px-3.5 py-3 ${tone}`}>
              <span className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm font-semibold">{label}</span>
                {print ? (
                  <Badge tone={print.kind === "final" ? "success" : print.errorCount > 0 ? "warning" : "success"} dot>
                    {print.kind === "final" ? "Issued" : `${print.errorCount} error${print.errorCount === 1 ? "" : "s"}`}
                  </Badge>
                ) : isNext ? (
                  <Badge tone="info">Next</Badge>
                ) : null}
              </span>
              {print ? (
                <span className="text-xs text-muted-foreground">
                  {day.format(print.issuedAt)} &middot; ISO REV {print.isoRevision ?? "—"}
                  {print.issuedByName ? ` · ${print.issuedByName}` : ""}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">{label === "Final" ? "Needs zero errors" : "Not issued"}</span>
              )}
            </li>
          );
        })}
      </ol>
      {/* Earlier revisions ran their own cycle; how each ended, in one line. */}
      {earlierRevisions.length > 0 && (
        <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
          Earlier revisions:{" "}
          {earlierRevisions.map(([rev, list], i) => {
            const last = list[list.length - 1];
            return (
              <span key={rev}>
                {i > 0 && " · "}
                REV {rev}: {checkPrintLabel(last)} ({day.format(last.issuedAt)})
              </span>
            );
          })}
        </p>
      )}
    </section>
  );
}
