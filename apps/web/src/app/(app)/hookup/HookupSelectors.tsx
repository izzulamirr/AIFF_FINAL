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
}: {
  projects: Array<{ id: string; label: string }>;
  projectId: string;
  isos: Array<{ id: string; label: string }>;
  isoId: string;
}) {
  const router = useRouter();

  // Changing either selection invalidates the per-instrument typical
  // overrides carried in the URL -- they are keyed to the ISO being checked.
  const go = (nextProject: string, nextIso: string) => {
    const params = new URLSearchParams({ project: nextProject });
    if (nextIso) params.set("iso", nextIso);
    router.push(`/hookup?${params.toString()}`);
  };

  return (
    <div className="flex flex-wrap items-end gap-3 rounded border p-4">
      <label className="text-sm">
        Project
        <select
          value={projectId}
          onChange={(e) => go(e.target.value, "")}
          className="mt-1 block rounded border px-3 py-2"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        ISO to verify
        <select
          value={isoId}
          onChange={(e) => go(projectId, e.target.value)}
          className="mt-1 block rounded border px-3 py-2"
        >
          <option value="">-- select an ISO --</option>
          {isos.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      {isos.length === 0 && <p className="text-sm text-gray-500">This project has no extracted ISO to verify.</p>}
    </div>
  );
}
