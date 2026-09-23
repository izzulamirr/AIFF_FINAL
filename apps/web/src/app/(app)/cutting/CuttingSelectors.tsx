"use client";

import { useRouter } from "next/navigation";

// WHICH PARTS to nest, within the project already open.
//
// The project picker that used to sit beside this is gone. The project is chosen
// one step earlier in the flow (login -> client -> dashboard -> project -> the
// cutting plan) and arrives as `?project=`, so asking again here was a question
// already answered -- and it made it possible to change project from a page
// headed with a different project's name.
//
// It navigates as soon as it changes, rather than being a GET form with a
// button: switching what is nested is a navigation, and a plain GET form left
// the page rendering the previous selection's parts.
export function CuttingSelectors({
  projectId,
  drawings,
  drawingId,
}: {
  projectId: string;
  drawings: Array<{ id: string; label: string }>;
  drawingId: string;
}) {
  const router = useRouter();

  const go = (nextDrawing: string) => {
    const params = new URLSearchParams({ project: projectId });
    if (nextDrawing) params.set("drawing", nextDrawing);
    router.push(`/cutting?${params.toString()}`);
  };

  return (
    <div className="card flex flex-wrap items-end gap-4 p-4">
      <div className="w-full sm:w-auto">
        <label htmlFor="drawing-select" className="field-label">
          Parts to nest
        </label>
        <select id="drawing-select" value={drawingId} onChange={(e) => go(e.target.value)} className="input sm:min-w-72">
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
