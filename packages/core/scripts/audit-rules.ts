import { readinessRules } from '../src/scanners/readiness/index.js';

console.log('total rules:', readinessRules.length);
const noCompliance = readinessRules.filter((r) => (r.compliance ?? []).length === 0);
console.log('no compliance:', noCompliance.length);
for (const r of noCompliance) console.log('  ', r.id);