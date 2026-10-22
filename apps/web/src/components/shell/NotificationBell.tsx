"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { IconBell } from "@/components/ui/icons";

// The bell in the top bar: drawing revisions that have changed.
//
// A client component only for opening and closing -- the notices are worked out
// on the server (lib/notifications.ts) and arrive as plain strings, already
// formatted, so nothing here knows how a revision is decided.

export interface BellNotice {
  key: string;
  href: string;
  projectName: string;
  lineNumber: string;
  change: string;
  when: string;
  fileName: string | null;
  /** "You checked this at rev 0" -- set only when this person's tick is now out of date. */
  yourCheck: string | null;
  unread: boolean;
}

export function NotificationBell({
  notices,
  unread,
  markRead,
}: {
  notices: BellNotice[];
  unread: number;
  /** Absent until the notifications table exists, so there is nothing to mark. */
  markRead?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Close on a click outside or on Escape -- the bar stays mounted across
  // navigation, so a panel left open would follow the person to the next page.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className="btn btn-ghost btn-sm relative"
      >
        <IconBell size={16} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger-solid px-1 text-[10px] font-semibold leading-none text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <p className="text-sm font-semibold">Drawing revisions</p>
            {markRead && unread > 0 && (
              <form action={markRead}>
                <button className="text-xs font-medium text-link hover:underline">Mark all read</button>
              </form>
            )}
          </div>

          {notices.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">No revision changes.</p>
          ) : (
            <ul className="max-h-[60vh] divide-y divide-border overflow-y-auto">
              {notices.map((n) => (
                <li key={n.key}>
                  <Link
                    href={n.href}
                    onClick={() => setOpen(false)}
                    className={`block px-4 py-3 transition-colors hover:bg-muted ${n.unread ? "bg-primary-soft/40" : ""}`}
                  >
                    <div className="flex items-start gap-2">
                      {n.unread && <span className="mt-1.5 h-2 w-2 flex-none rounded-full bg-primary" aria-label="unread" />}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{n.lineNumber}</p>
                        <p className="text-sm">{n.change}</p>
                        {n.yourCheck && <p className="mt-0.5 text-xs font-medium text-warning">{n.yourCheck}</p>}
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {n.projectName} &middot; {n.when}
                          {n.fileName && <> &middot; {n.fileName}</>}
                        </p>
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {!markRead && (
            <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              Read tracking is off until supabase/notifications.sql has been run.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
