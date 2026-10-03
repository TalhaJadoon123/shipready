import { Command } from 'commander';
import { runScanCommand, runFixCommand, runReportCommand } from './commands/scan.js';
import { runInit } from './commands/init.js';
import { runObserve, runTraceCommand, type TraceOptions } from './commands/observe.js';
import { c, error, heading, info, success, warn, setColour } from './ui.js';
import { loadConfig } from './config.js';
import { setColour as setCoreColour } from '@shipready/core';
import { rules } from './rules.js';
import type { Severity } from '@shipready/core';

export const VERSION = '0.1.0';

/**
 * Exit code from the command that ran, returned by `main`.
 *
 * A module-level value rather than `program.exitCode`: Commander's type does
 * not declare that property, and reaching through to the instance would couple
 * every command to the program object.
 */
let exitCode = 0;

function setExitCode(code: number): void {
  exitCode = code;
}

/**
 * The exit code the last parsed command set.
 *
 * Exposed so callers embedding the CLI (and the tests) can read the result
 * without Commander's untyped `exitCode` property.
 */
export function getExitCode(): number {
  return exitCode;
}

export interface ProgramDeps {
  scan?: typeof runScanCommand;
  fix?: typeof runFixCommand;
  report?: typeof runReportCommand;
  init?: typeof runInit;
  observe?: typeof runObserve;
  trace?: typeof runTraceCommand;
}

/** Trace subcommands available under `shipready observe`. */
const TRACE_SUBCOMMANDS = ['report', 'replay', 'compare', 'list', 'cost'] as const;

export function createProgram(deps: ProgramDeps = {}): Command {
  const scanFn = deps.scan ?? runScanCommand;
  const fixFn = deps.fix ?? runFixCommand;
  const reportFn = deps.report ?? runReportCommand;
  const initFn = deps.init ?? runInit;
  const observeFn = deps.observe ?? runObserve;
  const traceFn = deps.trace ?? runTraceCommand;

  const program = new Command();

  program
    .name('shipready')
    .description(
      'Vibe-coded. Production-proven.\n\n' +
        'Scan a codebase for production readiness, observe agent behaviour, generate\n' +
        'compliance documentation and validate e-invoices.',
    )
    .version(VERSION, '-v, --version')
    .option('--no-color', 'disable coloured output')
    .option('-q, --quiet', 'suppress progress output')
    .showHelpAfterError('(run `shipready --help` for usage)');

  program.hook('preAction', (thisCommand) => {
    // `--no-color` may be written at the root or on the subcommand.
    const opts = thisCommand.opts() as { color?: boolean };
    const rootOpts = program.opts() as { color?: boolean };
    if (opts.color === false || rootOpts.color === false) {
      setColour(false);
      setCoreColour(false);
    }
  });

  const quiet = (root: Command): boolean => Boolean(root.opts().quiet);

  // --- scan ---------------------------------------------------------------
  program
    .command('scan')
    .description('Scan a codebase and report production readiness')
    .argument('[path]', 'path to scan', '.')
    .option('-f, --format <format>', 'console | json | markdown | sarif | html | github | summary', 'console')
    .option('-o, --output <file>', 'write the report to a file instead of stdout')
    .option('-t, --threshold <score>', 'fail below this score', parseNumber)
    .option('--compare', 'diff against the last saved scan')
    .option('--baseline', 'fail only on a regression versus the last scan')
    .option('--fail-on <mode>', 'blocker | any | never', 'blocker')
    .option('--disable <rules...>', 'disable specific rules by id')
    .option('--enable <rules...>', 'run only these rules')
    .option('--min-severity <severity>', 'critical | high | medium | low | info')
    .option('--min-confidence <n>', 'drop findings below this confidence', parseUnit)
    .option('--include <paths...>', 'restrict the scan to these paths')
    .option('--exclude <paths...>', 'skip these paths')
    .option('--max-files <n>', 'maximum files to walk', parseNumber)
    .option('--annotations', 'emit GitHub Actions annotations')
    .option('--verbose', 'show every finding')
    .option('--full', 'include cosmetic findings in the report')
    .option('--max-findings <n>', 'limit console findings', parseNumber)
    .action(async (path: string, opts: Record<string, unknown>) => {
      const result = await scanFn({
        path,
        format: opts.format as never,
        ...(opts.output ? { output: String(opts.output) } : {}),
        ...(opts.threshold !== undefined ? { threshold: Number(opts.threshold) } : {}),
        compare: Boolean(opts.compare),
        baseline: Boolean(opts.baseline),
        failOn: (opts.failOn as never) ?? 'blocker',
        disable: (opts.disable as string[]) ?? [],
        enable: (opts.enable as string[]) ?? [],
        ...(opts.minSeverity ? { minSeverity: opts.minSeverity as Severity } : {}),
        ...(opts.minConfidence !== undefined ? { minConfidence: Number(opts.minConfidence) } : {}),
        include: (opts.include as string[]) ?? [],
        exclude: (opts.exclude as string[]) ?? [],
        ...(opts.maxFiles !== undefined ? { maxFiles: Number(opts.maxFiles) } : {}),
        annotations: Boolean(opts.annotations),
        verbose: Boolean(opts.verbose),
        full: Boolean(opts.full),
        ...(opts.maxFindings !== undefined ? { maxFindings: Number(opts.maxFindings) } : {}),
        cwd: program.opts().cwd ?? process.cwd(),
        quiet: quiet(program),
      });
      setExitCode(result.exitCode);
    });

  // --- fix ----------------------------------------------------------------
  program
    .command('fix')
    .description('Generate fixes for the issues that have safe, working solutions')
    .argument('[path]', 'path to fix', '.')
    .option('--apply', 'write the generated files (dry run without this)')
    .option('--dry-run', 'preview without writing (the default)')
    .option('-n, --limit <n>', 'how many rules to generate fixes for', parseNumber)
    .option('--verbose', 'include the rules that have no generator')
    .action(async (path: string, opts: Record<string, unknown>) => {
      const result = await fixFn({
        path,
        apply: Boolean(opts.apply),
        dryRun: Boolean(opts.dryRun),
        limit: Number(opts.limit ?? 10),
        verbose: Boolean(opts.verbose),
        cwd: process.cwd(),
      });
      setExitCode(result.exitCode);
    });

  // --- report -------------------------------------------------------------
  program
    .command('report')
    .description('Re-render the last saved scan without re-running it')
    .argument('[path]', 'path whose report to render', '.')
    .option('-f, --format <format>', 'output format', 'console')
    .option('-o, --output <file>', 'write to a file')
    .option('--verbose', 'include cosmetic findings')
    .action(async (path: string, opts: Record<string, unknown>) => {
      const result = await reportFn({
        path,
        format: opts.format as never,
        ...(opts.output ? { output: String(opts.output) } : {}),
        verbose: Boolean(opts.verbose),
        cwd: process.cwd(),
      });
      setExitCode(result.exitCode);
    });

  // --- observe ------------------------------------------------------------
  const observe = program
    .command('observe')
    .description('Observe an agent, or analyse traces already recorded')
    .argument('[command...]', 'the command to run, after --')
    .option('--db <path>', 'trace database path')
    .option('--cost-budget <usd>', 'alert when a trace crosses this cost', parseNumber)
    .option('--max-cost <usd>', 'alert on any single call above this cost', parseNumber)
    .option('--capture-content', 'store prompt and response text (hashed by default)')
    .option('--timeout <ms>', 'stop observing after this long', parseNumber)
    .option('--json', 'emit the trace summary as JSON')
    .allowUnknownOption(true)
    .action(async (command: string[], opts: Record<string, unknown>) => {
      const argv = command ?? [];
      // Everything after a bare `--` is the user's command, not our flags.
      const separator = argv.indexOf('--');
      const passthrough = separator >= 0 ? argv.slice(separator + 1) : [];
      const ownArgs = separator >= 0 ? argv.slice(0, separator) : argv;

      const sub = ownArgs[0];

      if (sub && (TRACE_SUBCOMMANDS as readonly string[]).includes(sub)) {
        const traceOptions: TraceOptions = {
          subcommand: sub as TraceOptions['subcommand'],
          cwd: process.cwd(),
          ...(ownArgs[1] && !ownArgs[1].startsWith('-') ? { traceId: ownArgs[1] } : {}),
          ...(opts.db ? { dbPath: String(opts.db) } : {}),
          ...(opts.json ? { json: true } : {}),
          ...(opts.verbose ? { verbose: true } : {}),
          ...(opts.open ? { open: true } : {}),
          ...(opts.limit !== undefined ? { limit: Number(opts.limit) } : {}),
          ...(opts.speed !== undefined ? { speed: Number(opts.speed) } : {}),
          ...(opts.output ? { output: String(opts.output) } : {}),
        };
        setExitCode(await traceFn(traceOptions));
        return;
      }

      const commandLine = [sub, ...ownArgs.slice(1), ...passthrough].filter(Boolean).join(' ');
      if (commandLine.trim() === '') {
        error('Give a command to observe: shipready observe -- node my-agent.js');
        info('');
        info('Available subcommands: report, replay, compare, list, cost');
        setExitCode(2);
        return;
      }

      setExitCode(
        await observeFn({
          command: commandLine,
          cwd: process.cwd(),
          ...(opts.db ? { dbPath: String(opts.db) } : {}),
          ...(opts.costBudget !== undefined ? { costBudget: Number(opts.costBudget) } : {}),
          ...(opts.maxCost !== undefined ? { costPerEvent: Number(opts.maxCost) } : {}),
          ...(opts.captureContent ? { captureContent: true } : {}),
          ...(opts.timeout !== undefined ? { timeout: Number(opts.timeout) } : {}),
          ...(opts.json ? { json: true } : {}),
          quiet: quiet(program),
        }),
      );
    });

  observe
    .command('report')
    .description('HTML report with cost, token and activity charts')
    .argument('[traceId]', 'trace id, defaults to the most recent')
    .option('-o, --output <file>', 'write to a file')
    .option('--open', 'open it in a browser')
    .action(async (traceId: string | undefined, opts: Record<string, unknown>) => {
      setExitCode(
        await traceFn({
          subcommand: 'report',
          cwd: process.cwd(),
          ...(traceId ? { traceId } : {}),
          ...(opts.output ? { output: String(opts.output) } : {}),
          ...(opts.open ? { open: true } : {}),
        }),
      );
    });

  observe
    .command('replay')
    .description('Step through what the agent did, in order')
    .argument('[traceId]', 'trace id, defaults to the most recent')
    .option('--speed <n>', 'replay at n times the original speed')
    .option('--verbose', 'include full event detail')
    .action(async (traceId: string | undefined, opts: Record<string, unknown>) => {
      setExitCode(
        await traceFn({
          subcommand: 'replay',
          cwd: process.cwd(),
          ...(traceId ? { traceId } : {}),
          ...(opts.speed !== undefined ? { speed: Number(opts.speed) } : {}),
          ...(opts.verbose ? { verbose: true } : {}),
        }),
      );
    });

  observe
    .command('compare')
    .description('Compare this trace with the one before it')
    .argument('[traceId]', 'trace id, defaults to the most recent')
    .action(async (traceId: string | undefined) => {
      setExitCode(
        await traceFn({
          subcommand: 'compare',
          cwd: process.cwd(),
          ...(traceId ? { traceId } : {}),
        }),
      );
    });

  observe
    .command('list')
    .description('List recorded traces')
    .option('-n, --limit <n>', 'how many to show', parseNumber)
    .option('--json', 'emit JSON')
    .action(async (opts: Record<string, unknown>) => {
      setExitCode(
        await traceFn({
          subcommand: 'list',
          cwd: process.cwd(),
          ...(opts.limit !== undefined ? { limit: Number(opts.limit) } : {}),
          ...(opts.json ? { json: true } : {}),
        }),
      );
    });

  observe
    .command('cost')
    .description('Cost by day across recorded traces')
    .option('-n, --limit <n>', 'how many days', parseNumber)
    .action(async (opts: Record<string, unknown>) => {
      setExitCode(
        await traceFn({
          subcommand: 'cost',
          cwd: process.cwd(),
          ...(opts.limit !== undefined ? { limit: Number(opts.limit) } : {}),
        }),
      );
    });

  // --- init ---------------------------------------------------------------
  program
    .command('init')
    .description('Set up ShipReady: CI workflow, config file and npm scripts')
    .option('--ci', 'write a CI workflow with a readiness gate', true)
    .option('--no-ci', 'do not write a CI workflow')
    .option('--threshold <score>', 'score threshold for the generated CI workflow', parseNumber)
    .option('--force', 'overwrite an existing pipeline')
    .action(async (opts: Record<string, unknown>) => {
      const result = await initFn({
        ci: opts.ci !== false,
        force: Boolean(opts.force),
        threshold: Number(opts.threshold ?? 50),
        cwd: process.cwd(),
      });

      heading('  ShipReady setup');
      for (const file of result.created) success(`${file.path}  ${c.dim(file.reason)}`);
      for (const file of result.skipped) warn(`${file.path}  ${file.reason}`);
      heading('  Next');
      result.nextSteps.forEach((step, i) => info(`  ${i + 1}. ${step}`));
      info('');
    });

  // --- rules --------------------------------------------------------------
  program
    .command('rules')
    .description('List the readiness checks, optionally filtered by category')
    .option('-c, --category <category>', 'filter by category')
    .option('--fixable', 'show only the checks --fix can generate code for')
    .option('--json', 'emit JSON')
    .action(async (opts: Record<string, unknown>) => {
      const { FIXABLE_RULES } = await import('@shipready/core');
      let selected = rules;
      if (opts.category) selected = selected.filter((r) => r.category === opts.category);
      if (opts.fixable) selected = selected.filter((r) => FIXABLE_RULES[r.id]);

      if (opts.json) {
        info(
          JSON.stringify(
            selected.map((r) => ({
              id: r.id,
              name: r.name,
              category: r.category,
              severity: r.severity,
              impact: r.impact,
              effortMinutes: r.effortMinutes,
              fixable: Boolean(FIXABLE_RULES[r.id]),
            })),
            null,
            2,
          ),
        );
        return;
      }

      const byCategory = new Map<string, typeof selected>();
      for (const rule of selected) {
        const existing = byCategory.get(rule.category) ?? [];
        byCategory.set(rule.category, [...existing, rule]);
      }

      heading(`  ${selected.length} readiness checks`);
      for (const [category, list] of [...byCategory.entries()].sort()) {
        info(`  ${c.bold(category)} ${c.dim(`(${list.length})`)}`);
        for (const rule of list) {
          const fixable = FIXABLE_RULES[rule.id] ? c.green('  fixable') : '';
          info(`    ${rule.id.replace(`${category}/`, '').padEnd(44)} ${c.dim(rule.impact.padEnd(12))}${fixable}`);
        }
        info('');
      }
      info(c.dim('  Checks marked fixable get working code from `shipready fix`.'));
      info('');
    });

  // --- config -------------------------------------------------------------
  program
    .command('config')
    .description('Show the resolved configuration')
    .action(async () => {
      const loaded = await loadConfig(process.cwd());
      heading('  ShipReady configuration');
      info(`  source: ${loaded.path ?? 'defaults (no .shipready.yml)'}`);
      for (const message of loaded.warnings) warn(`  ${message}`);
      info('');
      info(JSON.stringify(loaded.config, null, 2).replace(/^/gm, '  '));
      info('');
    });

  // --- check --------------------------------------------------------------
  program
    .command('check')
    .description('Fail on a threshold or a blocker; designed for CI')
    .argument('[path]', 'path to check', '.')
    .option('-t, --threshold <score>', 'minimum acceptable score', parseNumber)
    .option('--baseline', 'fail only on a regression versus the last scan')
    .option('--fail-on <mode>', 'blocker | any | never', 'blocker')
    .action(async (path: string, opts: Record<string, unknown>) => {
      const result = await scanFn({
        path,
        format: 'summary',
        compare: false,
        baseline: Boolean(opts.baseline),
        failOn: (opts.failOn as never) ?? 'blocker',
        disable: [],
        enable: [],
        include: [],
        exclude: [],
        annotations: true,
        verbose: false,
        full: false,
        cwd: process.cwd(),
        quiet: true,
        ...(opts.threshold !== undefined ? { threshold: Number(opts.threshold) } : {}),
      });
      info(`${result.report.score}/100 (${result.report.grade})  ${result.report.verdict}`);
      const blocking = result.report.findings.filter((f) => f.productionImpact === 'blocker');
      for (const f of blocking.slice(0, 10)) {
        info(`  blocker  ${f.location.path}:${f.location.startLine}  ${f.title}`);
      }
      if (blocking.length > 10) info(c.dim(`  ...and ${blocking.length - 10} more`));
      setExitCode(result.exitCode);
    });

  return program;
}

function parseNumber(value: string): number {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) throw new Error(`Expected a number, got "${value}"`);
  return n;
}

function parseUnit(value: string): number {
  const n = parseNumber(value);
  if (n < 0 || n > 1) throw new Error(`Expected a value between 0 and 1, got "${value}"`);
  return n;
}

/**
 * Run the CLI and return the process exit code.
 *
 * Commander signals `--help` and `--version` by throwing with a `code`. Those
 * are successes, so they return 0 rather than falling through to the error
 * path and printing a stack trace at the user.
 */
export async function main(argv: string[] = process.argv): Promise<number> {
  exitCode = 0;
  if (argv.includes('--no-color')) {
    setColour(false);
    setCoreColour(false);
  }
  const program = createProgram();
  try {
    await program.parseAsync(argv);
  } catch (caught) {
    const code = (caught as { code?: string }).code;
    if (code === 'commander.helpDisplayed' || code === 'commander.version' || code === 'commander.help') return 0;
    error(caught instanceof Error ? caught.message : String(caught));
    return 2;
  }
  return exitCode;
}