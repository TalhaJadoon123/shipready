import { SourceFile } from '../src/source.js';

const samples: [string, string][] = [
  ['empty catch brace', 'try {\n  doThing();\n} catch (e) {\n}\n'],
  ['catch on one line', 'try { doThing(); } catch (e) {}\n'],
  ['empty catch single-line', 'catch (e) {}\n'],
  ['empty except py', 'try:\n    pass\nexcept Exception:\n    pass\n'],
  ['bare except py', 'try:\n    pass\nexcept:\n    pass\n'],
  ['catch with comment', 'try { x() } catch (e) {\n  // ignore\n}\n'],
];

for (const [name, src] of samples) {
  const file = new SourceFile('a.ts', src);
  console.log(`\n=== ${name} ===`);
  for (let line = 1; line <= file.lineCount; line++) {
    console.log(`  ${line}: ${JSON.stringify(file.line(line))}`);
  }
}

console.log('\n=== searchParams case ===');
const r = new SourceFile('app/api/users/route.ts', 'const q = new URL(req.url).searchParams.get("q");\n');
console.log(r.matchNoComments(/\bsearchParams\.get\s*\(/).map((m) => `${m.line}:${m.text}`));

console.log('\n=== middleware cookies case ===');
const mw = new SourceFile('middleware.ts', "if (!req.cookies.get('session')) return new NextResponse(null, { status: 401 });\n");
console.log(/cookies?\s*\(/.test(mw.content));
console.log(/\/api/.test(mw.content));
console.log(/matcher|publicRoutes|protectedRoutes|isPublicRoute/.test(mw.content));