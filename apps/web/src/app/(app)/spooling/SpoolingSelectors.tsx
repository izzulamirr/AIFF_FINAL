"use client";

import { useRouter } from "next/navigation";

// Project and drawing pickers that navigate as soon as they change -- same
// reason as the cutting and hook-up pages': switching project is a navigation,
// and a plain GET form left the page rendering the previous project's
// documents.
export function SpoolingSelectors({
  projects,
  projectId,
  drawings,
  drawingId,
  basePath = "/spooling",
  showProject = true,
  line,
}: {
  projects: Array<{ id: string; label: string }>;
  projectId: string;
  drawings: Array<{ id: string; label: string }>;
  drawingId: string;
  /** Which page to navigate within -- the container page reuses these. */
  basePath?: string;
  /**
   * Off for a plain user, who has already chosen the project (Organization ->
   * Project -> here) and should see only that project's drawings -- a list of
   * every other project would just be a way to wander out of it.
   */
  showProject?: boolean;
  /** The ISO line the page is scoped to, kept across a change of drawing. */
  line?: string;
}) {
  const router = useRouter();

  const go = (nextProject: string, nextDrawing: string) => {
    const params = new URLSearchParams({ project: nextProject });
    // A line belongs to a project, so switching project drops it.
    if (line && nextProject === projectId) params.set("line", line);
    if (nextDrawing) params.set("drawing", nextDrawing);
    router.push(`${basePath}?${params.toString()}`);
  };

  return (
    <div className="card flex flex-wrap items-end gap-4 p-4">
      {showProject && (
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
      )}
      <div className="w-full sm:w-auto">
        <label htmlFor="drawing-select" className="field-label">
          Isometric
        </label>
        <select id="drawing-select" value={drawingId} onChange={(e) => go(projectId, e.target.value)} className="input sm:min-w-72">
          {/* A spool belongs to one drawing and is fabricated from it, so a
              single isometric is the unit of work -- but the default shows
              every one in the project so a shop can see the whole scope. */}
          <option value="">All isometrics in this project</option>
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
