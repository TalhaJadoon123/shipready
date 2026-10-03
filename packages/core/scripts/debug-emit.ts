import { runScan } from '../src/engine.js';
import { createScanContext, internals } from '../src/context.js';
import { PluginRegistry } from '../src/registry.js';
import { defineRule, rulesToScanners } from '../src/rules/scanner-helper.js';
import { rule } from '../src/rules/rule.js';
import { makeRepo, removeRepo } from '../tests/fixtures.js';

const r = defineRule(
  rule({ id: 'test/bound-emit', name: 'Bound emit', category: 'security', description: 'd', remediation: 'r' }),
  function* (ctx, emit) {
    console.log('  detect ran, files =', ctx.files());
    yield emit({ path: 'a.ts', line: 1, evidence: 'emitted' });
  },
);

const root = await makeRepo({ name: 'dbg', files: [{ path: 'a.ts', content: 'const a = 1;\n' }] });
try {
  const ctx = await createScanContext({ type: 'repo', path: root }, new PluginRegistry());
  console.log('files:', ctx.files());
  console.log('walk:', internals.walkResult(ctx));

  const scanners = rulesToScanners([r]);
  const registry = new PluginRegistry(scanners);
  const direct: unknown[] = [];
  for await (const f of scanners[0]!.scan(ctx)) direct.push(f);
  console.log('direct scan yielded:', direct.length, JSON.stringify(direct));

  const { findings } = await runScan({ type: 'repo', path: root }, { registry });
  console.log('findings:', findings.length, JSON.stringify(findings.map((f) => f.ruleId)));
} finally {
  await removeRepo(root);
}