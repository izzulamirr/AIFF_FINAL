import Link from "next/link";
import type { ReactNode } from "react";
import { BRAND_NAME, BrandLockup } from "@/components/ui/Brand";

// The frame with no sidebar: a plain top bar and nothing else.
//
// A checker's whole path through the app is client -> project -> line,
// and each of those pages carries its own "back" link (see PageHeader's `back`
// prop), so there is no second navigation system to keep in step with the first.
//
// Document Control gets it too, but only until it has chosen a client --
// the picker comes first, and the sidebar (AppShell) opens once it has. See
// (app)/layout.tsx.
export function GuidedShell({
  email,
  name,
  roleLabel,
  readOnly = true,
  signOut,
  children,
}: {
  email: string;
  name: string | null;
  roleLabel: string;
  /** A checker is read-only; Document Control, at the client picker, is not. */
  readOnly?: boolean;
  signOut: ReactNode;
  children: ReactNode;
}) {
  const displayName = name ?? email;
  const initial = (displayName.trim()[0] ?? "?").toUpperCase();

  return (
    <div className="min-h-screen bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg"
      >
        Skip to content
      </a>

      <header className="app-chrome sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b bg-card px-4 sm:px-6 lg:px-10">
        <Link href="/clients" aria-label={`${BRAND_NAME} home`}>
          <BrandLockup />
        </Link>
        <div className="flex items-center gap-3">
          <div className="hidden text-right leading-tight sm:block">
            <p className="truncate text-[0.8125rem] font-medium" title={email}>
              {displayName}
            </p>
            <p className="text-[0.6875rem] text-muted-foreground">
              {roleLabel}
              {readOnly && <> &middot; read-only</>}
            </p>
          </div>
          <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-muted text-[0.8125rem] font-semibold ring-1 ring-border">
            {initial}
          </span>
          {signOut}
        </div>
      </header>

      <main id="main" className="app-content mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-10 lg:py-9">
        {children}
      </main>
    </div>
  );
}
