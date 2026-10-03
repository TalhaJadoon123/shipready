/**
 * Terminal output helpers.
 *
 * Kept separate from the commands so they can be unit tested without spawning
 * a process, and so the colour policy lives in exactly one place.
 */

let colourEnabled = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;

export function setColour(enabled: boolean): void {
  colourEnabled = enabled && process.env.NO_COLOR === undefined;
}

export function isColour(): boolean {
  return colourEnabled;
}

function wrap(code: string, s: string): string {
  return colourEnabled ? `\u001b[${code}m${s}\u001b[0m` : s;
}

export const c = {
  bold: (s: string): string => wrap('1', s),
  dim: (s: string): string => wrap('2', s),
  red: (s: string): string => wrap('31', s),
  green: (s: string): string => wrap('32', s),
  yellow: (s: string): string => wrap('33', s),
  blue: (s: string): string => wrap('34', s),
  cyan: (s: string): string => wrap('36', s),
  grey: (s: string): string => wrap('90', s),
  bgGreen: (s: string): string => wrap('42;30', s),
  bgRed: (s: string): string => wrap('41;97', s),
  bgYellow: (s: string): string => wrap('43;30', s),
};

export function symbol(ok: boolean): string {
  return ok ? c.green('✓') : c.red('✗');
}

export function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function step(message: string): void {
  process.stderr.write(`${c.dim('...')} ${message}\n`);
}

export function success(message: string): void {
  process.stderr.write(`${c.green('✓')} ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${c.yellow('!')} ${message}\n`);
}

export function error(message: string): void {
  process.stderr.write(`${c.red('error')} ${message}\n`);
}

export function heading(message: string): void {
  process.stdout.write(`\n${c.bold(message)}\n`);
}

/** Write output to stdout, or to a file when `--output` is set. */
export async function emit(content: string, outputPath?: string): Promise<void> {
  if (!outputPath) {
    process.stdout.write(content.endsWith('\n') ? content : `${content}\n`);
    return;
  }
  const { writeFile } = await import('node:fs/promises');
  const { dirname, resolve } = await import('node:path');
  const { mkdir } = await import('node:fs/promises');
  const abs = resolve(outputPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
  success(`Wrote ${abs}`);
}

/** Pad a string to 
 columns, ignoring ANSI escapes. */
export function pad(s: string, n: number): string {
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/\[[0-9;]*m/g, '');
  return stripped + ' '.repeat(Math.max(0, n - stripped.length));
}

/** Ask a yes/no question on stdin. Returns the default on a non-TTY. */
export async function confirm(question: string, defaultAnswer = false): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultAnswer;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const suffix = defaultAnswer ? ' [Y/n] ' : ' [y/N] ';
  try {
    const answer = (await rl.question(`${c.cyan('?')} ${question}${suffix}`)).trim().toLowerCase();
    if (answer === '') return defaultAnswer;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function prompt(question: string, defaultAnswer?: string): Promise<string> {
  if (!process.stdin.isTTY) return defaultAnswer ?? '';
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const suffix = defaultAnswer ? ` (${defaultAnswer})` : '';
    const answer = (await rl.question(`${c.cyan('?')} ${question}${suffix}: `)).trim();
    return answer || (defaultAnswer ?? '');
  } finally {
    rl.close();
  }
}

export async function pick(question: string, choices: readonly string[]): Promise<string> {
  const list = choices.map((choice, i) => `  ${i + 1}) ${choice}`).join('\n');
  info(list);
  const answer = await prompt(question, '1');
  const index = Number.parseInt(answer, 10);
  if (Number.isNaN(index) || index < 1 || index > choices.length) return choices[0]!;
  return choices[index - 1]!;
}

export function termWidth(): number {
  return process.stdout.columns ?? 100;
}

export function rule(char = '─'): string {
  return char.repeat(Math.max(10, Math.min(termWidth() - 4, 78)));
}