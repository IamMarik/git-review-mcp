/** @fileoverview Static production Git architecture checks. @module tests/architecture/read-only-production */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(full)
        : entry.name.endsWith('.ts')
          ? [full]
          : [];
    }),
  );
  return nested.flat();
}

describe('read-only production architecture', () => {
  it('contains no shell-interpolated execution path', async () => {
    const files = await sourceFiles(path.resolve('src/services/git'));
    const source = (
      await Promise.all(files.map((file) => readFile(file, 'utf8')))
    ).join('\n');
    expect(source).not.toMatch(/shell\s*:\s*true/);
    expect(source).not.toMatch(/\bexec\s*\(/);
    expect(source).not.toMatch(/bash\s+-c|eval\s*\(/);
    expect(source).not.toContain('child_process.exec');
  });

  it('does not expose a generic arbitrary Git argv method', async () => {
    const contract = await readFile(
      path.resolve('src/services/git/core/IReviewProvider.ts'),
      'utf8',
    );
    expect(contract).not.toMatch(/args\s*:\s*(readonly\s+)?string\[\]/);
    expect(contract).not.toMatch(/^\s*(execute|runGit|command)\s*\(/m);
  });

  it('contains no production filesystem mutation API', async () => {
    const files = await sourceFiles(path.resolve('src'));
    const source = (
      await Promise.all(files.map((file) => readFile(file, 'utf8')))
    ).join('\n');
    expect(source).not.toMatch(
      /\b(writeFile|appendFile|createWriteStream|mkdirSync|rename|unlink|rmSync)\b/,
    );
  });
});
