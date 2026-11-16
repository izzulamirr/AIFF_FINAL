import type { ReactNode } from "react";

// A line's heading, set like the title block on the drawing it came from: the
// line number in the first, widest cell, four labelled cells beside it, and a
// footer row for what the line belongs to and how it stands. Styles in
// globals.css (.title-block).
//
// Exactly four cells: the grid is drawn for five columns, and a missing cell
// would leave a hole in the ruling. Pass "-" for a value that is not known.

export interface TitleBlockCell {
  label: string;
  value: ReactNode;
}

export function TitleBlock({
  lineLabel = "Line number",
  line,
  cells,
  foot,
}: {
  lineLabel?: string;
  line: string;
  cells: [TitleBlockCell, TitleBlockCell, TitleBlockCell, TitleBlockCell];
  /** The footer row: a labelled value on the left, status chips or actions on the right. */
  foot?: { label: string; value: ReactNode; aside?: ReactNode };
}) {
  return (
    <div className="title-block">
      <div className="title-block-cell is-main">
        <p className="title-block-label">{lineLabel}</p>
        <h1 className="title-block-value is-tag">{line}</h1>
      </div>
      {cells.map((c) => (
        <div key={c.label} className="title-block-cell">
          <p className="title-block-label">{c.label}</p>
          <p className="title-block-value">{c.value}</p>
        </div>
      ))}
      {foot && (
        <div className="title-block-cell is-foot">
          <div className="min-w-0">
            <p className="title-block-label">{foot.label}</p>
            <p className="title-block-value">{foot.value}</p>
          </div>
          {foot.aside && <div className="flex flex-wrap items-center gap-2">{foot.aside}</div>}
        </div>
      )}
    </div>
  );
}
