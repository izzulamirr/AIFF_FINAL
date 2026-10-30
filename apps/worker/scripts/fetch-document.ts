// Pull a document's source file out of Supabase Storage, so the free
// geometry scripts can be run against the real drawing.
//
//   pnpm --filter @easy/worker exec tsx scripts/fetch-document.ts <documentId|name-fragment> <out.pdf>
//   pnpm --filter @easy/worker exec tsx scripts/fetch-document.ts --list
//
// Every geometric probe in this repo takes a PDF path, and the PDFs live in
// Storage rather than the working tree -- so without this the free tools can
// only be run on a file someone happens to have downloaded by hand. Costs
// nothing but bandwidth.
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { createDb, documents } from "@easy/db";
import "dotenv/config";

const STORAGE_BUCKET = "documents";

const { DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (apps/worker/.env)");
  process.exit(1);
}

const [which, out] = process.argv.slice(2);

async function main() {
const db = createDb(DATABASE_URL);
const all = await db.select().from(documents);

if (!which || which === "--list") {
  for (const d of all) console.log(`${d.docType.padEnd(11)} ${d.id}  ${d.fileName}`);
  process.exit(0);
}

// Accept an id or any fragment of the file name -- an id is unmemorable and
// the file name is what is on screen.
const matches = all.filter((d) => d.id === which || d.fileName.toLowerCase().includes(which.toLowerCase()));
if (matches.length === 0) {
  console.error(`No document matches "${which}". Run with --list to see them.`);
  process.exit(1);
}
if (matches.length > 1 && !matches.some((d) => d.id === which)) {
  console.error(`"${which}" matches ${matches.length} documents -- name one by id:`);
  for (const d of matches) console.error(`  ${d.id}  ${d.fileName}`);
  process.exit(1);
}
const doc = matches.find((d) => d.id === which) ?? matches[0];

const storage = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const { data, error } = await storage.storage.from(STORAGE_BUCKET).download(doc.storagePath);
if (error || !data) {
  console.error(`Failed to download ${doc.storagePath}: ${error?.message}`);
  process.exit(1);
}

const target = out ?? doc.fileName;
writeFileSync(target, Buffer.from(await data.arrayBuffer()));
console.log(`${doc.fileName}  ->  ${target}`);
process.exit(0);
}
void main();
