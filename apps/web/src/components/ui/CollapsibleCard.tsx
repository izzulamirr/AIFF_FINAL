import type { ReactNode } from "react";
import { IconChevronDown, type IconGauge } from "./icons";

// A card that folds: its head always shows -- what it is, and a few badges that
// say how it stands -- and its body, the full data, opens on demand.
//
// A native <details>, so it needs no client state, opens from the keyboard, and
// is announced correctly by a screen reader. `defaultOpen` is for the one thing
// a reader wants to see the moment the page loads.
export function CollapsibleCard({
  icon: Icon,
  title,
  text,
  status,
  badges,
  defaultOpen = false,
  children,
}: {
  icon: typeof IconGauge;
  title: string;
  text: string;
  /** Sits beside the title -- a "Template" flag, say. */
  status?: ReactNode;
  /** How it stands, at a glance, while it is folded. */
  badges?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={defaultOpen} className="card card-flush group">
      <summary className="flex cursor-pointer list-none items-start gap-3 px-5 py-4 transition-colors hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-primary-soft text-link">
          <Icon />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="card-title flex flex-wrap items-center gap-2">
            {title}
            {status}
          </h2>
          <p className="card-description">{text}</p>
          {badges && <div className="mt-2.5 flex flex-wrap items-center gap-2">{badges}</div>}
        </div>
        <span className="mt-1 flex flex-none items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span className="group-open:hidden">Show data</span>
          <span className="hidden group-open:inline">Hide data</span>
          <IconChevronDown size={16} className="transition-transform group-open:rotate-180" />
        </span>
      </summary>
      <div className="border-t p-5">{children}</div>
    </details>
  );
}
