import { internals } from '../../context.js';
import { defineRule, type Rule } from '../../rules/scanner-helper.js';
import { COMPLIANCE } from '../../rules/rule.js';
import { allFiles, ext, filesWithExts, JS_EXTS, SERVER_EXTS } from './helpers.js';
import type { SourceFile } from '../../source.js';
import type { ScanContext } from '../../types.js';

const ORMS = ['prisma', 'drizzle-orm', 'typeorm', 'sequelize', 'mongoose', 'knex', 'sqlalchemy', 'django', 'sqlmodel', 'tortoise-orm', 'mikro-orm', 'kysely', 'obj'];

/**
 * Whether an installed dependency is one of these ORMs.
 *
 * Matching is by substring rather than set membership because the package name
 * is not always the framework name: Prisma installs as `@prisma/client`, which
 * does not contain the string `prisma` as a set member test would require, and
 * `@prisma/client` is the only Prisma package most projects install.
 */
function hasOrmDependency(ctx: ScanContext): boolean {
  const names = [...ctx.project.dependencyNames];
  return ORMS.some((orm) =>
    names.some((n) => n === orm || n === `@${orm}/client` || n.includes(`${orm}-orm`) || n === `@prisma/${orm}`),
  );
}

export const databaseRules: Rule[] = [
  defineRule(
    {
      id: 'readiness/database/no-migration-system',
      name: 'No database migration system',
      category: 'database',
      severity: 'high',
      impact: 'blocker',
      confidence: 0.75,
      effortMinutes: 120,
      fixable: false,
      description:
        'The app talks to a database with no versioned migrations. Schema changes are applied by hand, so environments drift: staging works, production has a missing column, and there is no way to roll back a bad deploy.',
      remediation:
        'Adopt the framework-native migration tool: Prisma Migrate, Drizzle Kit, Alembic, Django migrations, `golang-migrate`, or `sqlx migrate`. Commit migrations, run them in CI before deploy, and never edit a live schema directly.',
      compliance: [COMPLIANCE.owaspA09, COMPLIANCE.gdprArticle5, COMPLIANCE.iso27001A8],
      cwe: 'CWE-1104',
      tags: ['schema', 'deploy', 'launch-blocker'],
      references: ['https://www.prisma.io/docs/orm/prisma-migrate'],
    },
    function* (ctx, emit) {
      if (!usesDatabase(ctx)) return;
      if (hasMigrations(ctx)) return;
      yield emit({
        path: migrationAnchor(ctx),
        evidence: `${ormNames(ctx).join(', ') || 'a SQL database'} in use with no migration directory or tool configured`,
        data: { orms: ormNames(ctx) },
      });
    },
    (ctx) => usesDatabase(ctx),
  ),

  defineRule(
    {
      id: 'readiness/database/no-connection-pooling',
      name: 'No database connection pooling',
      category: 'database',
      severity: 'high',
      impact: 'blocker',
      confidence: 0.7,
      effortMinutes: 45,
      fixable: false,
      description:
        'The app opens a new database connection per request with no pool. Under load the database hits its connection limit, then every request fails, and the service looks healthy right up until it does not.',
      remediation:
        'Use a pooler. Node: `pg.Pool` with a bounded max, Prisma with an explicit `connection_limit`, or a managed pooler (PgBouncer, Neon, Supabase pooler). Set the pool size from your database max_connections divided by the number of app instances, and set a connection timeout.',
      compliance: [COMPLIANCE.owaspA09, COMPLIANCE.euAiActArticle15],
      tags: ['performance', 'reliability', 'launch-blocker'],
      references: ['https://node-postgres.com/features/pooling'],
    },
    function* (ctx, emit) {
      if (!usesDatabase(ctx)) return;
      if (hasPooling(ctx)) return;
      yield emit({
        path: dbClientAnchor(ctx),
        evidence: 'database client created with no pool, no connection limit and no connection timeout',
        data: { orms: ormNames(ctx) },
      });
    },
    (ctx) => usesDatabase(ctx),
  ),

  defineRule(
    {
      id: 'readiness/database/missing-foreign-key-index',
      name: 'Foreign key column has no index',
      category: 'database',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.7,
      effortMinutes: 25,
      fixable: false,
      description:
        'A schema defines a foreign key with no index on the referencing column. Every join, every `WHERE user_id = ?`, and every cascade delete becomes a full table scan. The cost is invisible at 10k rows and fatal at 10 million.',
      remediation:
        'Add an index on every foreign key column. Most frameworks do not do this for you: Prisma requires `@@index([userId])` in addition to `@relation`, SQLAlchemy needs `index=True`, Django needs `db_index=True`.',
      compliance: [COMPLIANCE.owaspA09],
      tags: ['performance', 'schema'],
      references: ['https://www.postgresql.org/docs/current/indexes.html'],
    },
    function* (ctx, emit) {
      const schema = await0(ctx, ['schema.prisma', 'prisma/schema.prisma', 'db/schema.prisma']);
      if (schema) {
        const lines = schema.lines;
        for (let i = 0; i < lines.length; i++) {
          const modelMatch = /^model\s+(\w+)\s*\{/.exec((schema.noComments.split('\n')[i] ?? '').trim());
          if (!modelMatch?.[1]) continue;
          const modelName = modelMatch[1];

          // Collect the whole model block by brace depth so @@index
          // declarations anywhere in it are visible.
          let depth = 0;
          const body: { line: number; text: string }[] = [];
          for (let j = i; j < lines.length; j++) {
            const text = schema.line(j + 1);
            for (const ch of text) {
              if (ch === '{') depth++;
              else if (ch === '}') depth--;
            }
            body.push({ line: j + 1, text });
            if (depth <= 0 && j > i) break;
          }
          const blockText = body.map((b) => b.text).join('\n');

          for (const entry of body) {
            // A relation field: `user User @relation(fields: [userId], references: [id])`.
            // The column that needs an index is the one in `fields:`, not the
            // relation field name: `userId` is what every join filters on.
            const rel = /^\s*(\w+)\s+\w[\w[\]?]*\s+@relation\s*\(([^)]*)\)/.exec(entry.text);
            if (!rel?.[1]) continue;
            const fieldsArg = /\bfields\s*:\s*\[([^\]]*)\]/.exec(rel[2] ?? '')?.[1] ?? '';
            const columns = fieldsArg
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            const targets = columns.length > 0 ? columns : [rel[1]];

            for (const column of targets) {
              if (new RegExp(`@@index\\([^)]*\\b${escapeRegExp(column)}\\b`).test(blockText)) continue;
              // A unique constraint also produces an index.
              if (new RegExp(`@@unique\\([^)]*\\b${escapeRegExp(column)}\\b`).test(blockText)) continue;
              if (new RegExp(`^\\s*${escapeRegExp(column)}\\s+[^\\n]*@unique`, 'm').test(blockText)) continue;
              yield emit({
                path: schema.path,
                line: entry.line,
                snippet: entry.text,
                evidence: `model ${modelName}: foreign key \`${column}\` (via \`${rel[1]}\`) has no @@index and no @unique`,
                data: { model: modelName, field: column, relation: rel[1] },
              });
            }
          }
        }
        return;
      }

      const migrations = ctx.filter((f) => /(^|\/)(migrations?|migrate|alembic)\//.test(f) && /\.(sql|py|prisma|ts|js)$/.test(f));
      for (const path of migrations.slice(0, 40)) {
        const file = filesWithExts(ctx, ext(path)).find((f) => f.path === path);
        if (!file) continue;
        for (const hit of file.matchNoComments(/REFERENCES\s+["`]?(\w+)["`]?\s*\(\s*["`]?(\w+)["`]?\s*\)/gi)) {
          const before = file.content.slice(Math.max(0, hit.index - 200), hit.index);
          if (/CREATE\s+INDEX|UNIQUE\s*\(/i.test(before)) continue;
          yield emit({
            path: file.path,
            line: hit.line,
            snippet: hit.text,
            evidence: 'foreign key constraint added without a preceding CREATE INDEX on the referencing column',
          });
        }
      }
    },
    (ctx) => usesDatabase(ctx),
  ),

  defineRule(
    {
      id: 'readiness/database/n-plus-one',
      name: 'Database query inside a loop',
      category: 'database',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.6,
      effortMinutes: 45,
      fixable: false,
      description:
        'A query is issued inside a loop over a collection. With 100 items that is 101 round trips; with 100,000 items the endpoint does not return at all. It is the single most common performance bug in ORM code, including code an LLM wrote for you.',
      remediation:
        'Fetch the related rows in one query with a join or an `include`/`select_related`/`populate`, then index them in a Map. If the loop is over a user-supplied list, cap the list size.',
      compliance: [COMPLIANCE.owaspA09],
      tags: ['performance', 'orm'],
      references: ['https://ormcheatsheet.kubb.dev/'],
    },
    function* (ctx, emit) {
      if (!usesDatabase(ctx)) return;
      for (const file of filesWithExts(ctx, ...JS_EXTS, '.py')) {
        if (/(^|\/)(test|tests|__tests__|fixtures|seed|scripts?)\//.test(file.path)) continue;
        // Per-file gate as well as the project-wide one. A monorepo can contain
        // a database service and a pure library, and `.get(`/`.create(`/`.select`
        // are extremely common method names outside an ORM: a Zod schema walker,
        // a Map wrapper, a builder. Without this, one project-wide `pg.` match
        // makes every unrelated file look like it has query problems.
        if (!fileTouchesDatabase(ctx, file)) continue;
        const lines = file.lines;
        for (let i = 0; i < lines.length; i++) {
          const code = file.lineNoComments(i + 1);
          const isLoop = /\b(for\s*\(|for\s+\w+\s+of|for\s+\w+\s+in\b|\.map\s*\(\s*async|\.forEach\s*\(\s*async|while\s*\(|\.map\s*\(\s*\()/.test(code);
          if (!isLoop) continue;
          const depth = indentOfLine(code);
          let queries = 0;
          let firstQueryLine = 0;
          let firstQueryText = '';
          for (let j = i + 1; j < Math.min(lines.length, i + 25); j++) {
            const inner = file.lineNoComments(j + 1);
            if (inner === '') continue;
            const innerIndent = indentOfLine(lines[j]!);
            if (innerIndent <= depth && /\}/.test(inner)) break;
            if (looksLikeDbCall(inner)) {
              if (queries === 0) {
                firstQueryLine = j + 1;
                firstQueryText = file.line(j + 1);
              }
              queries++;
            }
          }
          if (queries < 1) continue;
          if (file.hasExplanatoryCommentNear(i + 1, ['batch', 'bulk', 'deliberately', 'small list', 'bounded', 'in-memory'])) continue;
          yield emit({
            path: file.path,
            line: firstQueryLine || i + 1,
            snippet: firstQueryText,
            evidence: `${queries} database call(s) inside a loop -- classic N+1`,
            data: { queriesInLoop: queries },
          });
          i += 20;
        }
      }
    },
    (ctx) => usesDatabase(ctx),
  ),

  defineRule(
    {
      id: 'readiness/database/no-transaction',
      name: 'Multi-step write with no transaction',
      category: 'database',
      severity: 'high',
      impact: 'blocker',
      confidence: 0.55,
      effortMinutes: 45,
      fixable: false,
      description:
        'Several writes are performed in sequence with no transaction. If the process dies, the network drops, or the second write fails, the database is left in a half-finished state: the order exists with no payment, the user exists with no account, the invoice exists with no line items.',
      remediation:
        'Wrap the writes in a transaction: `prisma.$transaction`, `db.transaction()`, Django `atomic()`, SQLAlchemy `with session.begin()`, or an explicit `BEGIN`/`COMMIT`. Make the operation idempotent as well, so a retry after a timeout cannot double-charge.',
      compliance: [COMPLIANCE.gdprArticle5, COMPLIANCE.owaspA09],
      tags: ['data-integrity', 'launch-blocker', 'payments'],
      references: ['https://www.prisma.io/docs/orm/prisma-client/queries/transactions'],
    },
    function* (ctx, emit) {
      if (!usesDatabase(ctx)) return;
      if (hasTransactions(ctx)) return;
      for (const file of filesWithExts(ctx, ...SERVER_EXTS, '.py')) {
        if (/(^|\/)(test|tests|fixtures|seed|scripts?)\//.test(file.path)) continue;
        if (!fileTouchesDatabase(ctx, file)) continue;
        const lines = file.lines;
        for (let i = 0; i < lines.length; i++) {
          const code = file.lineNoComments(i + 1);
          if (!/async\s+function|export\s+(async\s+)?function|def\s+/.test(code)) continue;
          const writes: { line: number; text: string; kind: string }[] = [];
          const baseIndent = indentOfLine(lines[i]!);
          for (let j = i + 1; j < Math.min(lines.length, i + 60); j++) {
            const raw = lines[j]!;
            if (raw === '') continue;
            const ind = indentOfLine(raw);
            if (ind <= baseIndent && /^(\}|def |function|export )/.test(raw.trim())) break;
            const inner = file.lineNoComments(j + 1);
            const kind =
              looksLikeWrite(inner) ??
              /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i.exec(inner)?.[1];
            if (kind) writes.push({ line: j + 1, text: file.line(j + 1), kind });
            if (writes.length >= 3) break;
          }
          if (writes.length < 2) continue;
          if (/\$transaction|db\.transaction|with\s+session\.begin|atomic\(|BEGIN|BEGIN;|with\s+db\.transaction|transaction\s*\(/.test(file.content)) continue;
          yield emit({
            path: file.path,
            line: writes[1]!.line,
            snippet: writes[1]!.text,
            evidence: `${writes.length} sequential writes (${writes.map((w) => w.kind).join(', ')}) with no transaction wrapper`,
            data: { writes: writes.length },
          });
        }
      }
    },
    (ctx) => usesDatabase(ctx),
  ),

  defineRule(
    {
      id: 'readiness/database/unbounded-query',
      name: 'Query with no limit or pagination',
      category: 'database',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.7,
      effortMinutes: 20,
      fixable: false,
      description:
        'A list query fetches every matching row. Once the table has a few hundred thousand rows the response is tens of megabytes, the request times out, and the database connection is held for the duration.',
      remediation:
        'Always paginate list endpoints. Use cursor pagination (`cursor`/`skip` with a `take`) rather than large offsets, and cap the maximum page size server-side regardless of what the client asks for.',
      compliance: [COMPLIANCE.owaspA09],
      tags: ['performance', 'api'],
      references: ['https://www.prisma.io/docs/orm/prisma-client/queries/pagination'],
    },
    function* (ctx, emit) {
      if (!usesDatabase(ctx)) return;
      for (const file of filesWithExts(ctx, ...SERVER_EXTS, '.py')) {
        // Same per-file gate as n-plus-one: `all`, `list` and `search` are
        // ordinary names on ordinary objects.
        if (!fileTouchesDatabase(ctx, file)) continue;
        for (let line = 1; line <= file.lineCount; line++) {
          const code = file.lineNoComments(line);
          const hit = UNBOUNDED_VERBS.exec(code);
          if (!hit) continue;
          // `matchCode` reports offsets from the masked text; the masked text
          // has the same length as the original, so the offset is valid in both.
          const maskHit = file.matchCode(UNBOUNDED_VERBS, file.noComments).find((m) => m.line === line);
          const block = maskHit ? file.windowAround(maskHit.index, 400) : '';
          if (/\b(take|limit|LIMIT|per_page|pageSize|first|cursor|skip|offset|head)\b/.test(block)) continue;
          if (/(^|\/)(test|tests|fixtures|seed|scripts?)\//.test(file.path)) continue;
          yield emit({
            path: file.path,
            line,
            snippet: code,
            evidence: `\`${hit[1]}\` with no take/limit/cursor -- returns the entire table`,
          });
        }
      }
    },
    (ctx) => usesDatabase(ctx),
  ),

  defineRule(
    {
      id: 'readiness/database/missing-unique-constraint',
      name: 'Write path with no uniqueness guarantee',
      category: 'database',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.45,
      effortMinutes: 30,
      fixable: false,
      description:
        'The app creates records identified by a natural key (email, external id, slug) with no unique constraint in the schema. Two concurrent requests create duplicates, and every later lookup returns an arbitrary one.',
      remediation:
        'Add a `UNIQUE` constraint on the natural key and handle the conflict as a normal outcome (catch the unique-violation error and return 409). Application-level "check then insert" does not work: there is a window between the check and the insert.',
      compliance: [COMPLIANCE.gdprArticle5],
      tags: ['data-integrity', 'concurrency'],
      references: ['https://www.postgresql.org/docs/current/ddl-constraints.html'],
    },
    function* (ctx, emit) {
      const schema = await0(ctx, ['schema.prisma', 'prisma/schema.prisma', 'db/schema.prisma']);
      if (schema) {
        for (const hit of schema.matchNoComments(/^\s+(\w+)\s+String(\?)?\s+@unique/gm)) {
          void hit;
          continue;
        }
        // Report models that have an obvious natural key with no @unique.
        const blocks = schema.content.split(/\nmodel\s+/).slice(1);
        for (const block of blocks) {
          const modelName = block.match(/^(\w+)/)?.[1];
          if (!modelName) continue;
          if (/@unique|@@unique/.test(block)) continue;
          const emailField = /\n\s+(\w*email\w*)\s+String/.exec(block)?.[1];
          if (!emailField) continue;
          yield emit({
            path: schema.path,
            line: 1,
            evidence: `model ${modelName} has \`${emailField}\` with no @unique or @@unique -- duplicate accounts are possible`,
            data: { model: modelName, field: emailField },
            confidenceScale: 0.7,
            severity: 'medium',
          });
        }
        return;
      }
      // Django models with a unique-looking field.
      for (const path of ctx.filter((f) => /models\.py$/.test(f))) {
        const file = filesWithExts(ctx, '.py').find((f) => f.path === path);
        if (!file) continue;
        for (let line = 1; line <= file.lineCount; line++) {
          const code = file.lineNoComments(line);
          const m = /^\s+(\w*email\w*)\s*=\s*models\.\w+Field\(/.exec(code);
          if (!m?.[1]) continue;
          if (/unique\s*=\s*True/.test(code)) continue;
          yield emit({
            path: file.path,
            line,
            snippet: code,
            evidence: `\`${m[1]}\` is not unique -- duplicate accounts are possible`,
            data: { field: m[1] },
            confidenceScale: 0.7,
            severity: 'medium',
          });
        }
      }
    },
    (ctx) => usesDatabase(ctx),
  ),
];

// ---------------------------------------------------------------------------

function await0(ctx: ScanContext, candidates: readonly string[]): SourceFile | null {
  for (const c of candidates) {
    const hit = ctx.filter((f) => f === c || f.endsWith('/' + c))[0];
    if (hit) {
      const parsed = internals.parse(ctx, hit);
      if (parsed) return parsed;
    }
  }
  return null;
}

function indentOfLine(s: string): number {
  return s.length - s.trimStart().length;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether this project talks to a database at all.
 *
 * The `pg` alternative is anchored (`\bpg\.`) on purpose. A bare `\bpg\b` matches
 * any `.pg(` or `pg.` namespace call, which turned a schema library with no
 * database anywhere into a project that had one -- and then every DB rule below
 * fired across the whole codebase. A false "this project has no database" is
 * cheap; a false "it does" makes the scanner confidently wrong at scale.
 */
/** Import-level evidence that one file actually talks to a database. */
function fileTouchesDatabase(ctx: ScanContext, file: { content: string }): boolean {
  const hasOrm = file.content.match(
    /from\s+['"](@prisma\/client|prisma|@supabase\/supabase-js|drizzle-orm|sequelize|typeorm|knex|mongoose|pg|psycopg|better-sqlite3|mysql2|sqlite3)['"]/,
  );
  if (hasOrm) return true;

  // Everything below needs the project to actually depend on an ORM, so a stray
  // `.findMany(` in a library cannot opt itself in.
  if (!hasOrmDependency(ctx)) return false;

  // A client instance held in a variable: `const db = new PrismaClient()`,
  // `pool.query(...)`, `db.$queryRaw`.
  if (/new\s+(PrismaClient|Pool|Client|Database)\s*\(/.test(file.content)) return true;
  if (/\b(prisma|db|pool|session|client|conn|connection)\s*\.\s*(query|execute|\$queryRaw|\$executeRaw|user|session|model|table|schema)\b/.test(file.content)) {
    return true;
  }
  // The ORM is installed and the file calls its distinctive methods on some
  // receiver. This is what a global or singleton client looks like --
  // `prisma.user.findUnique(...)` with no import in sight, which is how Prisma
  // projects are usually written.
  return ORM_VERBS_ALONE.test(file.content);
}

/**
 * A call that looks like a database query.
 *
 * Every verb here is also an ordinary method name, so the receiver matters:
 * `findMany`, `$queryRaw` and `aggregate` are specific enough to stand alone,
 * while `get`, `create`, `select`, `count` and `delete` only count on something
 * that is recognisably a database handle. Matching bare `.create(` reported a
 * Zod schema builder as an N+1 across eight findings in one file.
 */
const ORM_VERBS_ALONE =
  /\.\s*(findUnique|findFirst|findMany|findById|findOrCreate|upsert|\$queryRaw|\$executeRaw|aggregate|groupBy|createMany|deleteMany|updateMany)\s*\(/;
const ORM_VERBS_WITH_RECEIVER =
  /\b(prisma|db|database|client|conn|connection|pool|session|tx|sql|query|orm|repo|repository|collection|table|model|schema|ctx|em)\s*\.\s*(get|find|findOne|findById|create|insert|save|update|delete|remove|select|query|execute|count|exists|upsert|first|where|orderBy|include|limit|offset)\s*\(/;
const SQL_LITERAL = /\.\s*(query|execute|raw|unsafe)\s*\(\s*[`'"]/;

function looksLikeDbCall(line: string): boolean {
  return ORM_VERBS_ALONE.test(line) || ORM_VERBS_WITH_RECEIVER.test(line) || SQL_LITERAL.test(line);
}

/**
 * A write, for the transaction rule.
 *
 * `createMany`/`insertMany`/`deleteMany`/`upsert` are specific enough to stand
 * alone. Plain `create`, `insert`, `update`, `delete` and `save` are ordinary
 * method names on ordinary objects -- `ZodOptional.create`, a Map wrapper, a
 * repository of in-memory records -- so they only count on a database receiver.
 */
const WRITE_VERBS_ALONE =
  /\.\s*(createMany|insertMany|updateMany|deleteMany|insertOne|updateOne|replaceOne|bulkWrite|saveMany)\s*\(/;
const WRITE_VERBS_WITH_RECEIVER =
  /\b(?:prisma|db|database|client|conn|connection|pool|session|tx|sql|orm|repo|repository|collection|table|model|ctx|em|dao)\s*\.\s*(?:create|insert|update|delete|remove|save|upsert|put|add|set)\s*\(/;

/** The write verb for the evidence line, or null if this is not a write. */
function looksLikeWrite(line: string): string | null {
  if (WRITE_VERBS_ALONE.test(line)) return WRITE_VERBS_ALONE.exec(line)![1]!;
  if (WRITE_VERBS_WITH_RECEIVER.test(line)) return WRITE_VERBS_WITH_RECEIVER.exec(line)![1]!;
  return null;
}

/**
 * A list call that returns everything.
 *
 * `findMany`/`findAll`/`query` are specific to data access. `all`, `select`,
 * `list` and `search` are not -- `Object.keys().all()`, a `<select>` builder,
 * an in-memory `.search()` all match -- so those need a database receiver too.
 */
const UNBOUNDED_VERBS =
  /\.\s*(?:findMany|findAll|query)\s*\(|\b(?:prisma|db|database|client|conn|connection|pool|session|tx|sql|orm|repo|repository|collection|table|model|ctx|em)\s*\.\s*(?:all|select|list|search|find|findMany)\s*\(/;

function usesDatabase(ctx: ScanContext): boolean {
  if (ORMS.some((o) => ctx.project.dependencyNames.has(o) || ctx.project.frameworks.includes(o))) return true;
  if (ctx.project.type === 'django') return true;
  if (ctx.project.dependencyNames.has('pg') || ctx.project.dependencyNames.has('better-sqlite3')) return true;
  if (hasOrmDependency(ctx)) return true;
  // Source files only. Prose mentions databases constantly -- a docs page
  // linking to `drizzle-zod`, a README saying "DATABASE_URL", a scanner's own
  // remediation text quoted inside a saved report -- and counting any of those
  // makes a library with no database look like a service that has one. Once
  // that misfires, every database rule fires across the whole repository.
  return allFiles(ctx)
    .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|java|kt|php|cs|rs|sql|prisma)$/.test(f.path))
    .some((f) =>
      /prisma\.|@prisma\/client|\bpg\.|sequelize|typeorm|drizzle-orm|drizzle\b.*from|knex|mongoose|sqlalchemy|psycopg|sqlite3|mysql2|createPool|new Pool\(|DATABASE_URL/.test(
        f.content,
      ),
    );
}

function ormNames(ctx: ScanContext): string[] {
  const names = [...ctx.project.dependencyNames];
  return ORMS.filter(
    (o) =>
      ctx.project.frameworks.includes(o) ||
      names.some((n) => n === o || n === `@${o}/client` || n.includes(`${o}-orm`) || n === `@prisma/${o}`),
  );
}

function hasMigrations(ctx: ScanContext): boolean {
  if (ctx.filter((f) => /(^|\/)(migrations?|migrate|alembic\/versions)\//.test(f)).length > 0) return true;
  const tools = ['prisma', 'drizzle-kit', 'typeorm', 'sequelize-cli', 'knex', 'alembic', 'django', 'flyway', 'liquidbase', 'golang-migrate', 'sqlx', 'atlas', 'prisma-migrate', 'dbmate', 'mikro-orm'];
  if (tools.some((t) => ctx.project.scriptNames.has(t))) return true;
  if (['prisma', 'drizzle-kit', 'alembic', 'django', 'flyway', 'golang-migrate', 'sqlx', 'atlas'].some((t) => ctx.project.dependencyNames.has(t))) return true;
  if (ctx.filter((f) => /(^|\/)(drizzle|migrations?)\.(config\.)?(ts|js)$/.test(f)).length > 0) return true;
  return allFiles(ctx).some((f) => /\bmigrate\s+(?:dev|up|deploy|run)|prisma migrate|alembic upgrade/.test(f.content));
}

const POOL_MARKERS =
  /connection_limit|connectionLimit|pool_size|max_pool_size|maxPoolSize|pool\s*:\s*\{|new\s+Pool\s*\(|Pool\s*:\s*new|createPool|pool_size\s*=|maxConnections|pool_max|pool:\s*false|DATABASE_POOL/;

/**
 * True when the project already pools database connections.
 *
 * ORMs and managed Postgres providers pool internally by design, so the finding
 * only makes sense for a raw driver (`pg`, `mysql2`) used without a Pool, or
 * for a project that opens a client per request.
 */
function hasPooling(ctx: ScanContext): boolean {
  if (POOL_MARKERS.test(allFiles(ctx).map((f) => f.content).join('\n'))) return true;
  // Prisma, Drizzle and the managed Postgres clients pool by default.
  if (['prisma', '@prisma/client', 'drizzle-orm', '@vercel/postgres', '@neondatabase/serverless', '@supabase/supabase-js', 'postgres', 'database'].some((d) => ctx.project.dependencyNames.has(d))) {
    return true;
  }
  // SQLAlchemy and psycopg pool when an engine/session is created.
  if (['sqlalchemy', 'psycopg', 'databases', 'tortoise-orm', 'django'].some((d) => ctx.project.dependencyNames.has(d))) {
    return true;
  }
  if (ctx.project.frameworks.includes('django')) return true;
  // Serverless platforms multiplex over a proxy that pools for you.
  if (ctx.project.frameworks.includes('vercel') || ctx.project.frameworks.includes('cloudflare')) return true;
  return false;
}

function hasTransactions(ctx: ScanContext): boolean {
  return allFiles(ctx).some((f) =>
    /\$transaction|db\.transaction\(|session\.withTransaction|with\s+db\.begin|with\s+session\.begin|atomic\(|BEGIN\s*;|transaction\(\s*async|client\.transaction|pool\.connect\(\s*async/.test(f.content),
  );
}

function migrationAnchor(ctx: ScanContext): string {
  return dbClientAnchor(ctx);
}

function dbClientAnchor(ctx: ScanContext): string {
  const files = allFiles(ctx);
  const hit = files.find((f) => /(^|\/)(db|database|client|storage)\.(ts|js|py|go)$/.test(f.path));
  if (hit) return hit.path;
  const sch = ctx.filter((f) => /schema\.prisma$/.test(f))[0];
  if (sch) return sch;
  return files[0]?.path ?? 'package.json';
}
