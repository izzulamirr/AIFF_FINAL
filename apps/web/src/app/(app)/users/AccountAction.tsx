"use client";

import { useState, useTransition, type ReactNode } from "react";

// A button that asks before it acts and, if the server refuses, says why under it
// -- rather than the whole page giving way to an error screen. For deactivating,
// reactivating and deleting an account, where a refusal ("wrote finding comments,
// keep it deactivated instead") is an answer the person needs to read.
export function AccountAction({
  message,
  action,
  className,
  children,
}: {
  /** The question asked before anything happens. */
  message: string;
  /** Bound to this account by the page. */
  action: () => Promise<void>;
  className: string;
  children: ReactNode;
}) {
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState<string | null>(null);

  function run() {
    if (!window.confirm(message)) return;
    setFailed(null);
    startTransition(async () => {
      try {
        await action();
      } catch (err) {
        setFailed(err instanceof Error ? err.message : "That did not work.");
      }
    });
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button type="button" onClick={run} disabled={pending} className={className}>
        {pending ? "Working…" : children}
      </button>
      {failed && <span className="max-w-56 text-right text-xs text-danger">{failed}</span>}
    </span>
  );
}
