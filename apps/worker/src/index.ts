import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createDb } from "@easy/db";
import { getQueue, EXTRACT_DOCUMENT_QUEUE, type ExtractDocumentJobData } from "./queue";
import { runExtractionJob } from "./pipeline";

const DATABASE_URL = requireEnv("DATABASE_URL");
const SUPABASE_URL = requireEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
const ANTHROPIC_API_KEY = requireEnv("ANTHROPIC_API_KEY");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}. See apps/worker/.env.example.`);
  return value;
}

async function main() {
  const db = createDb(DATABASE_URL);
  const storage = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const boss = await getQueue(DATABASE_URL);

  console.log(`[worker] listening on queue "${EXTRACT_DOCUMENT_QUEUE}"`);

  await boss.work<ExtractDocumentJobData>(EXTRACT_DOCUMENT_QUEUE, async ([job]) => {
    const { documentId, extractionJobId } = job.data;
    console.log(`[worker] processing document ${documentId} (job ${extractionJobId})`);
    try {
      await runExtractionJob(db, storage, extractionJobId, documentId, ANTHROPIC_API_KEY);
      console.log(`[worker] document ${documentId} succeeded`);
    } catch (err) {
      // runExtractionJob already persists the failure to extraction_jobs;
      // re-throwing lets pg-boss track/retry the job per its own policy.
      console.error(`[worker] document ${documentId} failed:`, err);
      throw err;
    }
  });
}

main().catch((err) => {
  console.error("[worker] fatal error during startup:", err);
  process.exit(1);
});
