// A drawing revision, as a small "Rev 2" pill.
//
// `tone="changed"` is for a revision that has moved on since something was
// checked -- the same pill, in the warning colour, so it reads as "this is not
// the revision you checked".

export function RevMark({ rev, tone = "neutral", size = 22, title }: { rev: string; tone?: "neutral" | "changed"; size?: number; title?: string }) {
  // `size` scales the pill: 22 is the inline size, larger for a heading.
  const large = size >= 26;
  return (
    <span
      title={title ?? `Revision ${rev}`}
      className={`inline-flex flex-none items-center gap-1 rounded-md border align-middle font-semibold tabular-nums ${
        large ? "px-2 py-0.5 text-[0.9375rem]" : "px-1.5 text-xs leading-5"
      } ${tone === "changed" ? "border-warning-border bg-warning-soft text-warning" : "border-border bg-muted text-foreground"}`}
    >
      <span className="font-medium text-muted-foreground">Rev</span>
      {rev}
    </span>
  );
}
