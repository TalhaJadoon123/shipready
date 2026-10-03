import { SourceFile } from '../src/source.js';
import { FIXTURES } from '../tests/fixtures.js';

const spec = FIXTURES.productionReady;
const raw = spec.files.find((f) => f.path === 'prisma/schema.prisma')!.content;
const schema = new SourceFile('prisma/schema.prisma', raw);
const lines = schema.lines;

for (let i = 0; i < lines.length; i++) {
  const modelMatch = /^model\s+(\w+)\s*\{/.exec((schema.noComments.split('\n')[i] ?? '').trim());
  if (!modelMatch?.[1]) continue;
  const modelName = modelMatch[1];
  let depth = 0;
  const body: { line: number; text: string }[] = [];
  for (let j = i; j < lines.length; j++) {
    const text = schema.line(j + 1);
    for (const ch of text) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    body.push({ line: j + 1, text });
    if (depth <= 0 && j > i) break;
  }
  const blockText = body.map((b) => b.text).join('\n');
  console.log(`\n=== ${modelName} (lines ${body[0]!.line}..${body.at(-1)!.line}) ===`);
  console.log(blockText);
  console.log('  hasIndex(user)=', new RegExp('@@index\\([^)]*\\buser\\b').test(blockText));
  for (const entry of body) {
    const rel = /^\s*(\w+)\s+\w[\w[\]?]*\s+@relation\s*\(/.exec(entry.text);
    if (!rel?.[1]) continue;
    const field = rel[1];
    const hasIndex = new RegExp(`@@index\\([^)]*\\b${field}\\b`).test(blockText);
    console.log(`  rel ${field} -> indexed=${hasIndex}`);
  }
}