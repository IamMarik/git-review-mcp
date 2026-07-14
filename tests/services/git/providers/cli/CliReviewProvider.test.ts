/**
 * @fileoverview Integration tests for the read-only CLI review boundary.
 * @module tests/services/git/providers/cli/CliReviewProvider
 */
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  assertReadOnlyGitSubcommand,
  CliReviewProvider,
  isBlockedSecretPath,
  READ_ONLY_GIT_SUBCOMMANDS,
  validateSafeRevision,
} from '@/services/git/providers/cli/CliReviewProvider.js';
import { requestContextService } from '@/utils/index.js';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0)
    throw new Error(result.stderr || `git ${args[0]} failed`);
  return result.stdout;
}

function context() {
  return {
    requestContext: requestContextService.createRequestContext({
      operation: 'review-provider-test',
    }),
    tenantId: 'test-tenant',
  };
}

async function snapshotRepository(
  repo: string,
): Promise<Record<string, string>> {
  return {
    head: git(repo, 'rev-parse', 'HEAD'),
    status: git(
      repo,
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ),
    index: git(repo, 'diff', '--cached', '--binary'),
    refs: git(repo, 'show-ref'),
    remotes: git(repo, 'remote', '-v'),
    config: git(repo, 'config', '--local', '--list'),
    tracked: await readFile(path.join(repo, 'src.txt'), 'utf8'),
    staged: await readFile(path.join(repo, 'staged.txt'), 'utf8'),
    untracked: await readFile(path.join(repo, 'untracked.txt'), 'utf8'),
  };
}

describe('CliReviewProvider', () => {
  let base: string;
  let repo: string;
  let provider: CliReviewProvider;
  let firstSha: string;
  let secondSha: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'repo-review-'));
    repo = path.join(base, 'project');
    await mkdir(repo);
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.name', 'Review Test');
    git(repo, 'config', 'user.email', 'review@example.test');
    await writeFile(path.join(repo, 'src.txt'), 'first\n');
    git(repo, 'add', 'src.txt');
    git(repo, 'commit', '-m', 'first commit');
    firstSha = git(repo, 'rev-parse', 'HEAD').trim();
    await writeFile(path.join(repo, 'history.txt'), 'history\n');
    await writeFile(
      path.join(repo, 'committed.bin'),
      Buffer.from([0xff, 0xfe, 0xfd]),
    );
    git(repo, 'add', 'history.txt', 'committed.bin');
    git(repo, 'commit', '-m', 'second commit');
    secondSha = git(repo, 'rev-parse', 'HEAD').trim();
    await writeFile(path.join(repo, 'staged.txt'), 'staged value\n');
    git(repo, 'add', 'staged.txt');
    await writeFile(
      path.join(repo, 'src.txt'),
      'first\npassword=visible-secret\nunstaged\n',
    );
    await writeFile(
      path.join(repo, 'untracked.txt'),
      'token=visible-token\nline two\nline three\n',
    );
    await writeFile(path.join(repo, '.env'), 'API_KEY=must-not-leak\n');
    provider = await CliReviewProvider.create(base);
  });

  it('has an exact read-only allowlist and fails closed', () => {
    expect(READ_ONLY_GIT_SUBCOMMANDS).toEqual([
      'status',
      'diff',
      'log',
      'show',
      'rev-parse',
      'symbolic-ref',
      'for-each-ref',
      'cat-file',
    ]);
    expect(() => assertReadOnlyGitSubcommand('commit')).toThrow(
      /not permitted/,
    );
    expect(() => assertReadOnlyGitSubcommand('status')).not.toThrow();
  });

  it('disables repository-configured execution extensions', async () => {
    git(repo, 'config', 'core.fsmonitor', '/definitely/missing/fsmonitor');
    git(repo, 'config', 'diff.external', '/definitely/missing/external-diff');

    await expect(
      provider.status({ repository: 'project' }, context()),
    ).resolves.toMatchObject({ repository: 'project' });
    await expect(
      provider.diff(
        { repository: 'project', scope: 'working', maxPatchBytes: 200_000 },
        context(),
      ),
    ).resolves.toMatchObject({ repository: 'project' });
  });

  it('enforces repository filesystem boundaries', async () => {
    await expect(
      provider.status({ repository: '../project' }, context()),
    ).rejects.toThrow(/traversal/);
    await expect(
      provider.status({ repository: repo }, context()),
    ).rejects.toThrow(/relative path/);
    const outside = await mkdtemp(path.join(tmpdir(), 'repo-review-outside-'));
    git(outside, 'init');
    await symlink(outside, path.join(base, 'escape'));
    await expect(
      provider.status({ repository: 'escape' }, context()),
    ).rejects.toThrow(/escapes REVIEW_BASE_DIR/);
    await mkdir(path.join(base, 'not-a-repo'));
    await expect(
      provider.status({ repository: 'not-a-repo' }, context()),
    ).rejects.toThrow(/not a git repository/);
    await expect(
      provider.status({ repository: 'project' }, context()),
    ).resolves.toMatchObject({ repository: 'project' });
  });

  it('reports status, creates deterministic snapshots, and detects drift', async () => {
    const status = await provider.status({ repository: 'project' }, context());
    expect(status).toMatchObject({
      branch: 'main',
      detached: false,
      headSha: secondSha,
    });
    expect(status.staged).toContain('staged.txt');
    expect(status.unstaged).toContain('src.txt');
    expect(status.untracked).toEqual(
      expect.arrayContaining(['untracked.txt', '.env']),
    );
    const same = await provider.status({ repository: 'project' }, context());
    expect(same.snapshotId).toBe(status.snapshotId);
    await writeFile(
      path.join(repo, 'untracked.txt'),
      'changed after snapshot\n',
    );
    const changed = await provider.status({ repository: 'project' }, context());
    expect(changed.snapshotId).not.toBe(status.snapshotId);
    await expect(
      provider.diff(
        {
          repository: 'project',
          scope: 'working',
          expectedSnapshotId: status.snapshotId,
          maxPatchBytes: 200_000,
        },
        context(),
      ),
    ).rejects.toThrow(/snapshot_changed/);
  });

  it('supports every strict diff scope, includes untracked files, redacts content, and truncates', async () => {
    const working = await provider.diff(
      { repository: 'project', scope: 'working', maxPatchBytes: 200_000 },
      context(),
    );
    expect(working.changedFiles).toEqual(
      expect.arrayContaining([
        'staged.txt',
        'src.txt',
        'untracked.txt',
        '.env',
      ]),
    );
    expect(working.omittedSecretPaths).toContain('.env');
    expect(working.patch).toContain('untracked.txt');
    expect(working.patch).toContain('[REDACTED]');
    expect(working.patch).not.toContain('visible-secret');
    expect(
      (
        await provider.diff(
          { repository: 'project', scope: 'staged', maxPatchBytes: 200_000 },
          context(),
        )
      ).changedFiles,
    ).toContain('staged.txt');
    expect(
      (
        await provider.diff(
          { repository: 'project', scope: 'unstaged', maxPatchBytes: 200_000 },
          context(),
        )
      ).changedFiles,
    ).toContain('src.txt');
    expect(
      (
        await provider.diff(
          {
            repository: 'project',
            scope: 'last_commit',
            maxPatchBytes: 200_000,
          },
          context(),
        )
      ).head?.sha,
    ).toBe(secondSha);
    expect(
      (
        await provider.diff(
          {
            repository: 'project',
            scope: 'commit',
            revision: secondSha.slice(0, 8),
            maxPatchBytes: 200_000,
          },
          context(),
        )
      ).head?.sha,
    ).toBe(secondSha);
    const range = await provider.diff(
      {
        repository: 'project',
        scope: 'range',
        baseRevision: firstSha,
        headRevision: secondSha,
        maxPatchBytes: 200_000,
      },
      context(),
    );
    expect(range.changedFiles).toContain('history.txt');
    const tiny = await provider.diff(
      { repository: 'project', scope: 'working', maxPatchBytes: 20 },
      context(),
    );
    expect(tiny.truncation.truncated).toBe(true);
    expect(tiny.truncation.returnedBytes).toBeLessThanOrEqual(20);
  });

  it('validates revisions against the narrow policy', () => {
    for (const value of [
      'HEAD',
      'HEAD^',
      'HEAD~0',
      'HEAD~20',
      'origin/main',
      firstSha,
      firstSha.slice(0, 7),
    ]) {
      expect(validateSafeRevision(value)).toBe(value);
    }
    for (const value of [
      '-HEAD',
      'HEAD~21',
      'main',
      'v1.0.0',
      'HEAD^{tree}',
      ':/search',
      'origin/../main',
    ]) {
      expect(() => validateSafeRevision(value)).toThrow(/not permitted/);
    }
  });

  it('blocks secrets, rejects binary files, and applies file limits and redaction', async () => {
    expect(isBlockedSecretPath('.env.local')).toBe(true);
    expect(isBlockedSecretPath('.ssh/id_rsa')).toBe(true);
    expect(isBlockedSecretPath('src/index.ts')).toBe(false);
    await expect(
      provider.changedFile(
        {
          repository: 'project',
          path: '.env',
          byteLimit: 100_000,
          lineLimit: 2_000,
        },
        context(),
      ),
    ).rejects.toThrow(/Secret or credential/);
    const changed = await provider.changedFile(
      {
        repository: 'project',
        path: 'untracked.txt',
        byteLimit: 100_000,
        lineLimit: 2,
      },
      context(),
    );
    expect(changed.content).toContain('[REDACTED]');
    expect(changed.content).not.toContain('visible-token');
    expect(changed.truncation.truncated).toBe(true);
    await writeFile(path.join(repo, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    await expect(
      provider.changedFile(
        {
          repository: 'project',
          path: 'binary.bin',
          byteLimit: 100,
          lineLimit: 100,
        },
        context(),
      ),
    ).rejects.toThrow(/Binary/);
    await expect(
      provider.fileAtRevision(
        {
          repository: 'project',
          path: '.env',
          revision: 'HEAD',
          byteLimit: 100,
          lineLimit: 100,
        },
        context(),
      ),
    ).rejects.toThrow(/Secret or credential/);
    await expect(
      provider.fileAtRevision(
        {
          repository: 'project',
          path: 'committed.bin',
          revision: 'HEAD',
          byteLimit: 100,
          lineLimit: 100,
        },
        context(),
      ),
    ).rejects.toThrow(/Binary/);
    const historical = await provider.fileAtRevision(
      {
        repository: 'project',
        path: 'history.txt',
        revision: 'HEAD',
        byteLimit: 100,
        lineLimit: 100,
      },
      context(),
    );
    expect(historical).toMatchObject({
      content: 'history\n',
      revision: secondSha,
      blobSize: 8,
    });
    expect(historical.blobSha).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it('leaves tracked files, untracked files, index, HEAD, branches, refs, tags, remotes, and config unchanged', async () => {
    git(repo, 'tag', 'review-baseline');
    git(
      repo,
      'remote',
      'add',
      'origin',
      'https://example.invalid/repository.git',
    );
    const before = await snapshotRepository(repo);
    const status = await provider.status({ repository: 'project' }, context());
    await provider.diff(
      {
        repository: 'project',
        scope: 'working',
        expectedSnapshotId: status.snapshotId,
        maxPatchBytes: 200_000,
      },
      context(),
    );
    await provider.log(
      { repository: 'project', limit: 10, includeAuthorName: true },
      context(),
    );
    await provider.changedFile(
      {
        repository: 'project',
        path: 'untracked.txt',
        byteLimit: 100_000,
        lineLimit: 2_000,
        expectedSnapshotId: status.snapshotId,
      },
      context(),
    );
    await provider.fileAtRevision(
      {
        repository: 'project',
        path: 'history.txt',
        revision: 'HEAD',
        byteLimit: 100_000,
        lineLimit: 2_000,
      },
      context(),
    );
    expect(await snapshotRepository(repo)).toEqual(before);
  });
});
