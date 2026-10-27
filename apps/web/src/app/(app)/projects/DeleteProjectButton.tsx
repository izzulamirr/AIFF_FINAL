"use client";

import { useState, useTransition } from "react";
import { IconTrash } from "@/components/ui/icons";
import { deleteProject, setProjectHidden } from "../actions";

// Hiding takes nothing away -- the project only drops out of the lists, and the
// dashboard's "Hidden projects" puts it back -- so it needs no confirmation.
export function HideProjectButton({ projectId, name, hidden = false }: { projectId: string; name: string; hidden?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        disabled={pending}
        aria-label={`${hidden ? "Show" : "Hide"} project ${name}`}
        className="btn btn-secondary btn-xs"
        onClick={() => {
          setError(null);
          startTransition(async () => {
            try {
              await setProjectHidden(projectId, !hidden);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Failed.");
            }
          });
        }}
      >
        {pending ? (hidden ? "Showing…" : "Hiding…") : hidden ? "Show" : "Hide"}
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </>
  );
}

// Deleting a project takes every drawing, extraction, finding and library file
// in it, with no undo -- so a plain OK is not enough. Typing the name is what
// stops the wrong row in a list of look-alike projects being removed.
export function DeleteProjectButton({ projectId, name }: { projectId: string; name: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        disabled={pending}
        aria-label={`Delete project ${name}`}
        className="btn btn-danger btn-xs"
        onClick={() => {
          const typed = window.prompt(
            `Delete the project "${name}"?\n\nEvery document, extraction, check result and library file in it is removed for everyone. This cannot be undone.\n\nType the project name to confirm:`
          );
          if (typed == null) return;
          if (typed.trim() !== name.trim()) {
            setError("The name did not match, so nothing was deleted.");
            return;
          }
          setError(null);
          startTransition(async () => {
            try {
              await deleteProject(projectId);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Delete failed.");
            }
          });
        }}
      >
        <IconTrash size={13} />
        {pending ? "Deleting…" : "Delete"}
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </>
  );
}
