import { internals } from '../../context.js';
import { defineRule, type Rule } from '../../rules/scanner-helper.js';
import { COMPLIANCE } from '../../rules/rule.js';
import { allFiles, anchorPath, filesWithExts } from './helpers.js';
import type { ScanContext } from '../../types.js';

/**
 * Credential patterns.
 *
 * Deliberately conservative: the point is a high-precision list, because a
 * false positive here trains people to add `shipready-disable` to everything.
 * We require the key name to look like a credential *and* the value to look
 * like a real key rather than a placeholder.
 */
const SECRET_PATTERNS: { name: string; re: RegExp; rotate: string }[] = [
  { name: 'AWS access key id', re: /\b(AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, rotate: 'revoke the key in IAM immediately, then issue a new one' },
  { name: 'AWS secret access key', re: /\baws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}\b/gi, rotate: 'revoke and rotate in IAM' },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/g, rotate: 'restrict and rotate in Google Cloud Console' },
  { name: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, rotate: 'revoke in Slack app settings' },
  { name: 'Stripe secret key', re: /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/g, rotate: 'roll the key in Stripe dashboard' },
  { name: 'OpenAI key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g, rotate: 'revoke at platform.openai.com' },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g, rotate: 'revoke in the Anthropic console' },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, rotate: 'revoke in GitHub settings' },
  { name: 'Supabase service key', re: /\bsupabase.*(?:service_role|SUPABASE_SERVICE_ROLE_KEY)\s*[:=]\s*["']?eyJ[A-Za-z0-9._-]{40,}/gi, rotate: 'rotate in the Supabase dashboard' },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, rotate: 'remove from history and rotate the keypair' },
  { name: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, rotate: 'invalidate the session' },
  { name: 'SendGrid key', re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, rotate: 'revoke in SendGrid' },
  { name: 'NPM token', re: /\bnpm_[A-Za-z0-9]{36}\b/g, rotate: 'revoke on npmjs.com' },
  { name: 'Twilio key', re: /\bSK[0-9a-fA-F]{32}\b/g, rotate: 'rotate in the Twilio console' },
  { name: 'Database URL with password', re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^:@\s"']+:[^@\s"']+@/gi, rotate: 'change the database password' },
];

const PLACEHOLDER = /(your[_-]?|example|sample|dummy|placeholder|xxx+|<[^>]+>|\.\.\.|changeme|insert[_-]?|todo|fake|test[_-]?key|abc123|0000|redacted|notreal|not[_-]?real)/i;

/**
 * File types worth scanning for credentials.
 *
 * Anything text-shaped. The list exists to skip binary and lock files, not to
 * pick a language -- a key in `docker-compose.yml` or `deploy.sh` is leaked in
 * exactly the same way as one in `config.ts`.
 */
const SECRET_SCAN_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rb',
  '.php',
  '.java',
  '.cs',
  '.kt',
  '.swift',
  '.rs',
  '.env',
  '.yml',
  '.yaml',
  '.toml',
  '.json',
  '.sh',
  '.bash',
  '.zsh',
  '.conf',
  '.ini',
  '.properties',
  '.tf',
  '.tfvars',
  '.xml',
  '.sql',
  '.txt',
  '.md',
  '.gradle',
  '.dockerfile',
  'Dockerfile',
  '.env.example',
  '.env.sample',
  '.env.local',
  '.env.production',
  '.npmrc',
  '.pypirc',
];

/**
 * Files whose entire purpose is to document credential *names*.
 *
 * A `.env.example` containing `DATABASE_URL="postgresql://user:pass@host/db"`
 * is the correct thing to commit. Matching both a leading slash and a
 * directory-less path matters: the root-level `.env.example` is the common case.
 */
const PLACEHOLDER_FILES = /(?:^|\/)\.env\.(?:example|sample|template|dist|defaults)$/i;

export const deploymentRules: Rule[] = [
  defineRule(
    {
      id: 'readiness/deployment/hardcoded-secrets',
      name: 'Credential hardcoded in the repository',
      category: 'deployment',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.9,
      effortMinutes: 30,
      fixable: false,
      description:
        'A live-looking credential is committed to the repository. Anyone with read access, every CI log that echoed it, and every fork has it. Removing it from the working tree does not remove it from history: assume it is already leaked and rotate first, then clean up.',
      remediation:
        '1. Revoke and rotate the credential now. 2. Move it to an environment variable, loaded from your secret manager. 3. Add a `.env.example` documenting the name without the value. 4. Purge it from git history with `git filter-repo` or BFG. 5. Turn on secret scanning so it cannot happen again.',
      compliance: [COMPLIANCE.owaspA02, COMPLIANCE.owaspA07, COMPLIANCE.gdprArticle32, COMPLIANCE.iso27001A8, COMPLIANCE.soc2CC6],
      cwe: 'CWE-798',
      owasp: 'A02:2021',
      tags: ['secrets', 'launch-blocker', 'immediate'],
      references: ['https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning'],
    },
    function* (ctx, emit) {
      // The include list is deliberately broad: a leaked key in a YAML config
      // or a shell script is just as leaked as one in a source file.
      for (const file of internals.parseAll(ctx, (f) => SECRET_SCAN_EXTENSIONS.some((ext) => f.path.endsWith(ext)))) {
        if (/(^|\/)(node_modules|vendor)\//.test(file.path)) continue;
        for (const { name, re, rotate } of SECRET_PATTERNS) {
          for (const hit of file.matchNoComments(re)) {
            if (PLACEHOLDER.test(hit.match)) continue;
            if (file.hasExplanatoryCommentNear(hit.line, ['example', 'sample', 'placeholder', 'rotate', 'revoked', 'fake', 'test only'])) continue;
            if (PLACEHOLDER_FILES.test(file.path)) continue;
            yield emit({
              path: file.path,
              line: hit.line,
              snippet: redactSnippet(hit.text),
              evidence: `${name} committed to the repository. ${redactSnippet(hit.text)}`,
              data: { credentialType: name, rotation: rotate },
              tags: ['secrets', 'launch-blocker', 'immediate'],
            });
          }
        }
      }
    },
  ),

  defineRule(
    {
      id: 'readiness/deployment/no-dockerfile',
      name: 'No Dockerfile',
      category: 'deployment',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.7,
      effortMinutes: 60,
      fixable: true,
      description:
        'No container definition. The environment your app is tested in and the environment it runs in are not the same, and "works on my machine" gets a production incident every quarter.',
      remediation:
        'Add a multi-stage Dockerfile: build in one stage, copy only production dependencies and build output into a slim runtime stage. Run as a non-root user, set `NODE_ENV=production`, and add a `.dockerignore` so you do not ship `.git` and `.env`.',
      compliance: [COMPLIANCE.iso27001A8, COMPLIANCE.owaspA05],
      tags: ['docker', 'reproducibility'],
      references: ['https://docs.docker.com/develop/develop-images/dockerfile_best-practices/'],
    },
    function* (ctx, emit) {
      if (ctx.project.hasDocker) return;
      if (isServerlessOrPaaS(ctx)) return;
      yield emit({
        path: anchorPath(ctx, ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']),
        evidence: 'no Dockerfile, docker-compose.yml, or container manifest found',
      });
    },
  ),

  defineRule(
    {
      id: 'readiness/deployment/no-env-example',
      name: 'No .env.example',
      category: 'deployment',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.85,
      effortMinutes: 15,
      fixable: true,
      description:
        'The project reads environment variables but ships no `.env.example`. New developers and new CI runners guess variable names, get silent `undefined` at runtime, and the first person to deploy to a new environment discovers which variables are actually required.',
      remediation:
        'Add `.env.example` listing every variable the code reads, with placeholder values and a comment per line. Commit it. Add `.env` to `.gitignore` and keep them in sync in CI with a check.',
      compliance: [COMPLIANCE.iso27001A8, COMPLIANCE.owaspA05],
      tags: ['configuration', 'onboarding'],
      references: ['https://github.com/motdotla/dotenv'],
    },
    function* (ctx, emit) {
      if (ctx.project.hasEnvExample) return;
      const used = environmentVariablesUsed(ctx);
      if (used.length < 2) return;
      yield emit({
        path: anchorPath(ctx, ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']),
        evidence: `${used.length} environment variable(s) read by the code with no .env.example documenting them`,
        data: { variables: used.slice(0, 25) },
      });
    },
  ),

  defineRule(
    {
      id: 'readiness/deployment/no-ci',
      name: 'No CI pipeline',
      category: 'deployment',
      severity: 'high',
      impact: 'degradation',
      confidence: 0.9,
      effortMinutes: 90,
      fixable: true,
      description:
        'No continuous integration configuration. Nothing runs the tests, nothing builds the project, and nothing blocks a broken commit from reaching main. For an AI-built codebase this is how a hallucinated API call gets deployed on a Friday.',
      remediation:
        'Add a GitHub Actions workflow that installs, lints, typechecks, tests and builds on every push and pull request. Run `shipready scan` and fail below your threshold so a readiness regression is caught in review rather than in production.',
      compliance: [COMPLIANCE.iso27001A8, COMPLIANCE.soc2CC7, COMPLIANCE.owaspA09],
      tags: ['ci', 'quality-gate'],
      references: ['https://docs.github.com/en/actions'],
    },
    function* (ctx, emit) {
      if (ctx.project.hasCi) return;
      yield emit({
        path: anchorPath(ctx, ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']),
        evidence: 'no GitHub Actions, GitLab CI, CircleCI, Jenkins, Buildkite or other CI configuration found',
      });
    },
  ),

  defineRule(
    {
      id: 'readiness/deployment/no-lockfile',
      name: 'No dependency lockfile',
      category: 'deployment',
      severity: 'high',
      impact: 'degradation',
      confidence: 0.9,
      effortMinutes: 15,
      fixable: true,
      description:
        'No lockfile. Your build resolves semver ranges at install time, so two deploys from the same commit can ship different dependency versions. The classic symptom is "it broke and we did not change anything".',
      remediation:
        'Commit the lockfile (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lockb`, `poetry.lock`, `go.sum`, `Cargo.lock`) and install with `--frozen-lockfile` in CI. Add `npm ci` equivalent semantics to your pipeline.',
      compliance: [COMPLIANCE.iso27001A8],
      tags: ['reproducibility', 'supply-chain'],
      references: [],
    },
    function* (ctx, emit) {
      const has = ctx.files().some((f) =>
        /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/.test(f),
      );
      if (has) return;
      const manifests = ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'Gemfile'];
      if (!manifests.some((m) => ctx.files().includes(m))) return;
      yield emit({
        path: anchorPath(ctx, manifests),
        evidence: 'dependency manifest present with no lockfile -- builds are not reproducible',
      });
    },
  ),

  defineRule(
    {
      id: 'readiness/deployment/no-staging-environment',
      name: 'No separate staging environment configuration',
      category: 'deployment',
      severity: 'low',
      impact: 'cosmetic',
      confidence: 0.6,
      effortMinutes: 90,
      fixable: false,
      description:
        'No staging environment is defined. The consequence is that production is the environment where you discover problems, which means either risky deploys or a production incident every time something changes.',
      remediation:
        'Add a staging deployment: same stack, separate data, seeded with anonymised production-like data. Deploy to staging on merge to main and gate production on a smoke test. This is cheap on Vercel/Railway/Fly and the highest-leverage non-code change you can make.',
      compliance: [COMPLIANCE.iso27001A8, COMPLIANCE.euAiActArticle72],
      tags: ['environments', 'release-safety'],
      references: [],
    },
    function* (ctx, emit) {
      const text = allFiles(ctx).map((f) => f.content).join('\n');
      if (/\bstaging\b/i.test(text)) return;
      if (/\bpreview\b|\bPR_\b|\bbranch\b.*deploy/i.test(text)) return;
      yield emit({
        path: anchorPath(ctx, ['package.json', '.github/workflows/deploy.yml']),
        evidence: 'no staging, preview or per-branch environment configuration found',
        severity: 'low',
        impact: 'cosmetic',
        effortMinutes: 90,
      });
    },
  ),

  defineRule(
    {
      id: 'readiness/deployment/dependencies-not-pinned',
      name: 'Dependencies use floating version ranges',
      category: 'deployment',
      severity: 'low',
      impact: 'cosmetic',
      confidence: 0.8,
      effortMinutes: 20,
      fixable: true,
      description:
        'Production dependencies are declared with `^` or `~` ranges. Combined with a missing lockfile this means nobody can say what is installed on the server.',
      remediation:
        'Pin production dependencies to exact versions and use ranges only for dev tooling. If you rely on automatic security updates, automate them with Dependabot or Renovate and let it open the upgrade PR.',
      compliance: [COMPLIANCE.iso27001A8],
      tags: ['supply-chain', 'reproducibility'],
      references: [],
    },
    function* (ctx, emit) {
      const pkgPath = ctx.files().find((f) => f === 'package.json');
      if (!pkgPath) return;
      const file = filesWithExts(ctx, '.json').find((f) => f.path === pkgPath);
      if (!file) return;
      let parsed: { dependencies?: Record<string, string> } | null = null;
      try {
        parsed = JSON.parse(file.content);
      } catch {
        return;
      }
      const deps = Object.entries(parsed?.dependencies ?? {});
      if (deps.length === 0) return;
      const floating = deps.filter(([, v]) => /^[\^~><*]|\s-\s|^\*$/.test(v as string));
      if (floating.length < Math.max(1, deps.length * 0.5)) return;
      yield emit({
        path: file.path,
        line: 1,
        evidence: `${floating.length} of ${deps.length} production dependencies use floating ranges`,
        data: { floating: floating.slice(0, 15).map(([k]) => k) },
        severity: 'low',
        impact: 'cosmetic',
        effortMinutes: 20,
      });
    },
  ),

  defineRule(
    {
      id: 'readiness/deployment/no-healthcheck-in-container',
      name: 'Container has no HEALTHCHECK instruction',
      category: 'deployment',
      severity: 'low',
      impact: 'cosmetic',
      confidence: 0.8,
      effortMinutes: 10,
      fixable: true,
      description:
        'The Dockerfile defines no `HEALTHCHECK`. If you run containers on a platform that does not add its own probe, a hung process keeps receiving traffic.',
      remediation: 'Add `HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1` to the runtime stage of your Dockerfile.',
      compliance: [COMPLIANCE.owaspA09],
      tags: ['docker', 'reliability'],
      references: ['https://docs.docker.com/reference/dockerfile/#healthcheck'],
    },
    function* (ctx, emit) {
      for (const path of ctx.files().filter((f) => /(^|\/)Dockerfile[^/]*$/i.test(f))) {
        const content = internals.parse(ctx, path)?.content;
        if (content === undefined || content === '') continue;
        if (/^\s*HEALTHCHECK\b/im.test(content)) continue;
        yield emit({
          path,
          line: 1,
          evidence: 'Dockerfile has no HEALTHCHECK instruction',
          severity: 'low',
          impact: 'cosmetic',
          effortMinutes: 10,
        });
      }
    },
  ),

  defineRule(
    {
      id: 'readiness/deployment/no-rollback-plan',
      name: 'No rollback procedure documented',
      category: 'deployment',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.6,
      effortMinutes: 45,
      fixable: true,
      description:
        'Nothing documents how to roll back. Migrations are the trap: rolling back the app but not the schema leaves you broken, and the runbook you write during the incident is the one nobody has read.',
      remediation:
        'Document the rollback command in the README and make migrations backwards compatible for one release (add columns, do not drop or rename; deploy code that tolerates both shapes; drop later). Practise a rollback once before you need it.',
      compliance: [COMPLIANCE.iso27001A8, COMPLIANCE.euAiActArticle72],
      tags: ['runbook', 'reliability'],
      references: [],
    },
    function* (ctx, emit) {
      const readme = ctx.files().find((f) => /^readme(\.md|\.rst)?$/i.test(f));
      const readmeText = readme ? (internals.parse(ctx, readme)?.content ?? '') : allFiles(ctx).map((f) => f.content).join('\n');
      if (/rollback|roll back|revert/i.test(readmeText) && /deploy|release|migration/i.test(readmeText)) return;
      yield emit({
        path: readme ?? anchorPath(ctx),
        evidence: 'no documented rollback procedure for deploys or migrations',
        severity: 'medium',
        impact: 'degradation',
        effortMinutes: 45,
      });
    },
  ),
];

// ---------------------------------------------------------------------------

function redactSnippet(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= 24) return `${trimmed.slice(0, 8)}…(redacted)`;
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)} (redacted)`;
}

function environmentVariablesUsed(ctx: ScanContext): string[] {
  const found = new Set<string>();
  for (const f of allFiles(ctx)) {
    if (/\.(md|lock|svg|png|ico)$/.test(f.path)) continue;
    for (const m of f.noCommentsOrStrings.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]+)/g)) {
      if (m[1]) found.add(m[1]);
    }
    for (const m of f.content.matchAll(/os\.environ(?:\.get)?[\[(["']+([A-Z][A-Z0-9_]+)/g)) {
      if (m[1]) found.add(m[1]);
    }
    for (const m of f.content.matchAll(/\bos\.Getenv\(\s*"([A-Z][A-Z0-9_]+)"\s*\)/g)) {
      if (m[1]) found.add(m[1]);
    }
    for (const m of f.content.matchAll(/\bimport\.meta\.env\.([A-Z][A-Z0-9_]+)/g)) {
      if (m[1]) found.add(m[1]);
    }
  }
  return [...found].sort();
}

function isServerlessOrPaaS(ctx: ScanContext): boolean {
  return (
    ctx.project.frameworks.includes('vercel') ||
    ctx.project.dependencyNames.has('@vercel/node') ||
    ctx.project.dependencyNames.has('@netlify/functions') ||
    ctx.project.dependencyNames.has('serverless-http') ||
    ctx.project.frameworks.includes('lambda') ||
    ctx.files().some((f) => /^(vercel\.json|netlify\.toml|serverless\.ya?ml|template\.ya?ml|fly\.toml|app\.yaml|Procfile)$/.test(f))
  );
}
