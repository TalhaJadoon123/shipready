/**
 * Verifies every number quoted in materials.md that is marked [verified].
 *
 * Run from the repo root:  node docs/investor/verify-claims.mjs
 *
 * The point of this file is that a pitch document decays. Numbers copied by
 * hand go stale silently, and a stale number in front of an investor is worse
 * than no number. Anything claimed in the deck should be re-derivable by
 * running this.
 */
import { createDefaultRegistry, runScan } from '../../packages/core/dist/index.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * A deliberately unfinished codebase. The same shape as the test fixtures, in
 *lined here so this file runs without the test toolchain.
 */
const VULNERABLE = {
  'package.json': JSON.stringify({
    name: 'vulnerable',
    dependencies: { express: '4.18.2', '@prisma/client': '5.0.0', openai: '4.0.0' },
  }),
  'src/server.js': [
    "const express = require('express');",
    "const cors = require('cors');",
    "const { prisma } = require('./db');",
    'const app = express();',
    'app.use(cors({ origin: "*" }));',
    "app.get('/users', async (req, res) => { res.json(await prisma.user.findMany()); });",
    "app.post('/ask', async (req, res) => {",
    '  const answer = await callModel(req.body.text);',
    '  await prisma.summary.create({ data: { answer } });',
    '  try { await charge(req.user); } catch (e) {}',
    '  res.json({ answer });',
    '});',
    'app.listen(3000);',
    'async function callModel(p) {',
    "  const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST' });",
    '  return (await r.json()).text;',
    '}',
  ].join('\n'),
  'src/db.js': "const { PrismaClient } = require('@prisma/client');\nmodule.exports = { prisma: new PrismaClient() };\n",
};

function makeRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'shipready-claims-'));
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

const catalogue = createDefaultRegistry().all();
console.log('--- catalogue (public projection) ---');
console.log('rules:', catalogue.length);
const bySource = {};
for (const r of catalogue) {
  const src = r.id.split('/')[0];
  bySource[src] = (bySource[src] || 0) + 1;
}
console.log('by source:', JSON.stringify(bySource));

console.log('\n--- internal rule definitions (impact / fixable) ---');
// The registry's public projection strips `impact` and `fixable`, so read them
// from the internal scanner modules instead. The field is `impact`, not
// `productionImpact` -- the latter is what a *finding* carries.
const internal = [];
const mods = [
  'database',
  'security',
  'error-handling',
  'observability',
  'deployment',
  'performance',
  'data-integrity',
  'testing',
  'accessibility',
  'ai-specific',
];
for (const mod of mods) {
  try {
    const m = await import(`../../packages/core/dist/scanners/readiness/${mod}.js`);
    for (const key of Object.keys(m)) {
      const v = m[key];
      if (Array.isArray(v) && v.length && typeof v[0] === 'object' && 'impact' in v[0]) internal.push(...v);
    }
  } catch {
    /* module may not export a rule array under this name */
  }
}
console.log('internal rules found:', internal.length);
console.log('impact=blocker:', internal.filter((r) => r.impact === 'blocker').length);
console.log('impact=degradation:', internal.filter((r) => r.impact === 'degradation').length);
console.log('fixable:', internal.filter((r) => r.fixable).length);
const bySev = {};
for (const r of internal) bySev[r.severity] = (bySev[r.severity] || 0) + 1;
console.log('by severity:', JSON.stringify(bySev));

console.log('\n--- categories from a real scan ---');
const root = makeRepo(VULNERABLE);
try {
  const { report } = await runScan({ type: 'repo', path: root }, { registry: createDefaultRegistry() });
  console.log('categories:', report.categories.length);
  console.log('vulnerable sample score:', report.score, report.grade, report.verdict);
  console.log('vulnerable sample blockers:', report.summary.blockers);
  console.log('vulnerable sample fixable:', report.summary.fixable);
  console.log('vulnerable sample total findings:', report.summary.totalFindings);
  console.log('topBlockers returned (capped at 5):', report.topBlockers.length);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('\n--- compliance frameworks on disk ---');
const { readdirSync } = await import('node:fs');
console.log(readdirSync(new URL('../../packages/compliance/templates', import.meta.url)));