import { defineRule, type Rule } from '../../rules/scanner-helper.js';
import { COMPLIANCE } from '../../rules/rule.js';
import { allFiles, filesWithExts } from './helpers.js';
import type { ScanContext } from '../../types.js';

/**
 * Coverage thresholds.
 *
 * 20% is the floor, not the goal. The number exists so the engine can say
 * "below 20%" rather than making a judgement call; the finding text is what
 * convinces people, so it names the layers that matter instead.
 */
const MIN_COVERAGE = 20;
const MIN_TEST_RATIO = 0.3;

export const testingRules: Rule[] = [
  defineRule(
    {
      id: 'readiness/testing/no-tests',
      name: 'Project has no tests',
      category: 'testing',
      severity: 'high',
      impact: 'blocker',
      confidence: 0.95,
      effortMinutes: 240,
      fixable: false,
      description:
        'No test files and no test framework. Every change is a manual experiment, every bug fix risks reintroduction, and no refactor is safe. For AI-built code this is the norm: the model wrote working code, and nothing verifies it still works.',
      remediation:
        'Start with the three paths that would hurt most if they broke: signup, payment, and the primary action of your product. Write one integration test for each using the real database in a transaction. Do not chase a coverage percentage; chase the paths you would be paged for.',
      compliance: [COMPLIANCE.iso27001A8, COMPLIANCE.euAiActArticle17, COMPLIANCE.soc2CC7],
      tags: ['quality-gate', 'launch-blocker', 'ci'],
      references: ['https://playwright.dev/docs/intro'],
    },
    function* (ctx, emit) {
      if (ctx.project.hasTests) return;
      if (ctx.project.totalLines < 20) return;
      yield emit({
        path: 'package.json',
        line: 1,
        evidence: `${ctx.project.totalLines.toLocaleString()} lines of code with no test files and no test runner configured`,
        data: { totalLines: ctx.project.totalLines },
        effortMinutes: 240,
      });
    },
  ),

  defineRule(
    {
      id: 'readiness/testing/low-coverage',
      name: 'Test coverage below the minimum',
      category: 'testing',
      severity: 'high',
      impact: 'degradation',
      confidence: 0.75,
      effortMinutes: 180,
      fixable: false,
      description:
        'Tests exist but cover less than the configured minimum. Low coverage is a proxy, not a goal -- the useful signal is whether the risky paths are covered. Below 20% almost nothing is.',
      remediation:
        'Raise the floor gradually: set `--coverage-threshold` to your current number so it cannot drop, then increase it by 5 points per sprint. Prioritise business logic and API handlers over UI snapshot tests, which give the highest coverage number and the least confidence.',
      compliance: [COMPLIANCE.iso27001A8],
      tags: ['coverage'],
      references: ['https://vitest.dev/guide/coverage'],
    },
    function* (ctx, emit) {
      const cov = readCoverage(ctx);
      if (!cov) return;
      if (cov.percent >= MIN_COVERAGE) return;
      yield emit({
        path: cov.file,
        line: 1,
        evidence: `test coverage is ${cov.percent}% (minimum is ${MIN_COVERAGE}%) across ${cov.totalTests} test(s)`,
        data: { coverage: cov.percent, tests: cov.totalTests },
        severity: cov.percent < 10 ? 'high' : 'medium',
        effortMinutes: cov.percent < 10 ? 240 : 120,
      });
    },
    (ctx) => ctx.project.hasTests,
  ),

  defineRule(
    {
      id: 'readiness/testing/test-to-code-ratio',
      name: 'Test code is a small fraction of the codebase',
      category: 'testing',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.65,
      effortMinutes: 120,
      fixable: false,
      description:
        'The ratio of test lines to source lines is very low. You have some tests, which is enough to look healthy on a badge, but not enough to catch a regression before a customer does.',
      remediation:
        'Aim for roughly one test line per three source lines as a working target. If you are far below it, add a smoke suite covering every route and every external integration before writing more unit tests.',
      compliance: [COMPLIANCE.iso27001A8],
      tags: ['coverage'],
      references: [],
    },
    function* (ctx, emit) {
      if (!ctx.project.hasTests) return;
      if (ctx.project.totalLines < 200) return;
      let testLines = 0;
      let sourceLines = 0;
      for (const [lang, n] of Object.entries(ctx.project.linesByLanguage)) {
        if (lang === 'unknown') continue;
        void n;
      }
      for (const file of allFiles(ctx)) {
        if (isTestFile(file.path)) testLines += file.lineCount;
        else if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|cs)$/.test(file.path)) sourceLines += file.lineCount;
      }
      if (sourceLines === 0) return;
      const ratio = testLines / sourceLines;
      if (ratio >= MIN_TEST_RATIO) return;
      yield emit({
        path: 'package.json',
        line: 1,
        evidence: `${testLines.toLocaleString()} test lines against ${sourceLines.toLocaleString()} source lines (${(ratio * 100).toFixed(1)}%, target ${(MIN_TEST_RATIO * 100).toFixed(0)}%)`,
        data: { testLines, sourceLines, ratio: Math.round(ratio * 1000) / 1000 },
        effortMinutes: 120,
      });
    },
    (ctx) => ctx.project.hasTests,
  ),

  defineRule(
    {
      id: 'readiness/testing/no-e2e-tests',
      name: 'No end-to-end or integration tests',
      category: 'testing',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.7,
      effortMinutes: 180,
      fixable: true,
      description:
        'Only unit tests (or no tests). Unit tests pass while the deployed application is broken: the wiring is wrong, the migration did not run, the environment variable is missing. End-to-end tests are what catch that class of failure.',
      remediation:
        'Add Playwright (browser) or an API-level integration suite that runs against a real server with a real database. Three flows are enough to start: create account, complete the core action, and a payment if you take money. Run them in CI on every pull request.',
      compliance: [COMPLIANCE.iso27001A8, COMPLIANCE.soc2CC7],
      tags: ['e2e', 'integration'],
      references: ['https://playwright.dev/docs/intro'],
    },
    function* (ctx, emit) {
      if (!ctx.project.hasTests) return;
      const e2eDeps = ['playwright', '@playwright/test', 'cypress', 'puppeteer', 'testcafe', 'selenium-webdriver', 'detox'];
      const hasE2e = e2eDeps.some((d) => ctx.project.dependencyNames.has(d));
      const hasE2eFiles = ctx.files().some(
        (f) => /(^|\/)(e2e|tests\/e2e|cypress\/integration|playwright|acceptance)\//.test(f),
      );
      if (hasE2e || hasE2eFiles) return;
      yield emit({
        path: 'package.json',
        line: 1,
        evidence: 'tests exist but no end-to-end framework (Playwright, Cypress) or e2e test directory found',
        severity: ctx.project.apiRoutes.length > 3 ? 'medium' : 'low',
        effortMinutes: 180,
      });
    },
    (ctx) => ctx.project.hasTests,
  ),

  defineRule(
    {
      id: 'readiness/testing/no-tests-in-ci',
      name: 'CI does not run the tests',
      category: 'testing',
      severity: 'critical',
      impact: 'blocker',
      confidence: 0.85,
      effortMinutes: 30,
      fixable: true,
      description:
        'A CI pipeline exists but never runs the test suite. Tests that are not enforced drift within two weeks: they start failing, someone reruns them locally, and eventually someone skips them.',
      remediation:
        'Add a test step to the CI workflow and make it required on pull requests. Set a branch protection rule so a failing check blocks merge. Pin the Node or Python version so CI matches production.',
      compliance: [COMPLIANCE.iso27001A8, COMPLIANCE.soc2CC7],
      tags: ['ci', 'quality-gate', 'launch-blocker'],
      references: [],
    },
    function* (ctx, emit) {
      if (!ctx.project.hasCi) return;
      const workflows = ctx.files().filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f) || /^\.gitlab-ci\.ya?ml$/.test(f) || /^\.circleci\//.test(f));
      if (workflows.length === 0) return;
      const runsTests = workflows.some((path) => {
        const file = filesWithExts(ctx, path.slice(path.lastIndexOf('.'))).find((f) => f.path === path);
        return file ? /\b(test|vitest|jest|pytest|go test|cargo test|phpunit|npm run test|pnpm test|make test)\b/i.test(file.content) : false;
      });
      if (runsTests) return;
      yield emit({
        path: workflows[0]!,
        line: 1,
        evidence: `${workflows.length} CI workflow file(s) found, none of which run the test suite`,
        tags: ['ci', 'quality-gate', 'launch-blocker'],
      });
    },
    (ctx) => ctx.project.hasCi,
  ),

  defineRule(
    {
      id: 'readiness/testing/flaky-test-hygiene',
      name: 'Tests skip or conditionally bail out',
      category: 'testing',
      severity: 'medium',
      impact: 'degradation',
      confidence: 0.6,
      effortMinutes: 45,
      fixable: false,
      description:
        'Tests contain `skip`, `only` or early returns. A skipped test is indistinguishable from a passing one in most CI dashboards, so the suite reports green while covering less every month.',
      remediation:
        'Remove `.only` (only one test file runs when it is present) and replace `.skip` with a tracked issue link. Put quarantined tests behind an explicit allowlist so they are visible rather than silently absent.',
      compliance: [COMPLIANCE.iso27001A8],
      tags: ['flaky', 'hygiene'],
      references: [],
    },
    function* (ctx, emit) {
      if (!ctx.project.hasTests) return;
      let skipped = 0;
      let focused = 0;
      let sample: { path: string; line: number; text: string } | null = null;
      for (const path of ctx.files().filter((f) => isTestFile(f))) {
        const file = filesWithExts(ctx, path.slice(path.lastIndexOf('.'))).find((f) => f.path === path);
        if (!file) continue;
        for (const hit of file.matchNoComments(/\b(describe|it|test)\s*\.\s*(only|skip)\s*\(/g)) {
          if (hit.match.includes('only')) {
            focused++;
            if (!sample) sample = { path: file.path, line: hit.line, text: hit.text };
          } else {
            skipped++;
            if (!sample) sample = { path: file.path, line: hit.line, text: hit.text };
          }
        }
      }
      if (focused === 0 && skipped < 2) return;
      yield emit({
        path: sample?.path ?? 'tests',
        line: sample?.line ?? 1,
        snippet: sample?.text,
        evidence: focused
          ? `${focused} focused test(s) with \`.only\` -- only those run in that file`
          : `${skipped} skipped test(s)`,
        data: { skipped, focused },
        severity: focused > 0 ? 'high' : 'low',
        impact: focused > 0 ? 'degradation' : 'cosmetic',
        effortMinutes: 45,
      });
    },
    (ctx) => ctx.project.hasTests,
  ),
];

// ---------------------------------------------------------------------------

function isTestFile(path: string): boolean {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /^tests?\//.test(path) ||
    /(^|\/)__tests__\//.test(path) ||
    /_test\.(go|py|rs)$/.test(path) ||
    /(^|\/)test_[^/]+\.py$/.test(path) ||
    /(^|\/)spec\/[^/]+_spec\.rb$/.test(path)
  );
}

interface Coverage {
  percent: number;
  file: string;
  totalTests?: number;
}

/** Read a committed coverage report if one exists. Never runs the suite. */
function readCoverage(ctx: ScanContext): Coverage | null {
  const candidates = ['coverage/coverage-summary.json', 'coverage/lcov-report/index.html', 'coverage/index.html', 'htmlcov/index.html'];
  for (const path of ctx.files()) {
    if (!path.endsWith('coverage-summary.json')) continue;
    const file = filesWithExts(ctx, '.json').find((f) => f.path === path);
    if (!file) continue;
    try {
      const parsed = JSON.parse(file.content) as { total?: { lines?: { pct?: number; covered?: number; total?: number } } };
      const pct = parsed.total?.lines?.pct;
      if (typeof pct !== 'number') return null;
      return { percent: Math.round(pct), file: path };
    } catch {
      return null;
    }
  }
  void candidates;
  return null;
}