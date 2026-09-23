import { setTotalLines } from "./progressActions";

// How many lines the project holds -- Document Control's own figure, and the
// number every percentage in the app is measured against.
//
// One component because there are two honest places to set it: the dashboard,
// where you are comparing projects and this is the setup each one needs, and the
// project itself, where you are working. Two copies of the same form is how the
// two quietly grow different rules about what a valid total is.
//
// Blank clears it, which is what the action does with an empty string -- the
// project then measures against the lines read off its drawings instead.
export function TotalLinesForm({ projectId, total, className = "" }: { projectId: string; total: number | null; className?: string }) {
  const id = `total-lines-${projectId}`;
  return (
    <form action={setTotalLines.bind(null, projectId)} className={`flex items-center gap-2 ${className}`}>
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        Total lines
      </label>
      <input
        id={id}
        name="total"
        type="number"
        min={0}
        max={100000}
        step={1}
        inputMode="numeric"
        defaultValue={total ?? ""}
        placeholder="e.g. 40"
        className="input input-sm w-20"
      />
      <button type="submit" className="btn btn-secondary btn-xs">
        Save
      </button>
    </form>
  );
}
