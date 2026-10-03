import { SourceFile } from '../src/source.js';
import { FIXTURES } from '../tests/fixtures.js';

const spec = FIXTURES.productionReady;
const raw = spec.files.find((f) => f.path === 'app/api/users/route.ts')!.content;
const file = new SourceFile('app/api/users/route.ts', raw);

const re = /\.(findMany|findAll|all|select|list|search|query)\s*\(/g;
for (const line of file.matchNoComments(re)) {
  const block = file.content.slice(line.index, line.index + 320);
  console.log(`line ${line.line}: ${line.text}`);
  console.log('  window:', JSON.stringify(block.slice(0, 260)));
  console.log('  bounded=', /\b(take|limit|LIMIT|per_page|pageSize|first|cursor|skip|offset|head)\b/.test(block));
}