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
}: {
  projects: Array<{ id: string; label: string }>;
  projectId: string;
  drawings: Array<{ id: string; label: string }>;
  drawingId: string;
  /** Which page to navigate within -- the container page reuses these. */
  basePath?: string;
}) {
  const router = useRouter();

  const go = (nextProject: string, nextDrawing: string) => {
    const params = new URLSearchParams({ project: nextProject });
    if (nextDrawing) params.set("drawing", nextDrawing);
    router.push(`${basePath}?${params.toString()}`);
  };

  return (
    <div className="flex flex-wrap items-end gap-3 rounded border p-4">
      <label className="text-sm">
        Project
        <select value={projectId} onChange={(e) => go(e.target.value, "")} className="mt-1 block rounded border px-3 py-2">
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        Isometric
        <select value={drawingId} onChange={(e) => go(projectId, e.target.value)} className="mt-1 block rounded border px-3 py-2">
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
      </label>
    </div>
  );
}
