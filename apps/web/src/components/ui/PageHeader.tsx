import Link from "next/link";
import type { ReactNode } from "react";
import { IconArrowLeft } from "./icons";

// The top of every page: an optional way back, the title, a line saying what
// the page is for, and any actions that belong to the page as a whole.
// One component so every page opens the same way.
export function PageHeader({
  title,
  description,
  back,
  meta,
  actions,
}: {
  title: ReactNode;
  /** What the page is for. Kept to a couple of lines; longer explanation belongs in a callout. */
  description?: ReactNode;
  back?: { href: string; label: string };
  /** Badges and small facts that sit directly under the title. */
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        {back && (
          <Link
            href={back.href}
            className="mb-2 inline-flex items-center gap-1.5 text-[0.8125rem] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <IconArrowLeft size={14} />
            {back.label}
          </Link>
        )}
        <h1 className="break-words text-2xl font-semibold tracking-tight">{title}</h1>
        {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
        {description && <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
