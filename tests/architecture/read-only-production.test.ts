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
    const capabilityProbe = path.resolve(
      'src/services/git/providers/cli/secureCurrentFile.ts',
    );
    const source = (
      await Promise.all(
        files
          .filter((file) => file !== capabilityProbe)
          .map((file) => readFile(file, 'utf8')),
      )
    ).join('\n');
    expect(source).not.toMatch(
      /\b(writeFile|appendFile|createWriteStream|mkdir|mkdirSync|mkdtemp|rename|unlink|rm|rmSync)\b/,
    );

    const probeSource = await readFile(capabilityProbe, 'utf8');
    expect(probeSource).toContain('mkdtemp(');
    expect(probeSource).toContain('writeFile(');
    expect(probeSource).toContain('rm(directory,');
    expect(probeSource).toMatch(/finally\s*{/);
  });

  it('requires descriptor-based no-follow working-tree reads', async () => {
    const provider = await readFile(
      path.resolve('src/services/git/providers/cli/CliReviewProvider.ts'),
      'utf8',
    );
    const secureCurrentFile = await readFile(
      path.resolve('src/services/git/providers/cli/secureCurrentFile.ts'),
      'utf8',
    );
    const productionReadPath = `${provider}\n${secureCurrentFile}`;
    expect(productionReadPath).not.toMatch(/\bopen\([^)]*,\s*['"]r['"]\s*\)/);
    expect(secureCurrentFile).toContain('constants.O_NOFOLLOW');
    expect(provider).toContain('handle.stat()');
    expect(secureCurrentFile).toContain('io.descriptorPaths(handle.fd)');
    expect(provider).toMatch(/finally\s*{\s*await handle\.close\(\)/);
  });

  it('blocks startup unless secure current-file capabilities pass', async () => {
    const entrypoint = await readFile(path.resolve('src/index.ts'), 'utf8');
    expect(entrypoint).toContain(
      'await assertSecureCurrentFileReadCapability()',
    );
    expect(
      entrypoint.indexOf('await assertSecureCurrentFileReadCapability()'),
    ).toBeLessThan(entrypoint.indexOf('transportManager.start()'));
    expect(entrypoint).toContain(
      'console.error(`${error.message} (${capabilityReason})`)',
    );
    expect(entrypoint).not.toContain('console.error(error.stack)');
  });

  it('documents the fail-closed platform contract', async () => {
    const readme = await readFile(path.resolve('README.md'), 'utf8');
    expect(readme).toMatch(/O_NOFOLLOW/i);
    expect(readme).toMatch(/descriptor\s+containment verification/i);
    expect(readme).toMatch(/version 0\.1\.0/i);
    expect(readme).toMatch(/startup fails closed/i);
    expect(readme).toMatch(/no\s+insecure fallback/i);
    expect(readme).not.toMatch(/Windows (?:is )?supported/i);
  });
});
