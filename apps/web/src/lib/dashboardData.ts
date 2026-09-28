import { inArray } from "drizzle-orm";
import { documents } from "@easy/db";
import { getDb } from "@/lib/db";
import { isoLinesOf } from "@/lib/isoLines";
import { resultsOfProject, type LineResult } from "@/lib/projectResults";
import type { BoardData } from "@/components/dashboard/MonitoringBoard";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ProjectProgress } from "@/lib/progress";

// What the dashboard shows and what its Excel export writes: one place builds the numbers, so the
// page and the spreadsheet can never disagree.

export interface ProjectOverview {
  id: string;
  name: string;
  isoLines: number;
  documents: number;
  byType: Array<[string, number]>;
  lastUpload: Date | null;
  uploads: Date[];
  /** Who uploaded the drawings, with how many documents and current ISO lines came from each. */
  uploaders: Array<{ userId: string; documents: number; lines: number }>;
  /** What the checks found on each of its ISO lines. */
  results: LineResult[];
}

export const DOC_LABEL: Record<string, string> = {
  iso: "ISO", pid: "P&ID", spec_sheet: "Spec", pll: "PLL", hookup: "Hook-up", cutting: "Cutting", pid_legend: "Legend", hmb: "HMB", pfd: "PFD", ga: "GA",
};

/** What is really in each project, read from the drawings and documents -- no progress tables needed. */
export async function overviewOf(projects: Array<{ id: string; name: string }>): Promise<ProjectOverview[]> {
  if (projects.length === 0) return [];
  const docs = await getDb()
    .select({ id: documents.id, projectId: documents.projectId, docType: documents.docType, uploadedAt: documents.uploadedAt, uploadedBy: documents.uploadedBy })
    .from(documents)
    .where(inArray(documents.projectId, projects.map((p) => p.id)));
  const lines = await Promise.all(projects.map((p) => isoLinesOf(p.id)));
  const results = await Promise.all(projects.map((p) => resultsOfProject(p.id)));
  return projects.map((p, i) => {
    const mine = docs.filter((d) => d.projectId === p.id);
    const counts = new Map<string, number>();
    for (const d of mine) counts.set(d.docType, (counts.get(d.docType) ?? 0) + 1);
    // A line is credited to whoever uploaded the drawing carrying it; every upload is checked as it is read.
    const uploaderOf = new Map(mine.map((d) => [d.id, d.uploadedBy]));
    const byUser = new Map<string, { userId: string; documents: number; lines: number }>();
    const entry = (userId: string) => byUser.get(userId) ?? byUser.set(userId, { userId, documents: 0, lines: 0 }).get(userId)!;
    for (const d of mine) if (d.uploadedBy) entry(d.uploadedBy).documents += 1;
    for (const line of lines[i]) {
      const by = uploaderOf.get(line.documentIds[0]);
      if (by) entry(by).lines += 1;
    }
    return {
      id: p.id,
      name: p.name,
      isoLines: lines[i].length,
      results: results[i],
      documents: mine.length,
      byType: [...counts.entries()].sort((a, b) => b[1] - a[1]),
      uploads: mine.map((d) => d.uploadedAt),
      uploaders: [...byUser.values()],
      lastUpload: mine.length > 0 ? new Date(Math.max(...mine.map((d) => d.uploadedAt.getTime()))) : null,
    };
  });
}

/** Display names for the accounts behind the uploads, read through the admin API; falls back to a short id. */
export async function namesOf(ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const { data } = await createAdminClient().auth.admin.getUserById(id);
        const meta = (data.user?.user_metadata ?? {}) as Record<string, unknown>;
        const name = [meta.full_name, meta.name].find((n): n is string => typeof n === "string" && n.trim() !== "");
        names.set(id, name?.trim() ?? data.user?.email ?? `User ${id.slice(0, 6)}`);
      } catch {
        names.set(id, `User ${id.slice(0, 6)}`);
      }
    })
  );
  return names;
}

/** Who did the work: people who ticked lines off once that is tracked, otherwise who uploaded the drawings. */
export function usersOf(overview: ProjectOverview[], progress: ProjectProgress[] | null, names: Map<string, string>): Pick<BoardData, "users" | "usersBasis"> {
  if (progress !== null) {
    const byName = new Map<string, number>();
    for (const p of progress) {
      for (const r of p.classified) {
        const name = r.reviewedByName ?? "Unknown";
        byName.set(name, (byName.get(name) ?? 0) + 1);
      }
    }
    return {
      users: [...byName.entries()].map(([name, lines]) => ({ name, lines, documents: 0 })).sort((a, b) => b.lines - a.lines),
      usersBasis: "Lines each person has marked as checked",
    };
  }
  const byUser = new Map<string, { lines: number; documents: number }>();
  for (const o of overview) {
    for (const u of o.uploaders) {
      const t = byUser.get(u.userId) ?? { lines: 0, documents: 0 };
      t.lines += u.lines;
      t.documents += u.documents;
      byUser.set(u.userId, t);
    }
  }
  return {
    users: [...byUser.entries()]
      .map(([id, t]) => ({ name: names.get(id) ?? `User ${id.slice(0, 6)}`, ...t }))
      .sort((a, b) => b.lines - a.lines || b.documents - a.documents),
    usersBasis: "Who uploaded the drawings; each upload is checked as it is read",
  };
}

export const CHECK_LABEL: Array<[keyof LineResult["byCheck"], string]> = [
  ["designBasis", "Line list"],
  ["bom", "BOM"],
  ["pid", "P&ID"],
  ["hookup", "Hook-up"],
  ["spooling", "Spooling"],
  ["containers", "Containers"],
];

/** The numbers the monitoring board draws, rolled up across the client's projects. */
export function boardOf(overview: ProjectOverview[], progress: ProjectProgress[] | null, names: Map<string, string>): BoardData {
  const all = overview.flatMap((o) => o.results);
  // Against the total Document Control stated where there is one, otherwise the lines read so far.
  const totalOf = (o: ProjectOverview) => progress?.find((p) => p.projectId === o.id)?.total ?? o.isoLines;
  const shortLabel = (line: string) => line.split("-").slice(-3, -2)[0] ?? line;
  return {
    projects: overview.length,
    documents: overview.reduce((n, o) => n + o.documents, 0),
    linesChecked: all.filter((r) => !r.failed).length,
    linesTotal: overview.reduce((n, o) => n + totalOf(o), 0),
    linesWithErrors: all.filter((r) => r.errors > 0).length,
    errors: all.reduce((n, r) => n + r.errors, 0),
    info: all.reduce((n, r) => n + r.info, 0),
    byCheck: CHECK_LABEL.map(([key, label]) => ({ label, value: all.reduce((n, r) => n + r.byCheck[key], 0) })),
    topLines: all
      .filter((r) => r.errors > 0)
      .sort((x, y) => y.errors - x.errors)
      .slice(0, 7)
      .map((r) => ({ label: shortLabel(r.lineNumber), full: r.lineNumber, errors: r.errors })),
    perProject: overview.map((o) => ({
      name: o.name,
      checked: o.results.filter((r) => !r.failed).length,
      total: totalOf(o),
      withErrors: o.results.filter((r) => r.errors > 0).length,
    })),
    ...usersOf(overview, progress, names),
    uploads: overview.flatMap((o) => o.uploads),
  };
}

