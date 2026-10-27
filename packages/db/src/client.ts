import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// DATABASE_URL is Supabase's connection string (use the pooled "Transaction"
// connection string for serverless/worker use -- see apps/web and
// apps/worker's .env.example for where this comes from).
//
// The pool is bounded and lets idle connections go. Supabase's pooler caps
// CLIENT connections for the whole project (200), shared by the web app, the
// worker and every ad hoc script, so one process holding its connections open
// indefinitely is what runs everyone else out.
export function createDb(connectionString: string, options: { max?: number } = {}) {
  const client = postgres(connectionString, {
    prepare: false,
    max: options.max ?? 10,
    // Seconds. An idle connection is closed rather than held for the life of the process.
    idle_timeout: 20,
    // Recycle long-lived connections so a pooler restart cannot strand them.
    max_lifetime: 60 * 30,
  });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
