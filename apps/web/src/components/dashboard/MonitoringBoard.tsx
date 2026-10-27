import type { CSSProperties, ReactNode } from "react";

// The dashboard's monitoring board: KPI cards, two donuts, a bar chart and the
// per-project and per-user tallies, drawn as plain SVG from real numbers. Every colour is one of
// the app's own tokens, so it follows light and dark mode with the rest of the page.

export interface BoardData {
  projects: number;
  documents: number;
  /** Lines the checks have run on, and the total they are counted against. */
  linesChecked: number;
  linesTotal: number;
  linesWithErrors: number;
  errors: number;
  info: number;
  /** Errors per check, for the donut. */
  byCheck: Array<{ label: string; value: number }>;
  /** Errors on the worst lines, for the bars. */
  topLines: Array<{ label: string; full: string; project: string; errors: number }>;
  /** Documents uploaded, by kind. */
  documentsByType: Array<{ label: string; value: number }>;
  /** Each project: lines checked against its total, and how many of them carry errors. */
  perProject: Array<{ name: string; checked: number; total: number; withErrors: number }>;
  /** The people behind the checking, and what the count is of (see `usersBasis`). */
  users: Array<{ name: string; lines: number; documents: number }>;
  usersBasis: string;
}

const v = (name: string) => `var(--${name})`;
const PALETTE = [v("primary"), v("info-solid"), v("success-solid"), v("warning-solid"), v("danger-solid"), "#8b5cf6"];
const fill = (color: string): CSSProperties => ({ fill: color });
const stroke = (color: string): CSSProperties => ({ stroke: color });
const gridStyle: CSSProperties = { stroke: v("border") };
const labelStyle: CSSProperties = { fill: v("muted-foreground") };

function Panel({ title, sub, children, className = "" }: { title: string; sub?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      <h3 className="card-title">{title}</h3>
      {sub && <p className="mb-3 mt-0.5 text-xs text-muted-foreground">{sub}</p>}
      <div className={sub ? "" : "mt-3"}>{children}</div>
    </section>
  );
}

// Flat, one colour per card: a gradient reads as decoration on a page whose
// numbers are meant to be read.
function Kpi({ color, label, value, unit, hint }: { color: string; label: string; value: string; unit?: string; hint: string }) {
  return (
    <div className="rounded-xl p-4 text-white" style={{ background: color }}>
      <p className="text-xs font-medium text-white/90">{label}</p>
      <p className="mt-2 flex items-baseline gap-1.5 tabular-nums">
        <span className="text-4xl font-bold leading-none">{value}</span>
        {unit && <span className="text-sm font-medium text-white/85">{unit}</span>}
      </p>
      <p className="mt-2 text-xs text-white/85">{hint}</p>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="card flex items-center gap-3 !py-3">
      <span className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: color }} />
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="ml-auto text-lg font-semibold tabular-nums">{value}</span>
    </div>
  );
}

/** A ring split into slices, with the total in the middle. */
function Donut({ slices, center, sub }: { slices: Array<{ label: string; value: number; color: string }>; center: string; sub: string }) {
  const total = slices.reduce((n, s) => n + s.value, 0);
  const R = 52;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="flex items-center gap-5">
      <svg viewBox="0 0 140 140" className="h-36 w-36 flex-none" role="img" aria-label={sub}>
        <circle cx="70" cy="70" r={R} fill="none" strokeWidth="18" style={stroke(v("muted"))} />
        {total > 0 &&
          slices
            .filter((s) => s.value > 0)
            .map((s) => {
              const len = (s.value / total) * C;
              const dash = Math.max(len - 2, 0.5);
              const el = (
                <circle
                  key={s.label}
                  cx="70"
                  cy="70"
                  r={R}
                  fill="none"
                  strokeWidth="18"
                  style={stroke(s.color)}
                  strokeDasharray={`${dash} ${C - dash}`}
                  strokeDashoffset={-offset}
                  transform="rotate(-90 70 70)"
                />
              );
              offset += len;
              return el;
            })}
        <text x="70" y="68" textAnchor="middle" fontSize="22" fontWeight="700" style={fill(v("foreground"))}>
          {center}
        </text>
        <text x="70" y="84" textAnchor="middle" fontSize="8.5" style={labelStyle}>
          {sub}
        </text>
      </svg>
      <ul className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: s.color }} />
            <span className="truncate">{s.label}</span>
            <span className="ml-auto tabular-nums text-muted-foreground">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// `showProject` names each bar's project under its line: across a client the same
// sequence number (0002) turns up in several projects, and three bars all labelled
// "0002" say nothing.
function Bars({ items, showProject }: { items: BoardData["topLines"]; showProject: boolean }) {
  if (items.length === 0) return <p className="py-10 text-center text-xs text-muted-foreground">No errors on any line.</p>;
  const W = 300;
  const H = showProject ? 202 : 190;
  const pad = { l: 26, r: 6, t: 12, b: showProject ? 40 : 28 };
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const max = Math.max(...items.map((i) => i.errors), 1);
  const slot = (W - pad.l - pad.r) / items.length;
  const bar = Math.min(26, slot * 0.6);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Errors on the worst lines">
      {[0, 0.5, 1].map((f) => {
        const yy = H - pad.b - f * (H - pad.t - pad.b);
        return (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={yy} y2={yy} style={gridStyle} />
            <text x={pad.l - 6} y={yy + 3} textAnchor="end" fontSize="8.5" style={labelStyle}>
              {Math.round(max * f)}
            </text>
          </g>
        );
      })}
      {items.map((it, i) => {
        const h = (it.errors / max) * (H - pad.t - pad.b);
        const cx = pad.l + slot * i + slot / 2;
        return (
          <g key={`${it.project}-${it.full}-${i}`}>
            <title>{`${it.full} (${it.project}): ${it.errors} errors`}</title>
            <rect x={cx - bar / 2} y={H - pad.b - h} width={bar} height={h} rx="2" style={fill(v("primary"))} />
            <text x={cx} y={H - pad.b - h - 4} textAnchor="middle" fontSize="8.5" fontWeight="600" style={fill(v("foreground"))}>
              {it.errors}
            </text>
            <text x={cx} y={H - pad.b + 14} textAnchor="middle" fontSize="8.5" style={labelStyle}>
              {it.label}
            </text>
            {showProject && (
              <text x={cx} y={H - pad.b + 26} textAnchor="middle" fontSize="7.5" fontWeight="600" style={fill(v("foreground"))}>
                {clip(it.project, Math.max(6, Math.floor(slot / 5)))}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

const initials = (name: string) =>
  name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("") || "?";

/**
 * `scope` is what the numbers are about. "client" compares the client's projects
 * against each other; "project" is one project, so the per-project comparison
 * gives way to what that project holds.
 */
export function MonitoringBoard({ data, scope = "client" }: { data: BoardData; scope?: "client" | "project" }) {
  const isProject = scope === "project";
  const clean = data.linesChecked - data.linesWithErrors;
  const pct = data.linesChecked > 0 ? Math.round((clean / data.linesChecked) * 100) : 0;
  const topUser = data.users[0]?.lines ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:col-span-3">
          <Kpi
            color={v("primary")}
            label="Lines checked"
            value={String(data.linesChecked)}
            unit={`of ${data.linesTotal}`}
            hint={isProject ? "in this project" : `across ${data.projects} project${data.projects === 1 ? "" : "s"}`}
          />
          <Kpi color={v("danger-solid")} label="Errors found" value={String(data.errors)} unit={`on ${data.linesWithErrors} lines`} hint={`${data.info} more for information`} />
          <Kpi
            color={v("success-solid")}
            label="Users checking"
            value={String(data.users.length)}
            unit={data.users.length === 1 ? "person" : "people"}
            hint={data.usersBasis}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
          {isProject ? (
            <Stat label="Total lines" value={data.linesTotal} color={v("primary")} />
          ) : (
            <Stat label="Projects" value={data.projects} color={v("primary")} />
          )}
          <Stat label="Documents" value={data.documents} color={v("success-solid")} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Panel title="Errors on the worst lines">
          <Bars items={data.topLines} showProject={!isProject} />
        </Panel>

        <Panel title="Errors by check">
          <Donut slices={data.byCheck.map((c, i) => ({ ...c, color: PALETTE[i % PALETTE.length] }))} center={String(data.errors)} sub="errors" />
        </Panel>
        <Panel title="Lines checked">
          <Donut
            slices={[
              { label: "No errors", value: clean, color: v("success-solid") },
              { label: "With errors", value: data.linesWithErrors, color: v("danger-solid") },
            ]}
            center={`${pct}%`}
            sub="clean"
          />
        </Panel>
        {isProject ? (
          <Panel title="Documents by type" sub="What this project holds" className="lg:col-span-3">
            {data.documentsByType.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">No documents uploaded yet.</p>
            ) : (
              <ul className="grid grid-cols-1 gap-x-8 gap-y-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
                {data.documentsByType.map((d) => (
                  <li key={d.label}>
                    <div className="mb-1 flex justify-between gap-2">
                      <span className="truncate font-medium">{d.label}</span>
                      <span className="flex-none tabular-nums text-muted-foreground">
                        {d.value} document{d.value === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${(d.value / Math.max(1, data.documentsByType[0].value)) * 100}%`, background: v("primary") }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        ) : (
        <Panel title="Lines checked per project" sub="Against the project's total lines" className="lg:col-span-3">
          <ul className="flex flex-col gap-3 text-xs">
            {data.perProject.map((p, i) => (
              <li key={`${p.name}-${i}`}>
                <div className="mb-1 flex justify-between gap-2">
                  <span className="truncate font-medium">{p.name}</span>
                  <span className="flex-none tabular-nums text-muted-foreground">
                    {p.checked} / {p.total} lines
                    {p.withErrors > 0 ? ` · ${p.withErrors} with errors` : ""}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${p.total > 0 ? Math.min(100, (p.checked / p.total) * 100) : 0}%`, background: v("primary") }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Panel>
        )}

        <Panel title="Users" sub={data.usersBasis} className="lg:col-span-3">
          {data.users.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">Nobody has uploaded or checked anything yet.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.users.map((u, i) => (
                <li key={`${u.name}-${i}`} className="flex items-center gap-3">
                  <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-primary">{initials(u.name)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex justify-between gap-2 text-xs">
                      <span className="truncate font-medium">{u.name}</span>
                      <span className="flex-none tabular-nums text-muted-foreground">
                        {u.lines} line{u.lines === 1 ? "" : "s"}
                        {u.documents > 0 ? ` · ${u.documents} doc${u.documents === 1 ? "" : "s"}` : ""}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full" style={{ width: `${topUser > 0 ? (u.lines / topUser) * 100 : 0}%`, background: v("primary") }} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
