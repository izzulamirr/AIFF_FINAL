import type { ReactNode } from "react";
import { BrandLockup } from "@/components/ui/Brand";

// The frame shared by sign-in and sign-up: a drawing-grid brand panel beside
// the form on wide screens, just the form on narrow ones. `panel` is whatever
// the left side has to say for that page.
export function AuthShell({ panel, children }: { panel: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <aside className="blueprint relative hidden flex-col justify-between overflow-hidden p-12 text-sidebar-foreground lg:flex">
        <BrandLockup size={38} full className="relative" nameClassName="text-lg text-sidebar-strong" fullClassName="text-sidebar-muted" />

        <div className="relative max-w-lg">{panel}</div>

        <p className="relative text-xs tracking-wide text-sidebar-muted">P&amp;ID &middot; Isometric &middot; Hook-up &middot; Cutting plate</p>
      </aside>

      <main className="flex items-center justify-center bg-background px-6 py-12">
        <div className="w-full max-w-sm">
          <BrandLockup size={34} full className="mb-8 lg:hidden" nameClassName="text-lg" />
          {children}
        </div>
      </main>
    </div>
  );
}
