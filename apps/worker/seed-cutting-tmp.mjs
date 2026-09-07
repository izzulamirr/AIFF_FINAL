// Writes the cutting-sheet extraction that was read in-session, in exactly
// the shape apps/worker's pipeline would have written it, so the Cutting Plan
// page renders from real data without spending an API call.
import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");
const sql = postgres(url, { prepare: false, max: 1 });

// Read off CUTTING PLATE-Model.pdf page 1 from the rendered tiles. Sizes are
// the printed dimension figures, never scaled off the picture.
const SHEET = {
  title: "CUTTING PLATE",
  units: "mm",
  plate_size: "PL 50mm X 3000mm X 12000mm",
  plate_length_mm: 12000,
  plate_width_mm: 3000,
  thickness_mm: 50,
  material: "TYPE I",
};

const PARTS = [
  { mark: "BT1A-0107-6-1001", L: 2500.0,  W: 1461.69, figs: ["2500.00","1461.69","2318.55","2181.32","3310.85","1809.12","922.16","655.24","132.36","10.08","104.84","50.40","Ø438.79"] },
  { mark: "BT1A-0107-7-1023", L: 2199.44, W: 1076.61, figs: ["2199.44","1076.61","1072.58","914.07","Ø794.05","Ø356.85"] },
  { mark: "BT1A-0107-7-1001", L: 2300.40, W: 1141.13, figs: ["2300.40","1141.13","381.05","Ø3995.87"] },
  { mark: "BT7A-0107-7-1021", L: 1236.02, W: 1076.61, figs: ["1236.02","1076.61","912.85","504.04","Ø799.50","Ø359.41"] },
  { mark: "BT7A-0107-6-1016", L: 2501.93, W: 1141.13, figs: ["2501.93","1141.13","3312.50","2318.55","2179.33","1811.13","922.16","334.68","136.93","12.10","104.84","50.40","Ø438.36"] },
  { mark: "BT7A-0107-7-1022", L: 2204.44, W: 1076.61, figs: ["2204.44","1076.61","1072.58","908.27","Ø803.03","Ø357.90"] },
  { mark: "BT7B-0106-6-1005", L: 2768.15, W: 2200.77, figs: ["2768.15","2200.77","1792.59","201.80","199.56","Ø3200.80"] },
  { mark: "DMA-6250-4-1004",  L: 294.35,  W: 151.21,  figs: ["294.35","151.21"] },
  { mark: "UNMARKED-1",       L: 358.87,  W: 294.35,  figs: ["358.87","294.35","201.61","78.63","78.63"], marked: false },
  { mark: "UNMARKED-2",       L: 306.45,  W: 175.40,  figs: ["186.95","175.40","109.54","Ø595.01","Ø306.45","Ø72.58"], marked: false },
];

const [doc] = await sql`
  select id, project_id, file_name from documents
  where doc_type = 'cutting' order by uploaded_at desc limit 1
`;
if (!doc) throw new Error("No cutting document found -- upload the PDF first.");
console.log(`document: ${doc.file_name} (${doc.id})`);

const rawJson = { sheets: [{ pageNumber: 1, result: { ...SHEET, parts: PARTS } }], source: "read in-session from the rendered sheet tiles" };

await sql.begin(async (tx) => {
  await tx`delete from extracted_tags where document_id = ${doc.id}`;
  await tx`delete from extraction_results where document_id = ${doc.id}`;

  const [job] = await tx`
    insert into extraction_jobs (document_id, status, started_at, finished_at, progress_phase, progress_current, progress_total)
    values (${doc.id}, 'succeeded', now(), now(), 'sheet', 1, 1)
    returning id
  `;

  await tx`
    insert into extraction_results (document_id, extraction_job_id, schema_version, raw_json)
    values (${doc.id}, ${job.id}, 'cutting.v1', ${sql.json(rawJson)})
  `;

  for (const p of PARTS) {
    const attrs = {
      title: SHEET.title,
      units: SHEET.units,
      sheet_thickness_mm: SHEET.thickness_mm,
      sheet_material: SHEET.material,
      sheet_plate_size: SHEET.plate_size,
      sheet_plate_length_mm: SHEET.plate_length_mm,
      sheet_plate_width_mm: SHEET.plate_width_mm,
      notes: [],
      part_mark: p.marked === false ? null : p.mark,
      marked: p.marked !== false,
      length_mm: p.L,
      width_mm: p.W,
      shape: "profile",
      thickness_mm: SHEET.thickness_mm,
      thickness_source: "sheet",
      material: SHEET.material,
      quantity: p.qty ?? 1,
      grain_direction: null,
      rotatable: true,
      dimension_figures: p.figs,
    };
    await tx`
      insert into extracted_tags (project_id, document_id, doc_type, tag_type, tag_number, tag_number_normalized, source_page, attributes)
      values (${doc.project_id}, ${doc.id}, 'cutting', 'cut_item', ${p.mark},
              ${p.mark.toLowerCase().replace(/[^a-z0-9]/g, "")}, 1, ${sql.json(attrs)})
    `;
  }

  await tx`update documents set page_count = 1 where id = ${doc.id}`;
});

const [{ count }] = await sql`select count(*)::int as count from extracted_tags where document_id = ${doc.id} and tag_type = 'cut_item'`;
console.log(`wrote ${count} cut_item rows`);
const [{ status }] = await sql`select status from extraction_jobs where document_id = ${doc.id} order by created_at desc limit 1`;
console.log(`latest job status: ${status}`);

await sql.end();
