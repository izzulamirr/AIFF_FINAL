"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BrandMark, IconBuilding, IconClipboard, IconClose, IconDashboard, IconFolder, IconMenu, IconUsers } from "@/components/ui/icons";

// The frame around every signed-in page: a navigation rail on wide screens, a
// top bar and slide-over drawer on narrow ones.
//
// It is a client component only because the rail highlights the page you are
// on (usePathname) and the drawer opens and closes. The auth check and the
// sign-out action stay in the server layout that renders this -- the sign-out
// form arrives as a prop, already bound to its server action.

interface NavItem {
  href: string;
  label: string;
  icon: typeof IconDashboard;
}

// The places Document Control works from. The engineering tools are not here:
// they open from the dashboard and from a project, already on the project being
// worked on, rather than from a link that has to guess which one.
const NAV: Array<{ heading: string; items: NavItem[] }> = [
  {
    heading: "Workspace",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: IconDashboard },
      { href: "/projects", label: "Projects", icon: IconFolder },
      { href: "/review", label: "Line review", icon: IconClipboard },
    ],
  },
  {
    heading: "Administration",
    items: [{ href: "/users", label: "Users", icon: IconUsers }],
  },
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

function SidebarContent({
  email,
  name,
  roleLabel,
  isDcc,
  organization,
  signOut,
  onNavigate,
}: Identity & { organization?: Workspace; signOut: ReactNode; onNavigate?: () => void }) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const displayName = name ?? email;
  const initial = (displayName.trim()[0] ?? "?").toUpperCase();

  return (
    <div className="flex h-full flex-col">
      <Link href="/dashboard" onClick={onNavigate} className="flex items-center gap-3 px-5 pb-4 pt-5">
        <BrandMark size={34} />
        <span className="leading-tight">
          <span className="block text-[0.9375rem] font-semibold tracking-wide text-sidebar-strong">EASY</span>
          <span className="block text-[0.6875rem] text-sidebar-muted">Engineering review</span>
        </span>
      </Link>

      {organization && (
        <div className="mx-3 mb-2 flex items-center gap-2.5 rounded-lg border border-sidebar-border bg-white/[0.03] py-2 pl-3 pr-2">
          <IconBuilding size={16} className="flex-none text-sidebar-muted" />
          <div className="min-w-0 flex-1">
            <p className="text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-sidebar-muted">Organization</p>
            <p className="truncate text-sm font-medium text-sidebar-strong" title={organization.name}>
              {organization.name}
            </p>
          </div>
          {organization.switcher}
        </div>
      )}

      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-2">
        {NAV.map((group) => (
          <div key={group.heading} className="mb-5">
            <p className="mb-1.5 px-3 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-sidebar-muted">{group.heading}</p>
            <ul className="flex flex-col gap-0.5">
              {group.items.map(({ href, label, icon: Icon }) => {
                const active = isActive(href);
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={`group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                        active
                          ? "bg-sidebar-active text-sidebar-strong"
                          : "text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-strong"
                      }`}
                    >
                      {active && <span aria-hidden="true" className="absolute -left-3 bottom-1.5 top-1.5 w-[3px] rounded-r bg-sidebar-accent" />}
                      <Icon size={18} className={active ? "text-sidebar-accent" : "text-sidebar-muted transition-colors group-hover:text-sidebar-foreground"} />
                      {label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-3 rounded-lg px-2 py-1.5">
          <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-sidebar-active text-[0.8125rem] font-semibold text-sidebar-strong ring-1 ring-sidebar-border">
            {initial}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[0.8125rem] font-medium text-sidebar-strong" title={email}>
              {displayName}
            </p>
            <p className={`truncate text-[0.6875rem] ${isDcc ? "font-medium text-sidebar-accent" : "text-sidebar-muted"}`}>
              {roleLabel}
              {isDcc ? "" : " · read-only"}
            </p>
          </div>
          {signOut}
        </div>
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
  // The drawer records the page it was opened on and counts as open only while
  // you are still on it, so following any link closes it -- no effect needed to
  // reset it on navigation.
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

      {/* Wide screens: a fixed rail. */}
      <aside className="app-chrome fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-sidebar-border bg-sidebar lg:block">
        <SidebarContent {...identity} organization={organization} signOut={signOut} />
      </aside>

      {/* Narrow screens: a slim bar that opens the same navigation as a drawer. */}
      <header className="app-chrome sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-card px-4 lg:hidden">
        <button
          type="button"
          aria-label="Open menu"
          aria-expanded={open}
          onClick={() => setOpenOn(pathname)}
          className="btn btn-ghost -ml-1 h-9 w-9 p-0"
        >
          <IconMenu />
        </button>
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <BrandMark size={28} />
          <span className="font-semibold tracking-wide">EASY</span>
        </Link>
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
            className="drawer-panel absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-sidebar shadow-2xl"
            style={{ animation: "drawer-in 0.2s ease-out" }}
          >
            <button
              ref={closeRef}
              type="button"
              aria-label="Close menu"
              onClick={close}
              className="absolute right-3 top-4 flex h-8 w-8 items-center justify-center rounded-md text-sidebar-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-strong"
            >
              <IconClose size={18} />
            </button>
            <SidebarContent {...identity} organization={organization} signOut={signOut} onNavigate={close} />
          </div>
        </div>
      )}

      <main id="main" className="lg:pl-64">
        <div className="app-content mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-10 lg:py-9">{children}</div>
      </main>
    </div>
  );
}
