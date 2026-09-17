// Rebuild the tag rows from a saved ISO extraction. Free -- no API call.
//   pnpm --filter @easy/worker exec tsx scripts/rebuild-iso-tags.ts <raw.json> <tags.json>
//
// The vision half of an ISO extraction costs ~$9 and its output is saved as
// rawJson. Everything after it is deterministic, so re-importing never needs
// paying twice.
import { readFileSync, writeFileSync } from "node:fs";
import { buildIsoTags } from "../src/extraction/iso";

const [, , rawPath, outPath] = process.argv;
if (!rawPath || !outPath) {
  console.error("usage: tsx scripts/rebuild-iso-tags.ts <raw.json> <tags.json>");
  process.exit(1);
}
const raw = JSON.parse(readFileSync(rawPath, "utf8"));
// The geometry half is saved alongside the vision half, so the rebuild gets
// the same spools the extraction produced rather than falling back to the
// topology walk. A payload saved before it existed simply has none.
const tags = buildIsoTags(raw.sheets, raw.geometry);
if (raw.geometry) {
  const t = raw.geometry.filter((g: { trusted: boolean }) => g.trusted).length;
  console.log(`geometry: ${t} of ${raw.geometry.length} sheets resolved from the drawing`);
}
const counts = new Map<string, number>();
for (const t of tags) counts.set(t.tagType, (counts.get(t.tagType) ?? 0) + 1);
writeFileSync(outPath, JSON.stringify({ tags }, null, 2));
console.log(`${tags.length} tags: ${[...counts.entries()].map(([k, v]) => `${v} ${k}`).join(", ")}`);
console.log(`wrote ${outPath}`);
