"use client";

import { useState, useTransition } from "react";
import { IconTrash } from "@/components/ui/icons";

// Deleting a document also destroys its extraction and any findings raised
// from it, and there is no undo, so the button asks first and names the file
// it is about to remove rather than relying on the user's aim.
export function DeleteDocumentButton({
  fileName,
  onDelete,
}: {
  fileName: string;
  onDelete: () => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        disabled={pending}
        aria-label={`Delete ${fileName}`}
        className="btn btn-danger btn-xs"
        onClick={() => {
          if (!window.confirm(`Delete "${fileName}"?\n\nThis also removes its extracted data and any findings raised from it. This cannot be undone.`)) {
            return;
          }
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
