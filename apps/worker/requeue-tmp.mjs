import "dotenv/config";
import postgres from "postgres";
import PgBoss from "pg-boss";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const sql = postgres(url, { prepare: false, max: 1 });

const [doc] = await sql`
  select id, file_name, doc_type, storage_path
  from documents
  where doc_type = 'cutting'
  order by uploaded_at desc
  limit 1
`;
if (!doc) throw new Error("No cutting document found -- upload it first.");
console.log(`document: ${doc.file_name} (${doc.id})`);

const jobs = await sql`
  select id, status, error_message from extraction_jobs
  where document_id = ${doc.id} order by created_at desc limit 3
`;
console.log("existing jobs:", jobs.map((j) => `${j.status}${j.error_message ? ` (${j.error_message.slice(0, 40)})` : ""}`).join(" | "));

const [job] = await sql`
  insert into extraction_jobs (document_id, status) values (${doc.id}, 'queued') returning id
`;
console.log(`queued new extraction job ${job.id}`);

const boss = new PgBoss(url);
boss.on("error", (e) => console.error("[pg-boss]", e));
await boss.start();
await boss.createQueue("extract-document");
const sent = await boss.send("extract-document", { documentId: doc.id, extractionJobId: job.id });
console.log("pg-boss message:", sent);

await boss.stop();
await sql.end();
