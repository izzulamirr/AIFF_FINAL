"use client";

import { useRouter } from "next/navigation";

// Project and drawing pickers that navigate as soon as they change -- same
// reason as the hook-up page's: switching project is a navigation, and a
// plain GET form left the page rendering the previous project's documents.
export function CuttingSelectors({
  projects,
  projectId,
  drawings,
  drawingId,
}: {
  projects: Array<{ id: string; label: string }>;
  projectId: string;
  drawings: Array<{ id: string; label: string }>;
  drawingId: string;
}) {
  const router = useRouter();

  const go = (nextProject: string, nextDrawing: string) => {
    const params = new URLSearchParams({ project: nextProject });
    if (nextDrawing) params.set("drawing", nextDrawing);
    router.push(`/cutting?${params.toString()}`);
  };

  return (
    <div className="card flex flex-wrap items-end gap-4 p-4">
      <div className="w-full sm:w-auto">
        <label htmlFor="project-select" className="field-label">
          Project
        </label>
        <select id="project-select" value={projectId} onChange={(e) => go(e.target.value, "")} className="input sm:min-w-64">
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="w-full sm:w-auto">
        <label htmlFor="drawing-select" className="field-label">
          Parts to nest
        </label>
        <select id="drawing-select" value={drawingId} onChange={(e) => go(projectId, e.target.value)} className="input sm:min-w-72">
          {/* A job is cut from one stock of plate whatever it was drawn on, so
              nesting every cutting drawing in the project together is the
              default -- splitting the run per drawing only buys more plate. */}
          <option value="">All cutting drawings in this project</option>
          {drawings.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
