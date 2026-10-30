// How far through. `value` is everything done; `recheck` is the part of it that was
// done but whose documents have changed since, drawn amber instead of green. It
// still counts in the percentage -- the work was done -- but "nearly done" and
// "nearly done, but five need looking at again" do not look the same.

export function ProgressBar({ value, max, label, recheck = 0 }: { value: number; max: number; label: string; recheck?: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const recheckPct = max > 0 ? Math.min(pct, Math.round((recheck / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-3">
      <div
        className="flex h-2 flex-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full bg-success-solid transition-[width]" style={{ width: `${pct - recheckPct}%` }} />
        {recheckPct > 0 && <div className="h-full bg-warning-solid transition-[width]" style={{ width: `${recheckPct}%` }} />}
      </div>
      <span className="w-10 text-right text-xs font-medium tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}
