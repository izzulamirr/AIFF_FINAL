"use client";

import { useState, useTransition } from "react";
import type { AppRole } from "@/lib/roles";

// One person's role, in the staff table: a picker of the three roles that asks
// before it changes anything. The wording arrives from the server (labels and what
// each role can do), so this file imports only the role TYPE from lib/roles.ts.

export function RoleControl({
  personLabel,
  role,
  options,
  setRole,
}: {
  personLabel: string;
  role: AppRole;
  options: Array<{ value: AppRole; label: string; description: string }>;
  /** Bound to this account by the page. */
  setRole: (role: AppRole) => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState<string | null>(null);

  function change(next: AppRole) {
    if (next === role) return;
    const option = options.find((o) => o.value === next);
    if (!option || !window.confirm(`Make ${personLabel} ${option.label}?\n\n${option.description}`)) return;
    setFailed(null);
    startTransition(async () => {
      try {
        await setRole(next);
      } catch (err) {
        setFailed(err instanceof Error ? err.message : "That did not save.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <select
        value={role}
        disabled={pending}
        onChange={(e) => change(e.target.value as AppRole)}
        aria-label={`Role for ${personLabel}`}
        className="input input-sm w-auto min-w-[11rem]"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {pending && <span className="text-xs text-muted-foreground">Saving…</span>}
      {failed && <span className="text-xs text-danger">{failed}</span>}
    </div>
  );
}
