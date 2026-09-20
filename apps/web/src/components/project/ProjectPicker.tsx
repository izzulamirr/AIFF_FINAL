"use client";

import { useRouter } from "next/navigation";

// Which project a Document Control page is about. Navigates as soon as it
// changes, like the pickers on the tool pages: choosing a project is a
// navigation, not a form. `basePath` is the page to stay on -- the dashboard and
// the line review both use it.
export function ProjectPicker({
  projects,
  projectId,
  basePath,
}: {
  projects: Array<{ id: string; label: string }>;
  projectId: string;
  basePath: string;
}) {
  const router = useRouter();

  return (
    <div className="card flex flex-wrap items-end gap-4 p-4">
      <div className="w-full sm:w-auto">
        <label htmlFor="project-picker" className="field-label">
          Project
        </label>
        <select
          id="project-picker"
          value={projectId}
          onChange={(e) => router.push(`${basePath}?project=${e.target.value}`)}
          className="input sm:min-w-72"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
