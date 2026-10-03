/**
 * Database schema.
 *
 * Six tables, and every one of them is something the dashboard reads on
 * screen. Nothing here is speculative: a column that no query selects is a
 * migration someone has to run.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * A project: one repository.
 *
 * `branch` distinguishes branches, because a score on `main` and a score on a
 * feature branch are different facts and averaging them produces nonsense.
 */
export const projectsTable = pgTable('projects', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  repository: text('repository'),
  defaultBranch: text('default_branch').notNull().default('main'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One scan of one project. The full report is kept so nothing is lost. */
export const scansTable = pgTable(
  'scans',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projectsTable.id, { onDelete: 'cascade' }),
    score: integer('score').notNull(),
    grade: text('grade').notNull(),
    verdict: text('verdict').notNull(),
    commitSha: text('commit_sha'),
    branch: text('branch'),
    blockers: integer('blockers').notNull().default(0),
    findingsCount: integer('findings_count').notNull().default(0),
    /** Category scores keyed by category name, for the radar chart. */
    categories: jsonb('categories').notNull().default({}),
    /** The report summary, for the dashboard tiles. */
    summary: jsonb('summary').notNull().default({}),
    /** The whole ProductionReadinessReport. */
    report: jsonb('report').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectIdx: index('scans_project_idx').on(table.projectId),
    projectCreatedIdx: index('scans_project_created_idx').on(table.projectId, table.createdAt),
  }),
);

/**
 * A finding, denormalised out of the report.
 *
 * The report already contains every finding. This table exists because
 * "show me every critical finding in this project" is a question you cannot
 * answer efficiently by walking JSON, and because the dashboard filters and
 * sorts across scans.
 */
export const findingsTable = pgTable(
  'findings',
  {
    id: serial('id').primaryKey(),
    scanId: integer('scan_id')
      .notNull()
      .references(() => scansTable.id, { onDelete: 'cascade' }),
    findingId: text('finding_id').notNull(),
    ruleId: text('rule_id').notNull(),
    title: text('title').notNull(),
    severity: text('severity').notNull(),
    productionImpact: text('production_impact').notNull(),
    category: text('category').notNull(),
    confidence: real('confidence').notNull(),
    path: text('path').notNull(),
    line: integer('line').notNull(),
    fixable: boolean('fixable').notNull().default(false),
    effortMinutes: integer('effort_minutes').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scanIdx: index('findings_scan_idx').on(table.scanId),
    ruleIdx: index('findings_rule_idx').on(table.ruleId),
    findingUnique: uniqueIndex('findings_scan_finding_idx').on(table.scanId, table.findingId),
  }),
);

/**
 * An observed agent trace.
 *
 * Only the summary is stored, not the events. Events can be tens of thousands
 * of rows per run; the dashboard shows totals and trends, and the full trace
 * stays in the local SQLite file the CLI wrote.
 */
export const tracesTable = pgTable(
  'traces',
  {
    id: text('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projectsTable.id, { onDelete: 'cascade' }),
    command: text('command').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    durationMs: integer('duration_ms').notNull(),
    exitCode: integer('exit_code'),
    totalCostUsd: real('total_cost_usd').notNull().default(0),
    costComplete: boolean('cost_complete').notNull().default(true),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    llmCalls: integer('llm_calls').notNull().default(0),
    toolCalls: integer('tool_calls').notNull().default(0),
    errors: integer('errors').notNull().default(0),
    summary: jsonb('summary').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectIdx: index('traces_project_idx').on(table.projectId),
    startedIdx: index('traces_project_started_idx').on(table.projectId, table.startedAt),
  }),
);

/**
 * A compliance pack version.
 *
 * The documents themselves are not stored. This records which frameworks were
 * generated, the score, and the gap count, which is what the dashboard trends.
 */
export const complianceTable = pgTable(
  'compliance_packs',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projectsTable.id, { onDelete: 'cascade' }),
    company: text('company').notNull(),
    systemName: text('system_name').notNull(),
    jurisdiction: text('jurisdiction').notNull(),
    frameworks: jsonb('frameworks').notNull().default([]),
    score: integer('score').notNull(),
    gaps: jsonb('gaps').notNull().default([]),
    documentCount: integer('document_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectIdx: index('compliance_project_idx').on(table.projectId),
  }),
);

/** A validated e-invoice. */
export const invoicesTable = pgTable(
  'invoices',
  {
    id: serial('id').primaryKey(),
    projectId: integer('project_id').references(() => projectsTable.id, { onDelete: 'set null' }),
    country: text('country').notNull(),
    documentType: text('document_type').notNull(),
    number: text('number').notNull(),
    issuer: text('issuer').notNull().default(''),
    total: real('total').notNull().default(0),
    currency: text('currency').notNull().default(''),
    valid: boolean('valid').notNull(),
    score: integer('score').notNull(),
    errorCount: integer('error_count').notNull().default(0),
    issues: jsonb('issues').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectIdx: index('invoices_project_idx').on(table.projectId),
    createdIdx: index('invoices_created_idx').on(table.createdAt),
  }),
);

/** Every table, for Drizzle's `{ schema }` option. */
export const schema = {
  projects: projectsTable,
  scans: scansTable,
  findings: findingsTable,
  traces: tracesTable,
  compliance: complianceTable,
  invoices: invoicesTable,
};

export default schema;
