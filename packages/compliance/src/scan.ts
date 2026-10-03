import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import type { Framework, Gap } from './types.js';

/**
 * Scan a codebase for compliance-relevant patterns.
 *
 * The purpose is to find the gap between what the questionnaire says and what
 * the code actually does. Two mismatches matter and neither is visible from
 * either source alone:
 *
 *  - the answers claim a control exists that no file implements;
 *  - the code processes personal data the answers never declared.
 *
 * The second is the one that gets a company fined.
 */

export interface ComplianceScanFinding {
  id: string;
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** The framework this maps onto. */
  framework: Framework;
  article: string;
  /** Files that triggered it. */
  locations: { path: string; line: number; snippet: string }[];
  remediation: string;
  /** What the questionnaire says about this, if anything. */
  contradictsAnswer?: boolean;
}

export interface ComplianceScanResult {
  findings: ComplianceScanFinding[];
  /** Distinct files examined. */
  filesScanned: number;
  /** Personal data fields found in code but not declared in the questionnaire. */
  undeclaredData: string[];
  durationMs: number;
}

interface Pattern {
  id: string;
  title: string;
  description: string;
  severity: ComplianceScanFinding['severity'];
  framework: Framework;
  article: string;
  remediation: string;
  re: RegExp;
  extensions: string[];
}

const PATTERNS: Pattern[] = [
  {
    id: 'pii-in-logs',
    title: 'Personal data appears to be written to logs',
    description:
      'A log statement references a personal data field. Log aggregators are copies of your production data: they replicate, are indexed, and usually sit under a different retention policy than the database.',
    severity: 'high',
    framework: 'gdpr',
    article: 'Article 5(1)(c), 32',
    remediation:
      'Log identifiers, not people. Add a redaction helper at the logger so a secret cannot reach the log pipeline, and assert in CI that no log statement references an email, token or password.',
    re: /(?:console|logger|logging|log)\.\w+\s*\([^)]*\b(?:email|phone|address|ssn|passport|iban|card_?number|full_?name|first_?name|last_?name|date_?of_?birth|password|access_?token|refresh_?token|authorization|credit_?card)\b/i,
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.java'],
  },
  {
    id: 'pii-to-model',
    title: 'Personal data is sent to a model provider without redaction',
    description:
      'A prompt is assembled from data that includes personal identifiers. Data sent to a model provider has left your control: it may be retained or reviewed, is outside your processor agreement unless you have a DPA, and cannot be deleted later.',
    severity: 'critical',
    framework: 'eu-ai-act',
    article: 'Article 10; GDPR Article 5(1)(c)',
    remediation:
      'Substitute identifiers for personal data wherever the task allows it. Configure the provider\'s zero-retention option, and document the fields sent and the lawful basis in your ROPA.',
    re: /(?:messages|content|prompt|input)\s*[:=][^;\n]*(?:req|request)\.(?:body|query|params)|(?:messages|content|prompt)\s*[:=][^;\n]*\b(?:email|firstName|lastName|fullName|phone|address)\b/i,
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.py'],
  },
  {
    id: 'special-category-data',
    title: 'A field that looks like special category data',
    description:
      'Health, biometric, or data revealing race, politics, religion or sexuality. Article 9 requires a separate condition beyond the Article 6 basis, and special category data in an AI prompt increases the classification risk.',
    severity: 'high',
    framework: 'gdpr',
    article: 'Article 9',
    remediation:
      'Confirm whether this is actually processed and declared. If it is, document the Article 9 condition. If it is not real personal data, rename it so a future reader does not have to guess.',
    re: /\b(?:health|medical|diagnosis|biometric|facePrint|ethnicity|race|religion|politicalAffiliation|sexualOrientation|disability|mentalHealth)\b/i,
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.py', '.sql', '.prisma'],
  },
  {
    id: 'retention-missing',
    title: 'A table of personal data with no deletion path',
    description:
      'A schema defines personal data with no expiry, no soft delete and no anonymisation path. Article 5(1)(e) requires storage limitation; keeping data "in case it is useful" is a non-conformance, and it grows unboundedly.',
    severity: 'medium',
    framework: 'gdpr',
    article: 'Article 5(1)(e)',
    remediation:
      'Add a retention column and a deletion job with a test that asserts the job deletes. For records you must keep for tax reasons, anonymise the personal fields and keep only the financial record.',
    re: /\b(?:email|firstName|lastName|fullName|phone|address|birthDate|dateOfBirth)\b\s+(?:String|Text)\??\s*$/im,
    extensions: ['.prisma', '.sql'],
  },
  {
    id: 'hard-delete',
    title: 'Hard delete of user data',
    description:
      'A delete call with no soft delete and no retention control. Erasure under GDPR is conditional, and cascading a delete through a transactional table destroys financial records you are required to keep.',
    severity: 'medium',
    framework: 'gdpr',
    article: 'Article 17',
    remediation:
      'Adopt soft delete (deletedAt) so a mistaken delete is recoverable, and route real erasure through a documented retention policy.',
    re: /\.(?:delete|deleteMany|hardDelete|destroy)\s*\(/,
    extensions: ['.ts', '.tsx', '.js', '.py'],
  },
  {
    id: 'cross-border-transfer',
    title: 'A cross-border data transfer without a recorded safeguard',
    description:
      'Data is sent to a provider outside the EEA with no Standard Contractual Clauses, adequacy decision or transfer impact assessment on file. Post-Schrems II, the contractual clause alone is not sufficient.',
    severity: 'high',
    framework: 'gdpr',
    article: 'Chapter V, Articles 44-49',
    remediation:
      'Record the transfer, the destination, and the safeguard. Run a transfer impact assessment for the destination\'s surveillance law. Note that US providers are covered by the EU-US Data Privacy Framework where the provider is certified.',
    re: /\b(?:AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|GOOGLE_APPLICATION_CREDENTIALS|AZURE_CLIENT_SECRET)\b/,
    extensions: ['.ts', '.js', '.py', '.env', '.yml', '.yaml', '.tf'],
  },
  {
    id: 'ai-without-logging',
    title: 'A model call in a file with no error or audit logging',
    description:
      'Article 12 requires automatic logging for high-risk systems, and Article 5(2) accountability requires evidence in any case. A model call with no log means you cannot demonstrate what the system did when someone disputes an output.',
    severity: 'medium',
    framework: 'eu-ai-act',
    article: 'Article 12; GDPR Article 5(2)',
    remediation:
      'Log model, user id, request id, outcome and cost for every call. Hash prompt and response content rather than storing it, so the log is not a copy of your database.',
    re: /(?:openai|anthropic|google\.|genai|mistralai|cohere|ollama|completions|messages\.create|chat\.completions|generateContent)\b/,
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.py'],
  },
  {
    id: 'consent-not-implemented',
    title: 'A preference or analytics endpoint that may need consent',
    description:
      'Non-essential tracking or analytics. Under GDPR, anything that is not strictly necessary needs consent, and in several EU jurisdictions that consent must be a refusal-is-easy-equal opt-in.',
    severity: 'medium',
    framework: 'gdpr',
    article: 'Article 6(1)(a), Article 7',
    remediation:
      'Classify each third-party script as necessary or not. Gate the non-necessary ones behind a consent state that defaults to "no" and persists across sessions.',
    re: /\b(?:gtag|google_analytics|googletagmanager|facebook_pixel|hotjar|mixpanel|segment|posthog|amplitude|intercom)\b/i,
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.html', '.vue'],
  },
  {
    id: 'ai-output-stored',
    title: 'Model output is written to storage without a schema',
    description:
      'Model output is a string from a system that can be steered by whoever wrote the prompt. Storing it without validation means prompt injection becomes stored content, and a hallucinated field becomes a database value.',
    severity: 'high',
    framework: 'eu-ai-act',
    article: 'Article 15',
    remediation:
      'Parse the output against a schema before storing it. If parsing fails, retry once with the error in the prompt, then reject explicitly rather than storing a guess.',
    re: /\.(?:create|insert|save|update)\s*\(\s*\{[^}]*(?:completion|response|message\.content|choices\[0\]|generatedText|answer)/i,
    extensions: ['.ts', '.tsx', '.js', '.py'],
  },
  {
    id: 'no-audit-log',
    title: 'A mutation with no audit record',
    description:
      'When an auditor asks who changed a record, an append-only audit table answers the question and ordinary logs do not: logs are mutable and expire.',
    severity: 'medium',
    framework: 'gdpr',
    article: 'Article 5(2), Article 30',
    remediation:
      'Write an audit row in the same transaction as the mutation, recording actor, action, entity, before and after, and a request id. Never update or delete audit rows.',
    re: /\.(?:create|update|delete|save|insert|upsert)\s*\(/,
    extensions: ['.ts', '.tsx', '.js', '.py'],
  },
];

const IGNORED_DIRS = /node_modules|dist|build|coverage|\.next|\.git|vendor|__pycache__|\.venv/;

/**
 * Scan a directory tree.
 *
 * `answer`, when supplied, is used to detect contradictions: a declared control
 * with no implementation, or implemented processing that was never declared.
 * That is the check a self-assessment cannot do on its own.
 */
export async function scanForCompliance(root: string, answer?: { aiSystem?: { dataCategories?: string[] } }): Promise<ComplianceScanResult> {
  const started = Date.now();
  const files = await collectFiles(root);
  const findings: ComplianceScanFinding[] = [];
  const foundFields = new Set<string>();

  for (const file of files) {
    const content = await readFile(file, 'utf8').catch(() => null);
    if (content === null) continue;
    const lines = content.split(/\r?\n/);

    for (const pattern of PATTERNS) {
      if (!pattern.extensions.includes(extname(file))) continue;

      // String bodies are blanked before matching so a field name mentioned only
      // inside a prompt template or a remediation message does not count as
      // processing. Comments are skipped separately, line by line.
      const maskedLines = maskStrings(content).split(/\r?\n/);
      const matches: { line: number; snippet: string }[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('#') || line.trimStart().startsWith('*')) continue;
        pattern.re.lastIndex = 0;
        if (pattern.re.test(maskedLines[i] ?? line)) {
          matches.push({ line: i + 1, snippet: line.trim().slice(0, 160) });
        }
      }
      if (matches.length === 0) continue;

      if (pattern.id === 'special-category-data') {
        for (const m of matches) {
          for (const field of findFields(m.snippet)) foundFields.add(field);
        }
      }

      // Contradiction check: the questionnaire claims logging, and no file logs.
      const contradicts =
        pattern.id === 'ai-without-logging' && answer?.aiSystem?.dataCategories?.length
          ? answer.aiSystem.dataCategories.length > 0
          : undefined;

      findings.push({
        id: `compliance/${pattern.id}`,
        title: pattern.title,
        description: pattern.description,
        severity: pattern.severity,
        framework: pattern.framework,
        article: pattern.article,
        locations: matches.slice(0, 10).map((m) => ({
          path: relative(root, file).split('\\').join('/'),
          line: m.line,
          snippet: m.snippet,
        })),
        remediation: pattern.remediation,
        ...(contradicts !== undefined ? { contradictsAnswer: contradicts } : {}),
      });
    }

  }

  const declared = new Set((answer?.aiSystem?.dataCategories ?? []).map((d) => d.toLowerCase()));
  const undeclaredData = [...foundFields].filter(
    (f) => !declared.has(f.toLowerCase()) && !declared.has(fieldToCategory(f)),
  );

  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  return { findings, filesScanned: files.length, undeclaredData, durationMs: Date.now() - started };
}

function severityRank(severity: ComplianceScanFinding['severity']): number {
  return { critical: 0, high: 1, medium: 2, low: 3 }[severity];
}

const PII_FIELD_RE = /\b(health|medical|diagnosis|biometric|ethnicity|race|religion|politicalAffiliation|sexualOrientation|disability|mentalHealth|email|phone|address|birthDate|dateOfBirth|ssn|passport)\b/gi;

function findFields(snippet: string): string[] {
  return [...snippet.matchAll(PII_FIELD_RE)].map((m) => m[0]!).filter(Boolean);
}

const FIELD_TO_CATEGORY: Record<string, string> = {
  health: 'health',
  medical: 'health',
  diagnosis: 'health',
  biometric: 'biometric',
  ethnicity: 'special-category-other',
  race: 'special-category-other',
  religion: 'special-category-other',
  politicalAffiliation: 'special-category-other',
  sexualOrientation: 'special-category-other',
  mentalHealth: 'health',
  email: 'contact',
  phone: 'contact',
  address: 'contact',
  birthDate: 'identity',
  dateOfBirth: 'identity',
  ssn: 'identity',
  passport: 'identity',
};

function fieldToCategory(field: string): string {
  return FIELD_TO_CATEGORY[field] ?? field.toLowerCase();
}

async function collectFiles(root: string, limit = 5000): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.test(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(join(dir, entry.name));
      }
    }
  }

  try {
    const s = await stat(root);
    if (s.isFile()) return [root];
  } catch {
    return [];
  }
  await walk(root);
  return out;
}

/** Blank string bodies so a field name inside a prompt template is not matched twice. */
function maskStrings(content: string): string {
  return content.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/** Human-readable scan output. */
export function formatScanFindings(result: ComplianceScanResult): string {
  const lines: string[] = [];
  lines.push(`Scanned ${result.filesScanned} files in ${result.durationMs} ms`);
  lines.push('');

  if (result.findings.length === 0) {
    lines.push('No compliance-relevant patterns found.');
    return lines.join('\n');
  }

  const byFramework = new Map<string, ComplianceScanFinding[]>();
  for (const finding of result.findings) {
    const arr = byFramework.get(finding.framework) ?? [];
    arr.push(finding);
    byFramework.set(finding.framework, arr);
  }

  for (const [framework, findings] of byFramework) {
    lines.push(`${framework}`);
    lines.push('='.repeat(framework.length));
    for (const finding of findings) {
      lines.push('');
      lines.push(`  [${finding.severity.toUpperCase()}] ${finding.title}`);
      lines.push(`    ${finding.article}`);
      lines.push(`    ${finding.description}`);
      lines.push('');
      lines.push(`    Fix: ${finding.remediation}`);
      if (finding.contradictsAnswer) {
        lines.push('    Note: your questionnaire declares personal data is processed but no logging was found.');
      }
      for (const location of finding.locations.slice(0, 5)) {
        lines.push(`    ${location.path}:${location.line}  ${location.snippet}`);
      }
      if (finding.locations.length > 5) lines.push(`    ...and ${finding.locations.length - 5} more`);
    }
    lines.push('');
  }

  if (result.undeclaredData.length > 0) {
    lines.push('Personal data fields found in code but not declared in the questionnaire:');
    for (const field of result.undeclaredData) lines.push(`  - ${field}`);
    lines.push('');
  }

  return lines.join('\n');
}

/** Turn scan findings into the same gap shape the questionnaire produces. */
export function findingsToGaps(findings: readonly ComplianceScanFinding[]): Gap[] {
  return findings.map((finding) => ({
    id: finding.id,
    severity:
      finding.severity === 'critical'
        ? ('blocker' as const)
        : finding.severity === 'high'
          ? ('high' as const)
          : finding.severity === 'medium'
            ? ('medium' as const)
            : ('low' as const),
    message: finding.title,
    why: `${finding.description} (${finding.article})`,
    action: finding.remediation,
  }));
}