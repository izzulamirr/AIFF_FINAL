import { and, eq, inArray } from "drizzle-orm";
import { lineReviews, notificationReads, projects } from "@easy/db";
import { needsRecheck } from "@easy/shared";
import { visibleOrganizations } from "@/lib/access";
import { getDb } from "@/lib/db";
import { isoLinesOf } from "@/lib/isoLines";
import { isMissingTable } from "@/lib/progress";
import type { SessionUser } from "@/lib/session";

// Revision-change notifications.
//
// Nothing is written when a revision arrives. A line whose drawings include a
// superseded one has, by definition, had its revision change -- isoLines.ts
// already works that out from the REV printed in each title block. So a
// notification is derived: one per line that has moved on, dated by when the
// drawing now in force was uploaded.
//
// Read state is a single watermark per person (notification_reads): anything
// uploaded after it is unread. "Mark all read" moves the watermark to now.
//
// Only lines whose revisions could be ORDERED produce a notification. A line the
// revision rules refused to order (a blank REV box, "A" beside "1") has nothing
// superseded, so it is silent -- the same safe direction isoLines.ts takes.

export interface RevisionNotice {
  projectId: string;
  projectName: string;
  lineNumber: string;
  /** The highest revision now replaced. */
  fromRevision: string | null;
  /** The revision now in force. */
  toRevision: string | null;
  /** When the drawing now in force was uploaded -- what orders and dates the notice. */
  at: Date;
  fileName: string | null;
  /** This person checked the line against an older revision: their tick needs redoing. */
  youCheckedAt: string | null;
  unread: boolean;
}

export interface Notifications {
  notices: RevisionNotice[];
  unread: number;
  /** False until supabase/notifications.sql has been run: everything shows as unread and nothing can be marked. */
  canMarkRead: boolean;
}

/** The newest notices shown; older ones are still visible as Re-check on the line pages. */
const MAX_NOTICES = 30;

async function lastReadAt(userId: string): Promise<{ at: Date | null; tableExists: boolean }> {
  try {
    const [row] = await getDb().select().from(notificationReads).where(eq(notificationReads.userId, userId)).limit(1);
    return { at: row?.lastReadAt ?? null, tableExists: true };
  } catch (err) {
    if (isMissingTable(err)) return { at: null, tableExists: false };
    throw err;
  }
}

/** This person's own checks, keyed by project and line. Empty if the progress tables do not exist. */
async function myReviews(userId: string, projectIds: string[]): Promise<Map<string, string | null>> {
  if (projectIds.length === 0) return new Map();
  try {
    const rows = await getDb()
      .select({ projectId: lineReviews.projectId, lineKey: lineReviews.lineKey, revision: lineReviews.revision })
      .from(lineReviews)
      .where(and(eq(lineReviews.reviewedBy, userId), inArray(lineReviews.projectId, projectIds)));
    return new Map(rows.map((r) => [`${r.projectId}:${r.lineKey}`, r.revision]));
  } catch (err) {
    if (isMissingTable(err)) return new Map();
    throw err;
  }
}

export async function notificationsFor(session: Pick<SessionUser, "id" | "isDcc">): Promise<Notifications> {
  const organizations = await visibleOrganizations(session);
  const projectRows =
    organizations.length === 0
      ? []
      : await getDb()
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(
            inArray(
              projects.organizationId,
              organizations.map((o) => o.id)
            )
          );

  const [linesOf, reviews, read] = await Promise.all([
    Promise.all(projectRows.map((p) => isoLinesOf(p.id))),
    myReviews(
      session.id,
      projectRows.map((p) => p.id)
    ),
    lastReadAt(session.id),
  ]);

  const notices: RevisionNotice[] = [];
  projectRows.forEach((project, i) => {
    for (const line of linesOf[i]) {
      if (!line.revisionKnown || line.superseded.length === 0) continue;

      // `superseded` is newest-upload first; the notice names the highest
      // revision replaced, which is the one a checker last saw.
      const from = line.superseded[0];
      // The newest upload among the drawings in force: that is when the change arrived.
      const newest = [...line.current].sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())[0];
      const at = newest?.uploadedAt ?? from.uploadedAt;

      const mine = reviews.get(`${project.id}:${line.key}`);
      notices.push({
        projectId: project.id,
        projectName: project.name,
        lineNumber: line.lineNumber,
        fromRevision: from.revision,
        toRevision: line.revision,
        at,
        fileName: newest?.fileName ?? null,
        youCheckedAt: mine !== undefined && needsRecheck(mine, line.revision) ? mine : null,
        unread: read.at === null || at > read.at,
      });
    }
  });

  notices.sort((a, b) => b.at.getTime() - a.at.getTime());
  const shown = notices.slice(0, MAX_NOTICES);
  return { notices: shown, unread: notices.filter((n) => n.unread).length, canMarkRead: read.tableExists };
}

/** Everything up to now is read. */
export async function markAllRead(userId: string): Promise<void> {
  const now = new Date();
  await getDb()
    .insert(notificationReads)
    .values({ userId, lastReadAt: now })
    .onConflictDoUpdate({ target: notificationReads.userId, set: { lastReadAt: now } });
}
