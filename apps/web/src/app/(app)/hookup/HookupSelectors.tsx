"use client";

import { useRouter } from "next/navigation";

// Project and ISO pickers that navigate as soon as they change.
//
// These were a plain GET form with a submit button, which looked like it
// worked and did not: changing the project only altered the <select>'s local
// value, so the page kept rendering the previous project's documents and the
// ISO list stayed full of another project's drawings. Switching project is a
// navigation, not a form submission, so it is treated as one here.
export function HookupSelectors({
  projects,
  projectId,
  isos,
  isoId,
  showProject = true,
  line,
}: {
  projects: Array<{ id: string; label: string }>;
  projectId: string;
  isos: Array<{ id: string; label: string }>;
  isoId: string;
  /** Off for a plain user, who has already chosen the project -- see SpoolingSelectors. */
  showProject?: boolean;
  /** The ISO line the page is scoped to, kept across a change of ISO. */
  line?: string;
}) {
  const router = useRouter();

  // Changing either selection invalidates the per-instrument typical
  // overrides carried in the URL -- they are keyed to the ISO being checked.
  const go = (nextProject: string, nextIso: string) => {
    const params = new URLSearchParams({ project: nextProject });
    // A line belongs to a project, so switching project drops it.
    if (line && nextProject === projectId) params.set("line", line);
    if (nextIso) params.set("iso", nextIso);
    router.push(`/hookup?${params.toString()}`);
  };

  return (
    <div className="card flex flex-wrap items-end gap-4 p-4">
      {showProject && (
        <div className="w-full sm:w-auto">
          <label htmlFor="project-select" className="field-label">
            Project
          </label>
          <select
            id="project-select"
            value={projectId}
            onChange={(e) => go(e.target.value, "")}
            className="input sm:min-w-64"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="w-full sm:w-auto">
        <label htmlFor="iso-select" className="field-label">
          ISO to verify
        </label>
        <select
          id="iso-select"
          value={isoId}
          onChange={(e) => go(projectId, e.target.value)}
          className="input sm:min-w-72"
        >
          <option value="">-- select an ISO --</option>
          {isos.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      {isos.length === 0 && <p className="text-sm text-muted-foreground">This project has no extracted ISO to verify.</p>}
    </div>
  );
}
