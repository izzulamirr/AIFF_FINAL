"use client";

import { useState, useTransition } from "react";
import { IconTrash } from "@/components/ui/icons";

// Removing a library file deletes the stored copy too, with no undo, so it asks
// first and names the file.
export function DeleteLibraryButton({ title, onDelete }: { title: string; onDelete: () => Promise<void> }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        disabled={pending}
        aria-label={`Delete ${title}`}
        className="btn btn-danger btn-xs"
        onClick={() => {
          if (!window.confirm(`Delete "${title}" from the library?\n\nThe file is removed for everyone. This cannot be undone.`)) return;
          setError(null);
          startTransition(async () => {
            try {
              await onDelete();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Delete failed.");
            }
          });
        }}
      >
        <IconTrash size={13} />
        {pending ? "Deleting…" : "Delete"}
      </button>
      {error && <span className="ml-2 text-xs text-danger">{error}</span>}
    </>
  );
}
