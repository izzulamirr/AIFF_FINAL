import type { CSSProperties, ReactNode } from "react";

// The dashboard's monitoring board: KPI cards, an area chart, two donuts, a bar chart and the
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
  topLines: Array<{ label: string; full: string; errors: number }>;
  /** Each project: lines checked against its total, and how many of them carry errors. */
  perProject: Array<{ name: string; checked: number; total: number; withErrors: number }>;
  /** The people behind the checking, and what the count is of (see `usersBasis`). */
  users: Array<{ name: string; lines: number; documents: number }>;
  usersBasis: string;
  /** When each document was uploaded. */
  uploads: Date[];
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

function Kpi({ from, to, label, value, unit, hint }: { from: string; to: string; label: string; value: string; unit?: string; hint: string }) {
  return (
    <div className="rounded-xl p-4 text-white shadow-sm" style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}>
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

/** A smooth curve through the points (Catmull-Rom converted to cubic Beziers). */
function smooth(points: Array<[number, number]>): string {
  if (points.length < 2) return "";
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0]},${p2[1]}`;
  }
  return d;
}

const DAY = 24 * 60 * 60 * 1000;
const shortDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

/** Documents uploaded so far, over time. */
function UploadsChart({ uploads }: { uploads: Date[] }) {
  const W = 620;
  const H = 210;
  const pad = { l: 34, r: 12, t: 14, b: 26 };
  if (uploads.length === 0) return <p className="py-10 text-center text-xs text-muted-foreground">No documents uploaded yet.</p>;

  const times = uploads.map((d) => d.getTime()).sort((a, b) => a - b);
  const start = times[0];
  const end = times[times.length - 1];
  const step = Math.max(DAY, Math.ceil((end - start) / 11 / DAY) * DAY);
  const buckets: Array<{ at: number; total: number }> = [{ at: start - step, total: 0 }];
  for (let t = start; t < end + step; t += step) buckets.push({ at: t, total: times.filter((x) => x < t + step).length });
  const max = Math.max(...buckets.map((b) => b.total), 1);
  const x = (i: number) => pad.l + (i / (buckets.length - 1)) * (W - pad.l - pad.r);
  const y = (val: number) => H - pad.b - (val / max) * (H - pad.t - pad.b);
  const pts = buckets.map((b, i): [number, number] => [x(i), y(b.total)]);
  const line = smooth(pts);
  const area = `${line} L${x(buckets.length - 1)},${H - pad.b} L${x(0)},${H - pad.b} Z`;
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const last = pts[pts.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Documents uploaded over time">
      <defs>
        <linearGradient id="mb-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: v("primary"), stopOpacity: 0.35 }} />
          <stop offset="100%" style={{ stopColor: v("primary"), stopOpacity: 0 }} />
        </linearGradient>
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} style={gridStyle} />
          <text x={pad.l - 8} y={y(t) + 3} textAnchor="end" fontSize="9" style={labelStyle}>
            {t}
          </text>
        </g>
      ))}
      <path d={area} fill="url(#mb-area)" />
      <path d={line} fill="none" strokeWidth="2.5" strokeLinecap="round" style={stroke(v("primary"))} />
      {buckets.map((b, i) =>
        i === 0 || i === buckets.length - 1 || i % Math.ceil(buckets.length / 6) === 0 ? (
          <text key={b.at} x={x(i)} y={H - 8} textAnchor="middle" fontSize="9" style={labelStyle}>
            {shortDate.format(new Date(b.at))}
          </text>
        ) : null
      )}
      <circle cx={last[0]} cy={last[1]} r="5" strokeWidth="2" style={{ fill: v("primary"), stroke: v("card") }} />
      <g transform={`translate(${Math.min(last[0] - 34, W - 82)},${Math.max(last[1] - 30, 2)})`}>
        <rect width="68" height="20" rx="5" style={fill(v("primary"))} />
        <text x="34" y="14" textAnchor="middle" fontSize="10" fontWeight="600" fill="#fff">
          {buckets[buckets.length - 1].total} docs
        </text>
      </g>
    </svg>
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

function Bars({ items }: { items: BoardData["topLines"] }) {
  if (items.length === 0) return <p className="py-10 text-center text-xs text-muted-foreground">No errors on any line.</p>;
  const W = 300;
  const H = 190;
  const pad = { l: 26, r: 6, t: 12, b: 28 };
  const max = Math.max(...items.map((i) => i.errors), 1);
  const slot = (W - pad.l - pad.r) / items.length;
  const bar = Math.min(26, slot * 0.6);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Errors on the worst lines">
      <defs>
        <linearGradient id="mb-bar" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style={{ stopColor: v("info-solid") }} />
          <stop offset="100%" style={{ stopColor: v("primary") }} />
        </linearGradient>
      </defs>
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
          <g key={`${it.full}-${i}`}>
            <title>{`${it.full}: ${it.errors} errors`}</title>
            <rect x={cx - bar / 2} y={H - pad.b - h} width={bar} height={h} rx="4" fill="url(#mb-bar)" />
            <text x={cx} y={H - pad.b - h - 4} textAnchor="middle" fontSize="8.5" fontWeight="600" style={fill(v("foreground"))}>
              {it.errors}
            </text>
            <text x={cx} y={H - 12} textAnchor="middle" fontSize="8.5" style={labelStyle}>
              {it.label}
            </text>
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

export function MonitoringBoard({ data }: { data: BoardData }) {
  const clean = data.linesChecked - data.linesWithErrors;
  const pct = data.linesChecked > 0 ? Math.round((clean / data.linesChecked) * 100) : 0;
  const topUser = data.users[0]?.lines ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:col-span-3">
          <Kpi
            from={v("primary")}
            to={v("info-solid")}
            label="Lines checked"
            value={String(data.linesChecked)}
            unit={`of ${data.linesTotal}`}
            hint={`across ${data.projects} project${data.projects === 1 ? "" : "s"}`}
          />
          <Kpi from={v("danger-solid")} to={v("warning-solid")} label="Errors found" value={String(data.errors)} unit={`on ${data.linesWithErrors} lines`} hint={`${data.info} more for information`} />
          <Kpi
            from={v("success-solid")}
            to={v("info-solid")}
            label="Users checking"
            value={String(data.users.length)}
            unit={data.users.length === 1 ? "person" : "people"}
            hint={data.usersBasis}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-1">
          <Stat label="Projects" value={data.projects} color={v("primary")} />
          <Stat label="Documents" value={data.documents} color={v("success-solid")} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Panel title="Documents uploaded over time" className="lg:col-span-2">
          <UploadsChart uploads={data.uploads} />
        </Panel>
        <Panel title="Errors on the worst lines">
          <Bars items={data.topLines} />
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
        <Panel title="Lines checked per project" sub="Against the project's total lines">
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
                    style={{ width: `${p.total > 0 ? Math.min(100, (p.checked / p.total) * 100) : 0}%`, background: `linear-gradient(90deg, ${v("primary")}, ${v("info-solid")})` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Panel>

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
