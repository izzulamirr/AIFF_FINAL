// How far through. `value` is everything done; `recheck` is the part of it that was
// done but whose documents have changed since, drawn amber instead of green. It
// still counts in the percentage -- the work was done -- but "nearly done" and
// "nearly done, but five need looking at again" do not look the same.
//
// `of`, where given, puts the count beside the bar ("18 of 40 · 45%"), so a row
// needs no separate badge saying the same thing.

export function ProgressBar({
  value,
  max,
  label,
  recheck = 0,
  of,
}: {
  value: number;
  max: number;
  label: string;
  recheck?: number;
  /** The denominator as a reader would say it: 40, or "40 uploaded". */
  of?: number | string;
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const recheckPct = max > 0 ? Math.min(pct, Math.round((recheck / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-3">
      <div
        className="flex h-1.5 flex-1 overflow-hidden rounded-[2px] bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full bg-success-solid transition-[width] motion-reduce:transition-none" style={{ width: `${pct - recheckPct}%` }} />
        {recheckPct > 0 && <div className="h-full bg-warning-solid transition-[width] motion-reduce:transition-none" style={{ width: `${recheckPct}%` }} />}
      </div>
      <span className="whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground">
        {of !== undefined && (
          <>
            <span className="font-semibold text-foreground">{value}</span> of {of}
            <span className="mx-1.5 text-border-strong">|</span>
          </>
        )}
        <span className={of === undefined ? "inline-block w-10 font-medium" : ""}>{pct}%</span>
      </span>
    </div>
  );
}
