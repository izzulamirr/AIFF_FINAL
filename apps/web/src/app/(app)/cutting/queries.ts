import { asc, eq } from "drizzle-orm";
import { cuttingPartQuantities, cuttingStockPlates } from "@easy/db";
import { getDb } from "@/lib/db";

// Deliberately NOT in actions.ts. Every export of a "use server" module is a
// callable endpoint, and a loader that takes a project id and returns its
// stock would have been one anybody could call for any project. It is only
// ever read from the page's own server render, where the caller has already
// been checked, so it belongs in a plain module.
export async function loadCuttingStock(projectId: string) {
  return getDb()
    .select()
    .from(cuttingStockPlates)
    .where(eq(cuttingStockPlates.projectId, projectId))
    .orderBy(asc(cuttingStockPlates.sortOrder), asc(cuttingStockPlates.createdAt));
}

/** The project's cut quantities, by part mark. Same reasoning as above: read
 *  from the page's own render, so it is not an action. */
export async function loadCuttingQuantities(projectId: string) {
  return getDb().select().from(cuttingPartQuantities).where(eq(cuttingPartQuantities.projectId, projectId));
}
