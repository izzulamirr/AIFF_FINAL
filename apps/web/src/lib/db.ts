import { createDb } from "@easy/db";

// Singleton Drizzle instance for server-side data access (Server
// Components / Server Actions / Route Handlers). Auth + Storage + Realtime
// still go through Supabase's own client (see lib/supabase/*) -- this is
// purely the typed Postgres query layer.
//
// Kept on `globalThis`, not in a module variable. In `next dev` every hot reload
// re-evaluates this module, and a module-level singleton then opens a NEW pool
// each time while the old one keeps its connections open -- a day of edits
// leaked pools until Supabase refused everyone with "EMAXCONN max client
// connections reached, limit: 200". On globalThis the pool survives the reload
// and is reused.
const globalForDb = globalThis as unknown as { easyDb?: ReturnType<typeof createDb> };

export function getDb() {
  if (!globalForDb.easyDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Missing DATABASE_URL -- see apps/web/.env.example.");
    globalForDb.easyDb = createDb(url);
  }
  return globalForDb.easyDb;
}
