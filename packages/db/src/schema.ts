// Drizzle schema for EASY's Supabase Postgres database.
// Mirrors the design in the approved architecture plan: tenancy via
// organizations/organization_members layered over Supabase's auth.users,
// projects -> documents -> extraction_jobs/extraction_results ->
// extracted_tags (the shape-agnostic cross-document join surface) ->
// rule_sets/rules -> findings/finding_comments -> report_exports.
//
// auth.users is Supabase-managed; we reference it by uuid without owning
// the table (see authUsers below, a minimal reference-only definition).

import {
  pgTable,
  pgSchema,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
  doublePrecision,
  bigserial,
  primaryKey,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Supabase's built-in auth schema -- referenced, never migrated by us.
const authSchema = pgSchema("auth");
export const authUsers = authSchema.table("users", {
  id: uuid("id").primaryKey(),
});

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  planTier: text("plan_tier").notNull().default("trial"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    check("organization_members_role_check", sql`${table.role} in ('owner','admin','reviewer','viewer')`),
  ]
);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  createdBy: uuid("created_by").references(() => authUsers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// 'pid' | 'hmb' | 'pfd' | 'spec_sheet'
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    docType: text("doc_type").notNull(),
    fileName: text("file_name").notNull(),
    fileHash: text("file_hash").notNull(),
    storagePath: text("storage_path").notNull(),
    pageCount: integer("page_count"),
    uploadedBy: uuid("uploaded_by").references(() => authUsers.id),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("documents_project_hash_unique").on(table.projectId, table.fileHash),
    check("documents_doc_type_check", sql`${table.docType} in ('pid','hmb','pfd','spec_sheet','iso','ga','pll','pid_legend','hookup','cutting')`),
  ]
);

export const documentPages = pgTable(
  "document_pages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    pageNumber: integer("page_number").notNull(),
    pageText: text("page_text"),
  },
  (table) => [uniqueIndex("document_pages_doc_page_unique").on(table.documentId, table.pageNumber)]
);

// 'queued' | 'running' | 'succeeded' | 'failed'
export const extractionJobs = pgTable(
  "extraction_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    progressPhase: text("progress_phase"),
    progressCurrent: integer("progress_current"),
    progressTotal: integer("progress_total"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("extraction_jobs_status_check", sql`${table.status} in ('queued','running','succeeded','failed')`),
  ]
);

export const extractionResults = pgTable("extraction_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  extractionJobId: uuid("extraction_job_id").references(() => extractionJobs.id),
  schemaVersion: text("schema_version").notNull(),
  rawJson: jsonb("raw_json").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// The shape-agnostic cross-document join surface -- every tag/line/equipment
// number found in any document, normalized so P&ID/H&MB/PFD/spec rows can be
// matched to "the same real-world thing" despite structurally different
// source schemas.
export const extractedTags = pgTable(
  "extracted_tags",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    docType: text("doc_type").notNull(),
    tagType: text("tag_type").notNull(), // 'line' | 'equipment' | 'instrument' | 'valve' | 'stream'
    tagNumber: text("tag_number").notNull(),
    tagNumberNormalized: text("tag_number_normalized").notNull(),
    sourcePage: integer("source_page"),
    attributes: jsonb("attributes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("extracted_tags_project_norm_idx").on(table.projectId, table.tagNumberNormalized),
    index("extracted_tags_project_type_idx").on(table.projectId, table.tagType),
  ]
);

// The plate a project holds to cut from.
//
// Stock is a property of the JOB, not of whoever happens to have the page
// open: two engineers planning the same cut have to be nesting onto the same
// plate, or they produce two different shop drawings from one part list. So
// it lives here rather than in browser storage, and the cutting allowances
// are then derived from the thickness on this row (see @easy/shared's
// nesting.ts) rather than typed in alongside it.
export const cuttingStockPlates = pgTable(
  "cutting_stock_plates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    lengthMm: doublePrecision("length_mm").notNull(),
    widthMm: doublePrecision("width_mm").notNull(),
    thicknessMm: doublePrecision("thickness_mm").notNull(),
    material: text("material"),
    // How many plates of this size the job may draw on. Plate is bought, not
    // conjured: a nest that quietly opens a fifth plate when the yard holds
    // four is a plan the shop cannot execute, so the count is part of the
    // stock rather than an assumption the nester makes.
    quantity: integer("quantity").notNull().default(1),
    // The order the rows were entered in, kept so the plan's stock list reads
    // back the way it was written -- the first row is also the one an
    // unstated part thickness is assumed against, so it is not cosmetic.
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("cutting_stock_plates_project_idx").on(table.projectId)]
);

// How many of each part the job actually needs.
//
// The drawing says how many times a shape was DRAWN, which is not the same
// question: one gusset drawn once is routinely wanted four times, and a
// cutting sheet that lays out a representative piece says so in its parts
// table rather than by drawing it again. So the count read off the geometry is
// a starting point, and this is the answer -- keyed on the part mark rather
// than on the extracted row, so it survives re-extracting the same drawing.
export const cuttingPartQuantities = pgTable(
  "cutting_part_quantities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    partMark: text("part_mark").notNull(),
    quantity: integer("quantity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("cutting_part_quantities_project_idx").on(table.projectId),
    uniqueIndex("cutting_part_quantities_project_mark_key").on(table.projectId, table.partMark),
  ]
);

export const ruleSets = pgTable("rule_sets", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizations.id), // null = shipped/global
  name: text("name").notNull(),
  standard: text("standard"), // e.g. 'API 526', 'IOGP S-616'
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rules = pgTable(
  "rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleSetId: uuid("rule_set_id")
      .notNull()
      .references(() => ruleSets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    applicableDocTypes: text("applicable_doc_types").array().notNull(),
    severity: text("severity").notNull().default("error"),
    checkType: text("check_type").notNull(), // see @easy/shared RuleConfig
    config: jsonb("config").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("rules_severity_check", sql`${table.severity} in ('error','warning','info')`)]
);

export const projectRuleSets = pgTable(
  "project_rule_sets",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ruleSetId: uuid("rule_set_id")
      .notNull()
      .references(() => ruleSets.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.ruleSetId] })]
);

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id").references(() => rules.id), // null = ad-hoc Phase-1 finding
    tagNumber: text("tag_number"),
    docAId: uuid("doc_a_id").references(() => documents.id),
    docBId: uuid("doc_b_id").references(() => documents.id),
    fieldChecked: text("field_checked").notNull(),
    valueA: text("value_a"),
    valueB: text("value_b"),
    severity: text("severity").notNull(),
    status: text("status").notNull().default("open"),
    assigneeId: uuid("assignee_id").references(() => authUsers.id),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => authUsers.id),
  },
  (table) => [
    index("findings_project_status_idx").on(table.projectId, table.status),
    check("findings_status_check", sql`${table.status} in ('open','investigating','resolved','false_positive')`),
  ]
);

export const findingComments = pgTable("finding_comments", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  findingId: uuid("finding_id")
    .notNull()
    .references(() => findings.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => authUsers.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reportExports = pgTable(
  "report_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    format: text("format").notNull(),
    filterCriteria: jsonb("filter_criteria"),
    storagePath: text("storage_path").notNull(),
    generatedBy: uuid("generated_by").references(() => authUsers.id),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("report_exports_format_check", sql`${table.format} in ('csv','pdf')`)]
);

// ---------------------------------------------------------------------------
// Line progress: how far a project's ISO lines have been checked.
//
// Two tables of their own rather than columns on `projects`. Adding a column to
// an existing table makes every query that reads it fail until the database has
// the column; a new table is only ever touched by the code that uses it.
// ---------------------------------------------------------------------------

// How many line numbers a project's scope holds, as STATED by Document Control.
// It is a figure someone enters, not one worked out from the documents: drawings
// arrive over time, so the lines uploaded so far are usually fewer than the lines
// there will be, and progress is measured against the whole.
export const projectLineTotals = pgTable(
  "project_line_totals",
  {
    projectId: uuid("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    totalLines: integer("total_lines").notNull(),
    updatedBy: uuid("updated_by").references(() => authUsers.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("project_line_totals_total_check", sql`${table.totalLines} >= 0`)]
);

// A line number a checker has marked as reviewed. One row per line per project:
// its presence IS "done", and reopening a line deletes it.
//
// `lineKey` is the normalized number lines are matched on everywhere else;
// `lineNumber` is the number as printed, for showing. `reviewedByName` is a
// snapshot taken at the time -- the name lives on the Supabase account, which
// this schema does not own, and a review should keep saying who did it even if
// the account later changes or goes.
export const lineReviews = pgTable(
  "line_reviews",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    lineKey: text("line_key").notNull(),
    lineNumber: text("line_number").notNull(),
    reviewedBy: uuid("reviewed_by").references(() => authUsers.id, { onDelete: "set null" }),
    reviewedByName: text("reviewed_by_name"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.lineKey] })]
);

// ---------------------------------------------------------------------------
// Library: reference material that is not itself reviewed -- legends, client
// specifications, standards, templates, datasheets.
//
// It is kept apart from `documents` on purpose. A document is a drawing or table
// the extraction reads and the checks run against; a library file is only ever
// looked up and downloaded. Putting them in one table would make every extraction
// query have to say which it means.
//
// `projectId` null means the OVERALL library: it belongs to the organization and
// is shared by all of its projects. Otherwise the file belongs to that one
// project. Either way `organizationId` is set, so a file can always be traced to
// the organization that owns it without a join.
// ---------------------------------------------------------------------------
export const libraryItems = pgTable(
  "library_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    fileName: text("file_name").notNull(),
    storagePath: text("storage_path").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    contentType: text("content_type"),
    uploadedBy: uuid("uploaded_by").references(() => authUsers.id, { onDelete: "set null" }),
    // A snapshot, like line_reviews.reviewed_by_name: the name lives on the
    // Supabase account, which this schema does not own.
    uploadedByName: text("uploaded_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("library_items_org_idx").on(table.organizationId),
    index("library_items_project_idx").on(table.projectId),
    check("library_items_category_check", sql`${table.category} in ('legend','specification','standard','template','datasheet','other')`),
  ]
);
