import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  buildManifest,
  findGaps,
  generate,
  toDocxBundle,
  toJsonBundle,
  toMarkdownBundle,
  type BundleFile,
  type ComplianceAnswer,
  type GenerateResult,
} from '@shipready/compliance';

/**
 * Writing a generated pack to disk.
 *
 * One entry point for every format, so `comply` and anything embedding it
 * produce byte-identical output for the same answers.
 */
export type BundleFormat = 'markdown' | 'json' | 'docx';

export async function writeBundle(
  files: readonly BundleFile[],
  format: BundleFormat,
  outputDir: string,
): Promise<string> {
  switch (format) {
    case 'markdown':
    case 'json':
    case 'docx':
      break;
    default:
      throw new Error(`Unknown compliance bundle format: ${String(format)}`);
  }

  const root = resolve(outputDir);
  await mkdir(root, { recursive: true });

  for (const file of files) {
    // Resolve first, then check containment against the resolved root: comparing
    // a resolved path against an unresolved one fails on Windows when the
    // caller passed a relative output directory.
    const abs = resolve(root, file.path);
    // Guard against a path escaping the output directory. The paths come from
    // template metadata today, but this is the boundary that would stop a
    // third-party template pack turning `../../etc/passwd` into a write.
    if (!abs.startsWith(root)) {
      throw new Error(`Refusing to write outside the output directory: ${file.path}`);
    }
    await mkdir(dirname(abs), { recursive: true });
    if (typeof file.content === 'string') {
      await writeFile(abs, file.content, 'utf8');
    } else {
      await writeFile(abs, file.content);
    }
  }

  return root;
}

/** Build the files for a generated pack in the requested format. */
export function bundleFiles(result: GenerateResult, answer: ComplianceAnswer, format: BundleFormat): BundleFile[] {
  const manifest = buildManifest(answer, result);
  switch (format) {
    case 'json':
      return toJsonBundle(result, manifest).files;
    case 'docx':
      return toDocxBundle(result, manifest).files;
    default:
      return toMarkdownBundle(result, manifest).files;
  }
}

export { findGaps, generate };