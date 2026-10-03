/**
 * Scan performance benchmark.
 *
 * Competitive concern: a readiness scanner that takes two minutes on a normal
 * repo will not get run, and a CI gate that takes two minutes gets disabled.
 * This measures cold and warm scans across repo sizes so the claim is real.
 *
 * Run: node docs/investor/bench.mjs
 */
import { createDefaultRegistry, runScan } from '../../packages/core/dist/index.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

/** A synthetic file of roughly `lines` lines of plausible service code. */
function serviceFile(lines) {
  const out = [
    "import express from 'express';",
    "import { prisma } from './db';",
    'const app = express();',
  ];
  let i = 0;
  while (out.length < lines) {
    const n = i++;
    out.push(
      `export async function handler${n}(req: Request, res: Response) {`,
      `  const rows = await prisma.item.findMany({ take: 50, where: { userId: req.user.id } });`,
      `  const enriched = rows.map((r) => ({ ...r, label: String(r.id).toUpperCase() }));`,
      `  try {`,
      `    await prisma.audit.create({ data: { action: "read", userId: req.user.id } });`,
      `  } catch (err) {`,
      `    logger.error({ err }, "audit write failed");`,
      `  }`,
      `  res.json({ items: enriched });`,
      '}',
      '',
    );
  }
  return out.slice(0, lines).join('\n');
}

function makeRepo(files) {
  const root = join(tmpdir(), `shipready-bench-${Math.random().toString(36).slice(2)}`);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

async function bench(label, files, expectedLines) {
  const root = makeRepo(files);
  try {
    // Cold: first scan, no JIT warm-up. A fresh registry per scan so each
    // measurement is independent -- verified to produce identical findings.
    const t0 = Date.now();
    const { report } = await runScan({ type: 'repo', path: root }, { registry: createDefaultRegistry() });
    const cold = Date.now() - t0;

    // Warm: second scan of the same tree.
    const t1 = Date.now();
    await runScan({ type: 'repo', path: root }, { registry: createDefaultRegistry() });
    const warm = Date.now() - t1;

    const lps = (n) => Math.round(expectedLines / (n / 1000)).toLocaleString();
    console.log(
      `${label.padEnd(26)} ${String(expectedLines).padStart(8)} lines  cold ${String(cold).padStart(7)}ms (${lps(cold)} l/s)  warm ${String(warm).padStart(7)}ms (${lps(warm)} l/s)  score ${report.score}`,
    );
    return { cold, warm };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('ShipReady scan performance\n');
console.log('Throughput is lines/second. A CI gate needs to finish in seconds.\n');

await bench('tiny service', { 'package.json': '{"name":"t","dependencies":{"express":"4.18.2"}}', 'src/a.ts': serviceFile(400) }, 400);
await bench('small service', { 'package.json': '{"name":"t","dependencies":{"express":"4.18.2"}}', 'src/a.ts': serviceFile(2000) }, 2000);
await bench('many small files', {
  'package.json': '{"name":"t","dependencies":{"express":"4.18.2"}}',
  ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`src/mod${i}.ts`, serviceFile(200)])),
}, 12000);
await bench('large monorepo-ish', {
  'package.json': '{"name":"t","dependencies":{"express":"4.18.2","@prisma/client":"5.0.0"}}',
  ...Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`packages/p${i}/src/index.ts`, serviceFile(400)])),
}, 60000);