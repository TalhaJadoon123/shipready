import { runScan } from '../src/engine.js';
import { createDefaultRegistry } from '../src/index.js';
import { FIXTURES, makeRepo, removeRepo } from '../tests/fixtures.js';

const which = process.argv[2] ?? 'vulnerable';
const spec = FIXTURES[which as keyof typeof FIXTURES];
if (!spec) throw new Error(`unknown fixture: ${which}`);

const root = await makeRepo(spec);
try {
  const { report } = await runScan({ type: 'repo', path: root }, { registry: createDefaultRegistry() });
  console.log(`\n${which.toUpperCase()}`);
  console.log('score  ', report.score, report.grade, report.verdict);
  console.log('lines  ', report.project.totalLines, report.project.type);
  console.log('counts ', JSON.stringify(report.summary.bySeverity));
  console.log('\nblockers:');
  for (const b of report.topBlockers) console.log(`  [${b.severity}] ${b.ruleId}  ${b.path}:${b.line}`);
  console.log('\ncategories:');
  for (const c of [...report.categories].sort((a, b) => a.score - b.score)) {
    console.log(`  ${c.label.padEnd(18)} ${String(c.score).padStart(3)}  (${c.findingCount} findings, ${c.blockers} blockers)`);
  }
  console.log('\nall findings:');
  for (const f of report.findings) console.log(`  [${f.severity.padEnd(8)}] ${f.ruleId}  ${f.location.path}:${f.location.startLine}`);
  console.log('\nerrors:', internalsWarn(root));
} finally {
  await removeRepo(root);
}

function internalsWarn(_r: string): string {
  return '(see onScannerError)';
}