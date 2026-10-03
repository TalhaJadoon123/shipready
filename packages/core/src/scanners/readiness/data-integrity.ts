import { defineRule, type Rule } from '../../rules/scanner-helper.js';
import { COMPLIANCE } from '../../rules/rule.js';
import { allFiles, anchorPath, filesWithExts, JS_EXTS, SERVER_EXTS } from './helpers.js';
import type { ScanContext } from '../../types.js';

export const dataIntegrityRules: Rule[] = [
  defineRule(
    {
      id: 'readiness/data-integrity/no-backup-strategy',
      name: 'No documented backup or recovery strategy',
      category: 'data-integrity',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.7,
      effortMinutes: 60,
      fixable: false,
      description:
        'Nothing documents how data is backed up or restored. Backups you have never restored from are a hypothesis, not a backup. Note that snapshots are not backups: they share the blast radius of the account they live in.',
      remediation:
        'Enable automated daily backups with a retention policy (7 daily, 4 weekly, 6 monthly is a reasonable default). Write down the restore procedure and the recovery time objective. Restore into staging quarterly and time it. If you are on serverless Postgres (Neon, Supabase), point-in-time recovery covers this.',
      compliance: [COMPLIANCE.gdprArticle32, COMPLIANCE.euAiActArticle15, COMPLIANCE.iso27001A5, COMPLIANCE.soc2CC6],
      cwe: 'CWE-530',
      tags: ['disaster-recovery', 'data-loss', 'launch-blocker'],
      references: ['https://gdpr-info.eu/art-32-gdpr/'],
    },
    function* (ctx, emit) {
      if (!hasPersistentData(ctx)) return;
      const text = docsText(ctx);
      if (/\bbackup\b|\bbackups\b/i.test(text) && /restore|recovery\s*(point|time)|RTO|RPO/i.test(text)) return;
      const infra = infraConfig(ctx);
      if (/point-in-time|PITR|pitr|daily.*backup|backup.*daily|automated\s+backup/i.test(infra)) return;
      yield emit({
        path: anchorPath(ctx, ['README.md', 'docs/operations.md', 'RUNBOOK.md']),
        evidence:
          hasPersistentDataNote(ctx) === false
            ? 'no backup, restore or recovery-time documentation found'
            : 'backups mentioned but no restore procedure or recovery objective documented',
        tags: ['disaster-recovery', 'data-loss', 'launch-blocker'],
      });
    },
    (ctx) => hasPersistentData(ctx),
  ),

  defineRule(
    {
      id: 'readiness/data-integrity/no-audit-trail',
      name: 'Mutations are not recorded in an audit trail',
      category: 'data-integrity',
      severity: 'high',
      impact: 'blocker',
      confidence: 0.6,
      effortMinutes: 90,
      fixable: false,
      description:
        'Records are created, updated and deleted with no record of who did it and when. When a customer disputes a charge, a regulator asks about a deletion, or an insider removes data, there is nothing to reconstruct. Logs help, but logs are not an audit trail: they are mutable and expire.',
      remediation:
        'Add an append-only audit table (`audit_log`) written in the same transaction as the mutation, recording actor id, action, entity type and id, before/after values, IP, timestamp and request id. Never update or delete audit rows. Retain them on a schedule aligned with your compliance obligations.',
      compliance: [COMPLIANCE.euAiActArticle12, COMPLIANCE.euAiActArticle19, COMPLIANCE.gdprArticle30, COMPLIANCE.soc2CC6],
      tags: ['audit', 'compliance', 'launch-blocker', 'gdpr'],
      references: ['https://gdpr-info.eu/art-30-gdpr/'],
    },
    function* (ctx, emit) {
      if (!hasPersistentData(ctx)) return;
      if (hasAuditTrail(ctx)) return;
      const mutations = countMutationSites(ctx);
      if (mutations < 2) return;
      yield emit({
        path: anchorPath(ctx, ['README.md', 'docs/audit.md']),
        evidence: `${mutations} create/update/delete call site(s) with no audit log, activity table or history field`,
        data: { mutationSites: mutations },
      });
    },
    (ctx) => hasPersistentData(ctx),
  ),

  defineRule(
    {
      id: 'readiness/data-integrity/no-validation-layer',
      name: 'Data written to the database with no schema validation',
      category: 'data-integrity',
      severity: 'high',
      impact: 'degradation',
      confidence: 0.7,
      effortMinutes: 60,
      fixable: false,
      description:
        'Data reaches the database without passing through a validation layer. Malformed rows accumulate: an email column holding "N/A", a required field that is sometimes null, a price stored as a string. These become bugs months later, in the reporting query nobody can fix.',
      remediation:
        'Validate at the boundary (see the security category) and defend in depth with a database-level constraint: `NOT NULL`, `CHECK`, a foreign key, and a `CHECK (email LIKE \'%@%\')`-style sanity constraint where it matters. Treat the database schema as the last line of defence, not the first.',
      compliance: [COMPLIANCE.gdprArticle5, COMPLIANCE.euAiActArticle10],
      tags: ['validation', 'schema', 'gdpr'],
      references: ['https://www.postgresql.org/docs/current/ddl-constraints.html'],
    },
    function* (ctx, emit) {
      if (!hasPersistentData(ctx)) return;
      if (hasValidationLayer(ctx)) return;
      yield emit({
        path: anchorPath(ctx, ['src/lib/validation.ts', 'app/api/route.ts', 'server/index.js']),
        evidence:
          'no schema validation library and no database CHECK/NOT NULL constraints found on write paths',
      });
    },
    (ctx) => hasPersistentData(ctx),
  ),

  defineRule(
    {
      id: 'readiness/data-integrity/hard-delete-user-data',
      name: 'User data is hard deleted with no retention control',
      category: 'data-integrity',
      severity: 'high',
      impact: 'degradation',
      confidence: 0.6,
      effortMinutes: 60,
      fixable: false,
      description:
        'Deleting a user runs an unfiltered DELETE, or a cascade from a parent record. Under GDPR, erasure is conditional: you must delete personal data, but many records must be retained for legal, tax or accounting reasons, and cascading a delete through an orders table destroys financial records you are required to keep.',
      remediation:
        'Adopt soft delete (`deletedAt`) for user-facing records so a mistaken delete is recoverable within a retention window. For real erasure, anonymise rather than cascade-delete: null out the personal fields, keep the financial record. Add a scheduled retention job and document each retention period against its legal basis.',
      compliance: [COMPLIANCE.gdprArticle17, COMPLIANCE.gdprArticle5, COMPLIANCE.gdprArticle30],
      tags: ['gdpr', 'deletion', 'retention'],
      references: ['https://gdpr-info.eu/art-17-gdpr/'],
    },
    function* (ctx, emit) {
      if (!hasPersistentData(ctx)) return;
      if (hasSoftDelete(ctx)) return;
      const hardDeletes = allFiles(ctx).reduce(
        (n, f) => n + f.matchNoComments(/\.(delete|deleteMany|remove|removeMany|hardDelete|destroy)\s*\(/g).length,
        0,
      );
      // A single hard delete of a user record is the finding. Waiting for two
      // means a small app with one endpoint is told it is fine.
      if (hardDeletes < 1) return;
      yield emit({
        path: anchorPath(ctx, ['src/models/user.ts', 'prisma/schema.prisma', 'app/models.py']),
        evidence: `${hardDeletes} delete call site(s) with no soft-delete column and no retention policy`,
        data: { deleteSites: hardDeletes },
      });
    },
    (ctx) => hasPersistentData(ctx),
  ),

  defineRule(
    {
      id: 'readiness/data-integrity/payment-without-idempotency',
      name: 'Payment or charge path has no idempotency key',
      category: 'data-integrity',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.55,
      effortMinutes: 60,
      fixable: false,
      description:
        'A charge is created without an idempotency key. Network timeouts cause clients to retry, and the user is charged twice. This is not hypothetical: it is the most common cause of double-charging complaints, and the money is hard to get back.',
      remediation:
        'Generate a client-supplied idempotency key per logical operation, store it with a unique constraint, and return the original result on a repeat. Pass it to the provider (`Idempotency-Key` for Stripe). Retrying a payment is a client behaviour you cannot prevent, so design for it.',
      compliance: [COMPLIANCE.gdprArticle5, COMPLIANCE.owaspA04],
      cwe: 'CWE-799',
      tags: ['payments', 'financial', 'launch-blocker', 'idempotency'],
      references: ['https://docs.stripe.com/api/idempotent_requests'],
    },
    function* (ctx, emit) {
      const payDeps = ['stripe', '@stripe/stripe-js', 'paddle', '@paddle/paddle-node-sdk', 'lemonsqueezy', 'braintree', 'paypal', 'razorpay'];
      const hasPayments = payDeps.some((d) => ctx.project.dependencyNames.has(d));
      const files = filesWithExts(ctx, ...SERVER_EXTS);
      const paymentCalls = files.filter((f) =>
        /\b(paymentIntents?\.(create|confirm)|charges\.create|paymentMethod|checkout\.sessions\.create|paddle\.|lemonsqueezy|invoices\.create|payment_link)/i.test(
          f.content,
        ),
      );
      if (paymentCalls.length === 0) return;
      if (hasPayments || paymentCalls.length > 0) {
        // Only report when a payment API is actually called.
        const risky = paymentCalls.filter((f) => !/idempotency|idempotent|idempotency_key|Idempotency-Key/i.test(f.content));
        if (risky.length === 0) return;
        yield emit({
          path: risky[0]!.path,
          line: firstPaymentLine(risky[0]!),
          evidence: `${risky.length} payment API call file(s) with no idempotency key -- retries can double-charge`,
          data: { files: risky.map((f) => f.path) },
          tags: ['payments', 'financial', 'launch-blocker', 'idempotency'],
        });
      }
    },
  ),

  defineRule(
    {
      id: 'readiness/data-integrity/no-timezone-handling',
      name: 'Dates stored without an explicit timezone',
      category: 'data-integrity',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.45,
      effortMinutes: 30,
      fixable: false,
      description:
        'Timestamps are created with `new Date()` or `datetime.now()` without a timezone. Naive timestamps become ambiguous across deploy regions and daylight-saving boundaries, and the resulting off-by-one-day bugs in billing and reporting are notoriously hard to trace.',
      remediation:
        'Store timestamps in UTC (`timestamptz` in Postgres, `DateTime` with timezone in Django). Keep timezone conversion at the presentation boundary, in the browser. Make the timezone explicit in the API contract and format explicitly with `Intl.DateTimeFormat` and a named `timeZone`.',
      // A stored timestamp that is wrong by a day is inaccurate personal data,
      // which is a GDPR Article 5(1)(d) issue as soon as it touches a user record.
      compliance: [COMPLIANCE.gdprArticle5],
      tags: ['timezones', 'bug-class'],
      references: ['https://www.postgresql.org/docs/current/datatype-datetime.html'],
    },
    function* (ctx, emit) {
      if (!hasPersistentData(ctx)) return;
      if (/timestamptz|timestamp with time zone|TIMESTAMP\s+WITH\s+ZONE|DateTime\(|useUtc|timezone-aware|pytz\.timezone|zoneinfo/.test(allFiles(ctx).map((f) => f.content).join('\n'))) return;
      const naive = filesWithExts(ctx, ...JS_EXTS, '.py').filter((f) =>
        /new\s+Date\s*\(\s*\)|Date\.now\s*\(\s*\)|datetime\.now\s*\(\s*\)|new\s+Date\s*\(\s*Date\.now/.test(f.content),
      );
      const writes = allFiles(ctx).some((f) => /\.(create|insert|save|update)\s*\(/.test(f.content));
      if (!writes) return;
      yield emit({
        path: naive[0]?.path ?? anchorPath(ctx),
        line: 1,
        evidence: `${naive.length} file(s) create naive timestamps while writing to the database with no timezone-aware column type`,
        data: { files: naive.slice(0, 8).map((f) => f.path) },
        confidenceScale: 0.6,
      });
    },
    (ctx) => hasPersistentData(ctx),
  ),
];

// ---------------------------------------------------------------------------

function hasPersistentData(ctx: ScanContext): boolean {
  const sqlish = /\b(prisma|drizzle|typeorm|sequelize|mongoose|knex|sqlalchemy|psycopg|pg|mysql2|sqlite3|sqlite|better-sqlite3|DATABASE_URL|createPool|new Pool\(|redis|ioredis|@upstash\/redis|mongodb|MongoClient)/;
  return (
    ['prisma', 'drizzle-orm', 'typeorm', 'sequelize', 'mongoose', 'knex', 'sqlalchemy', 'django', 'pg', 'mysql2', 'redis', 'better-sqlite3', 'mongodb'].some((d) =>
      ctx.project.dependencyNames.has(d),
    ) ||
    allFiles(ctx).some((f) => sqlish.test(f.content))
  );
}

function hasPersistentDataNote(ctx: ScanContext): boolean {
  return hasPersistentData(ctx);
}

function docsText(ctx: ScanContext): string {
  return allFiles(ctx)
    .filter((f) => /\.mdx?$/.test(f.path))
    .map((f) => f.content)
    .join('\n');
}

function infraConfig(ctx: ScanContext): string {
  return allFiles(ctx)
    .filter((f) => /\.(ya?ml|toml|json)$/.test(f.path) && !/package\.json$/.test(f.path))
    .map((f) => f.content)
    .join('\n');
}

function hasAuditTrail(ctx: ScanContext): boolean {
  if (allFiles(ctx).some((f) => /audit[_-]?log|auditLog|audit_trail|activity[_-]?log|activityLog|AuditEntry|audit_log|who_changed|activityFeed/i.test(f.content))) return true;
  const schema = allFiles(ctx).find((f) => /schema\.prisma$|\/(models|migrations)\//.test(f.path));
  if (schema && /audit|activity|history/i.test(schema.content)) return true;
  return false;
}

function hasValidationLayer(ctx: ScanContext): boolean {
  const libs = ['zod', 'yup', 'joi', 'valibot', 'ajv', 'superstruct', 'typebox', 'pydantic', 'marshmallow', 'voluptuous', 'cerberus'];
  if (libs.some((l) => ctx.project.dependencyNames.has(l))) return true;
  if (allFiles(ctx).some((f) => /\bCHECK\s*\(|check\s*:\s*|CheckConstraint|@db\.VarChar\(|\bNOT\s+NULL\b/i.test(f.content))) return true;
  return false;
}

function hasSoftDelete(ctx: ScanContext): boolean {
  return allFiles(ctx).some((f) =>
    /deletedAt|deleted_at|softDelete|soft_delete|archivedAt|archived_at|isDeleted|is_deleted|paranoid\s*:\s*true|@paranoid|paranoidMode/i.test(f.content),
  );
}

function countMutationSites(ctx: ScanContext): number {
  let n = 0;
  for (const f of filesWithExts(ctx, ...SERVER_EXTS, '.py')) {
    n += f.matchNoComments(/\.(create|createMany|insert|insertMany|update|updateMany|upsert|save|insertOne|updateOne|delete)\s*\(/g).length;
  }
  return n;
}

function firstPaymentLine(file: { lines: string[] }): number {
  const idx = file.lines.findIndex((l) => /paymentIntents?\.|charges\.create|checkout\.sessions\.create/i.test(l));
  return idx >= 0 ? idx + 1 : 1;
}