import type { ReactNode } from "react";
import { BrandMark } from "@/components/ui/icons";

// The frame shared by sign-in and sign-up: a drawing-grid brand panel beside
// the form on wide screens, just the form on narrow ones. `panel` is whatever
// the left side has to say for that page.
export function AuthShell({ panel, children }: { panel: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <aside className="blueprint relative hidden flex-col justify-between overflow-hidden p-12 text-sidebar-foreground lg:flex">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{ background: "radial-gradient(60% 50% at 15% 0%, rgba(59,130,246,0.22), transparent 70%)" }}
        />
        <div className="relative flex items-center gap-3">
          <BrandMark size={38} />
          <span className="text-lg font-semibold tracking-wide text-sidebar-strong">EASY</span>
        </div>

        <div className="relative max-w-lg">{panel}</div>

        <p className="relative text-xs text-sidebar-muted">P&amp;ID &middot; ISO &middot; Hook-up &middot; Cutting plate</p>
      </aside>

      <main className="flex items-center justify-center bg-background px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandMark size={34} />
            <span className="text-lg font-semibold tracking-wide">EASY</span>
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
