// Shown the moment a link is clicked, while the next page is worked out on the
// server. Without it the old page stays on screen with no sign anything is
// happening, which reads as the app not responding. The top bar is the layout's
// and stays put; only the content area is replaced.
export default function Loading() {
  const block = "animate-pulse rounded-lg bg-muted";
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-8">
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-2" aria-hidden="true">
        <div className={`${block} h-3.5 w-28`} />
        <div className={`${block} h-7 w-72`} />
        <div className={`${block} h-5 w-24 rounded-full`} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className={`${block} h-28`} />
        ))}
      </div>
      <div className={`${block} h-72`} aria-hidden="true" />
    </div>
  );
}
