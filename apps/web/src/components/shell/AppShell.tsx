"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BrandMark, IconBuilding, IconClipboard, IconClose, IconDashboard, IconFolder, IconLibrary, IconMenu, IconUsers } from "@/components/ui/icons";

// The frame around Document Control's pages: a top bar with the brand, the
// organization it is working in, the pages, and who is signed in. On narrow
// screens the pages fold into a menu.
//
// It matches the bar the organization picker and the checkers get (GuidedShell),
// so choosing an organization does not change how the app looks.
//
// It is a client component only because the bar highlights the page you are on
// (usePathname) and the menu opens and closes. The auth check and the sign-out
// and switch-organization actions stay in the server layout that renders this --
// they arrive as props, already bound to their server actions.

interface NavItem {
  href: string;
  label: string;
  icon: typeof IconDashboard;
}

// The places Document Control works from. The engineering tools are not here:
// they open from the dashboard and from a project, already on the project being
// worked on, rather than from a link that has to guess which one.
const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: IconDashboard },
  { href: "/projects", label: "Projects", icon: IconFolder },
  { href: "/review", label: "Line review", icon: IconClipboard },
  { href: "/library", label: "Library", icon: IconLibrary },
  { href: "/users", label: "Users", icon: IconUsers },
];

// Who is signed in, passed down from the server layout. `roleLabel` is the
// finished wording rather than the role itself, so the list of Document Control
// accounts never has to reach the browser.
interface Identity {
  email: string;
  name: string | null;
  roleLabel: string;
  isDcc: boolean;
}

// The organization Document Control is working in. `switcher` arrives already
// bound to its server action, like `signOut`.
interface Workspace {
  name: string;
  switcher: ReactNode;
}

function NavLinks({ vertical = false, onNavigate }: { vertical?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <ul className={vertical ? "flex flex-col gap-1" : "flex items-center gap-1"}>
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = isActive(href);
        return (
          <li key={href}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                active ? "bg-primary-soft text-link" : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Icon size={16} />
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function OrganizationChip({ organization, className = "" }: { organization: Workspace; className?: string }) {
  return (
    <div className={`items-center gap-2 rounded-lg border bg-muted/40 py-1 pl-2.5 pr-1 ${className}`}>
      <IconBuilding size={15} className="flex-none text-muted-foreground" />
      <span className="min-w-0 max-w-44 truncate text-sm font-medium" title={organization.name}>
        {organization.name}
      </span>
      {organization.switcher}
    </div>
  );
}

function Person({ name, email, roleLabel, className = "" }: Identity & { className?: string }) {
  const displayName = name ?? email;
  const initial = (displayName.trim()[0] ?? "?").toUpperCase();
  return (
    <div className={`items-center gap-2.5 ${className}`}>
      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-muted text-[0.8125rem] font-semibold ring-1 ring-border">
        {initial}
      </span>
      <div className="min-w-0 leading-tight">
        <p className="max-w-40 truncate text-[0.8125rem] font-medium" title={email}>
          {displayName}
        </p>
        <p className="text-[0.6875rem] text-muted-foreground">{roleLabel}</p>
      </div>
    </div>
  );
}

export function AppShell({
  signOut,
  organization,
  children,
  ...identity
}: Identity & { organization?: Workspace; signOut: ReactNode; children: ReactNode }) {
  const pathname = usePathname();
  // The menu records the page it was opened on and counts as open only while you
  // are still on it, so following any link closes it -- no effect needed to reset
  // it on navigation.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpenOn(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenOn(null);
    };
    window.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="min-h-screen bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg"
      >
        Skip to content
      </a>

      <header className="app-chrome sticky top-0 z-30 border-b bg-card">
        <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center gap-3 px-4 sm:px-6 lg:px-10">
          <button
            type="button"
            aria-label="Open menu"
            aria-expanded={open}
            onClick={() => setOpenOn(pathname)}
            className="btn btn-ghost -ml-2 h-9 w-9 p-0 lg:hidden"
          >
            <IconMenu />
          </button>

          <Link href="/dashboard" className="flex items-center gap-2.5">
            <BrandMark size={28} />
            <span className="font-semibold tracking-wide">EASY</span>
          </Link>

          {organization && <OrganizationChip organization={organization} className="ml-2 hidden lg:flex" />}

          <nav aria-label="Main" className="ml-2 hidden lg:block">
            <NavLinks />
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <Person {...identity} className="hidden sm:flex" />
            {signOut}
          </div>
        </div>
      </header>

      {open && (
        <div className="app-chrome fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div
            className="drawer-backdrop absolute inset-0 bg-black/55"
            style={{ animation: "fade-in 0.15s ease-out" }}
            onClick={close}
            aria-hidden="true"
          />
          <div
            className="drawer-panel absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col gap-5 bg-card p-4 shadow-2xl"
            style={{ animation: "drawer-in 0.2s ease-out" }}
          >
            <div className="flex items-center justify-between">
              <Link href="/dashboard" onClick={close} className="flex items-center gap-2.5">
                <BrandMark size={28} />
                <span className="font-semibold tracking-wide">EASY</span>
              </Link>
              <button ref={closeRef} type="button" aria-label="Close menu" onClick={close} className="btn btn-ghost h-9 w-9 p-0">
                <IconClose size={18} />
              </button>
            </div>

            {organization && <OrganizationChip organization={organization} className="flex w-full" />}

            <nav aria-label="Main">
              <NavLinks vertical onNavigate={close} />
            </nav>

            <div className="mt-auto border-t pt-4">
              <Person {...identity} className="flex" />
            </div>
          </div>
        </div>
      )}

      <main id="main" className="app-content mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-10 lg:py-9">
        {children}
      </main>
    </div>
  );
}
