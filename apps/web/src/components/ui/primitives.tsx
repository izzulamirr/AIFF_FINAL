import type { ReactNode } from "react";
import { IconAlert, IconCheckCircle, IconInfo, IconXCircle } from "./icons";

// Small presentational pieces shared across pages. Styling lives in
// globals.css (.badge, .alert, .stat, .empty); these only choose which
// variant to use, so a page says WHAT something is ("danger") and never HOW
// it looks.

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const BADGE_TONE: Record<Tone, string> = {
  neutral: "",
  success: "badge-success",
  warning: "badge-warning",
  danger: "badge-danger",
  info: "badge-info",
};

export function Badge({
  tone = "neutral",
  dot = false,
  live = false,
  mono = false,
  title,
  className = "",
  children,
}: {
  tone?: Tone;
  /** A leading status dot. */
  dot?: boolean;
  /** Pulse the dot -- something is happening right now. */
  live?: boolean;
  mono?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const classes = ["badge", BADGE_TONE[tone], dot ? "badge-dot" : "", live ? "badge-live" : "", mono ? "badge-mono" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} title={title}>
      {children}
    </span>
  );
}

// extraction_jobs.status is one of these four (the table's own check
// constraint). Anything else is shown as it came rather than hidden.
const JOB_STATUS: Record<string, { tone: Tone; label: string; live?: boolean }> = {
  succeeded: { tone: "success", label: "Succeeded" },
  running: { tone: "info", label: "Running", live: true },
  queued: { tone: "neutral", label: "Queued" },
  failed: { tone: "danger", label: "Failed" },
};

export function JobStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <Badge>No job</Badge>;
  const known = JOB_STATUS[status];
  if (!known) return <Badge>{status}</Badge>;
  return (
    <Badge tone={known.tone} dot live={known.live}>
      {known.label}
    </Badge>
  );
}

interface JobLike {
  status: string;
  progressPhase: string | null;
  progressCurrent: number | null;
  progressTotal: number | null;
  errorMessage: string | null;
}

function RunningDetail({ job }: { job: JobLike }) {
  const pct = job.progressTotal ? Math.min(100, Math.round(((job.progressCurrent ?? 0) / job.progressTotal) * 100)) : null;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {pct !== null && (
        <span className="h-1 w-24 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span className="block h-full rounded-full bg-info-solid" style={{ width: `${pct}%` }} />
        </span>
      )}
      <span className="tabular-nums">
        {job.progressPhase ? `${job.progressPhase} ` : ""}
        {job.progressCurrent ?? "?"}/{job.progressTotal ?? "?"}
      </span>
    </div>
  );
}

// Where an extraction has got to: the status, how far along it is while it
// runs, and why it failed when it did. `errorMaxChars` trims a long error for
// the compact lists that have little room.
export function JobStatus({ job, errorMaxChars }: { job: JobLike | null | undefined; errorMaxChars?: number }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <JobStatusBadge status={job?.status} />
      {job?.status === "running" && (job.progressPhase || job.progressTotal) ? <RunningDetail job={job} /> : null}
      {job?.status === "failed" && job.errorMessage ? (
        <p className="max-w-md text-xs leading-snug text-danger">
          {errorMaxChars ? job.errorMessage.slice(0, errorMaxChars) : job.errorMessage}
        </p>
      ) : null}
    </div>
  );
}

const ALERT_ICON = { info: IconInfo, success: IconCheckCircle, warning: IconAlert, danger: IconXCircle, neutral: IconInfo } as const;

export function Alert({ tone = "info", className = "", children }: { tone?: Tone; className?: string; children: ReactNode }) {
  const Icon = ALERT_ICON[tone];
  const toneClass = tone === "neutral" ? "" : `alert-${tone}`;
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`alert ${toneClass} ${className}`.trim()}>
      <Icon size={16} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">{icon}</span>}
      <p className="font-medium text-foreground">{title}</p>
      {children && <p className="max-w-md text-sm">{children}</p>}
      {action}
    </div>
  );
}

export function Stat({
  label,
  value,
  tone = "neutral",
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: "neutral" | "good" | "warning" | "danger";
  hint?: ReactNode;
}) {
  const toneClass = tone === "neutral" ? "" : `stat-${tone}`;
  return (
    <div className={`stat ${toneClass}`.trim()}>
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
