/**
 * @fileoverview Security-focused, read-only CLI repository review provider.
 * @module services/git/providers/cli/CliReviewProvider
 */

import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import crossSpawn from 'cross-spawn';

import type { IReviewProvider } from '../../core/IReviewProvider.js';
import type {
  ReviewCommitSummary,
  ReviewDiffInput,
  ReviewDiffResult,
  ReviewDiffStat,
  ReviewFileAtRevisionInput,
  ReviewFileInput,
  ReviewFileResult,
  ReviewLogInput,
  ReviewLogResult,
  ReviewOperationContext,
  ReviewStatusInput,
  ReviewStatusResult,
} from '../../types.js';
import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';
import { logger } from '@/utils/index.js';

export const READ_ONLY_GIT_SUBCOMMANDS = [
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'symbolic-ref',
  'for-each-ref',
  'cat-file',
] as const;

export type ReadOnlyGitSubcommand = (typeof READ_ONLY_GIT_SUBCOMMANDS)[number];
const READ_ONLY_COMMAND_SET = new Set<string>(READ_ONLY_GIT_SUBCOMMANDS);
const MAX_STATUS_FILES = 500;
const SAFE_DIFF_FLAGS = ['--no-ext-diff', '--no-textconv'] as const;

/** Fail closed before any process is spawned. */
export function assertReadOnlyGitSubcommand(
  subcommand: string,
): asserts subcommand is ReadOnlyGitSubcommand {
  if (!READ_ONLY_COMMAND_SET.has(subcommand)) {
    throw new McpError(
      JsonRpcErrorCode.Forbidden,
      `Git subcommand '${subcommand}' is not permitted by the read-only allowlist.`,
      { subcommand, allowedSubcommands: [...READ_ONLY_GIT_SUBCOMMANDS] },
    );
  }
}

interface GitResult {
  stdout: string;
  stdoutBuffer: Buffer;
  stderr: string;
  exitCode: number;
}

interface ResolvedRepository {
  identifier: string;
  root: string;
}

interface ParsedStatus {
  raw: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicts: string[];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function normalizeRepositorySelector(selector: string): string {
  if (!selector || selector.includes('\0') || path.isAbsolute(selector)) {
    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      'Repository must be a non-empty relative path beneath REVIEW_BASE_DIR.',
      { repository: selector },
    );
  }
  const normalized = path.normalize(selector);
  if (
    normalized === '..' ||
    normalized.startsWith(`..${path.sep}`) ||
    normalized.split(path.sep).includes('..')
  ) {
    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      'Repository traversal outside REVIEW_BASE_DIR is not permitted.',
      { repository: selector },
    );
  }
  return normalized;
}

export function validateSafeRevision(revision: string): string {
  if (!revision || revision.startsWith('-') || revision.includes('\0')) {
    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      'Revision is not permitted by the safe revision policy.',
      { revision },
    );
  }
  if (revision === 'HEAD' || revision === 'HEAD^') return revision;
  const relativeHead = revision.match(/^HEAD~(\d{1,2})$/);
  if (relativeHead && Number(relativeHead[1]) <= 20) return revision;
  if (/^[0-9a-fA-F]{7,64}$/.test(revision)) return revision;
  if (revision.startsWith('origin/')) {
    const branch = revision.slice('origin/'.length);
    const validBranch =
      /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) &&
      !branch.includes('..') &&
      !branch.includes('//') &&
      !branch.endsWith('/') &&
      !branch.endsWith('.') &&
      !branch.endsWith('.lock') &&
      !branch
        .split('/')
        .some((part) => part.startsWith('.') || part.endsWith('.lock'));
    if (validBranch) return revision;
  }
  throw new McpError(
    JsonRpcErrorCode.ValidationError,
    'Revision is not permitted. Use HEAD, HEAD^, HEAD~0..20, origin/<safe-branch>, or a 7-64 character hexadecimal commit SHA.',
    { revision },
  );
}

export function validateReviewPath(filePath: string): string {
  if (
    !filePath ||
    filePath.includes('\0') ||
    path.isAbsolute(filePath) ||
    filePath.includes(':')
  ) {
    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      'File path must be a non-empty relative repository path without colon or null characters.',
      { path: filePath },
    );
  }
  const normalized = path.posix.normalize(filePath.replaceAll('\\', '/'));
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.split('/').includes('..')
  ) {
    throw new McpError(
      JsonRpcErrorCode.ValidationError,
      'File path traversal is not permitted.',
      { path: filePath },
    );
  }
  return normalized;
}

export function isBlockedSecretPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase().replaceAll('\\', '/');
  const parts = normalized.split('/');
  const base = parts.at(-1) ?? '';
  const blockedDirectories = new Set([
    '.git',
    '.ssh',
    '.aws',
    '.azure',
    '.gnupg',
    '.kube',
    '.docker',
  ]);
  if (parts.some((part) => blockedDirectories.has(part))) return true;
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (/\.(pem|key|p12|pfx|jks|keystore|crt|cer)$/.test(base)) return true;
  return new Set([
    '.netrc',
    '.npmrc',
    '_netrc',
    'credentials',
    'credentials.json',
    'id_rsa',
    'id_dsa',
    'id_ecdsa',
    'id_ed25519',
    'secrets.json',
    'secrets.yaml',
    'secrets.yml',
    'service-account.json',
  ]).has(base);
}

function redactCredentials(content: string): {
  content: string;
  count: number;
} {
  let count = 0;
  const assignment =
    /(^[+\- ]?\s*(?:export\s+)?[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*\s*[:=]\s*)([^\s#][^\r\n]*)/gim;
  let redacted = content.replace(assignment, (_match, prefix: string) => {
    count += 1;
    return `${prefix}[REDACTED]`;
  });
  redacted = redacted.replace(
    /(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
    (_m, prefix: string) => {
      count += 1;
      return `${prefix}[REDACTED]`;
    },
  );
  return { content: redacted, count };
}

function parseStatus(raw: string): ParsedStatus {
  const entries = raw.split('\0');
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const conflicts: string[] = [];
  const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code === '??') {
      untracked.push(file);
      continue;
    }
    if (code === '!!') continue;
    if (conflictCodes.has(code) || code.includes('U')) conflicts.push(file);
    if (code[0] !== ' ' && code[0] !== '?') staged.push(file);
    if (code[1] !== ' ' && code[1] !== '?') unstaged.push(file);
    if (code.includes('R') || code.includes('C')) index += 1;
  }
  return {
    raw,
    staged: uniqueSorted(staged),
    unstaged: uniqueSorted(unstaged),
    untracked: uniqueSorted(untracked),
    conflicts: uniqueSorted(conflicts),
  };
}

function truncateUtf8(
  value: string,
  maxBytes: number,
): {
  value: string;
  originalBytes: number;
  returnedBytes: number;
  truncated: boolean;
} {
  const source = Buffer.from(value, 'utf8');
  if (source.byteLength <= maxBytes) {
    return {
      value,
      originalBytes: source.byteLength,
      returnedBytes: source.byteLength,
      truncated: false,
    };
  }
  const clipped = source.subarray(0, maxBytes).toString('utf8');
  return {
    value: clipped,
    originalBytes: source.byteLength,
    returnedBytes: Buffer.byteLength(clipped),
    truncated: true,
  };
}

/** Native Git provider whose public methods are all review-only. */
export class CliReviewProvider implements IReviewProvider {
  readonly #baseDirectory: string;
  readonly #timeoutMs: number;
  readonly #maxBufferBytes: number;

  constructor(baseDirectory: string, timeoutMs = 30_000, maxBufferMb = 10) {
    if (!path.isAbsolute(baseDirectory)) {
      throw new McpError(
        JsonRpcErrorCode.ConfigurationError,
        'REVIEW_BASE_DIR must be an absolute path.',
        { baseDirectory },
      );
    }
    this.#baseDirectory = baseDirectory;
    this.#timeoutMs = timeoutMs;
    this.#maxBufferBytes = maxBufferMb * 1024 * 1024;
  }

  static async create(
    baseDirectory: string,
    timeoutMs = 30_000,
    maxBufferMb = 10,
  ): Promise<CliReviewProvider> {
    const resolved = await realpath(baseDirectory).catch(() => {
      throw new McpError(
        JsonRpcErrorCode.ConfigurationError,
        'REVIEW_BASE_DIR does not exist or cannot be resolved.',
        { baseDirectory },
      );
    });
    const baseStat = await stat(resolved);
    if (!baseStat.isDirectory()) {
      throw new McpError(
        JsonRpcErrorCode.ConfigurationError,
        'REVIEW_BASE_DIR must resolve to a directory.',
        { baseDirectory },
      );
    }
    return new CliReviewProvider(resolved, timeoutMs, maxBufferMb);
  }

  async #runGit(
    subcommand: ReadOnlyGitSubcommand,
    args: readonly string[],
    cwd: string,
    allowNonZeroExit = false,
  ): Promise<GitResult> {
    assertReadOnlyGitSubcommand(subcommand);
    if (
      subcommand === 'diff' &&
      SAFE_DIFF_FLAGS.some((flag) => !args.includes(flag))
    ) {
      throw new McpError(
        JsonRpcErrorCode.Forbidden,
        'Read-only diff execution must disable external diff and textconv drivers.',
      );
    }
    const argv = [subcommand, ...args];
    return await new Promise<GitResult>((resolve, reject) => {
      const child = crossSpawn('git', argv, {
        cwd,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          GIT_CONFIG_COUNT: '3',
          GIT_CONFIG_KEY_0: 'core.fsmonitor',
          GIT_CONFIG_VALUE_0: 'false',
          GIT_CONFIG_KEY_1: 'core.untrackedCache',
          GIT_CONFIG_VALUE_1: 'false',
          GIT_CONFIG_KEY_2: 'diff.external',
          GIT_CONFIG_VALUE_2: '',
          LC_ALL: 'C',
        },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, this.#timeoutMs);
      const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.byteLength;
        if (totalBytes > this.#maxBufferBytes) child.kill('SIGKILL');
        else target.push(buffer);
      };
      child.stdout?.on('data', collect(stdout));
      child.stderr?.on('data', collect(stderr));
      child.once('error', (error) => {
        settled = true;
        clearTimeout(timer);
        reject(
          new McpError(
            JsonRpcErrorCode.InternalError,
            `Unable to execute read-only Git ${subcommand}: ${error.message}`,
            { subcommand },
          ),
        );
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const stdoutBuffer = Buffer.concat(stdout);
        const result = {
          stdout: stdoutBuffer.toString('utf8'),
          stdoutBuffer,
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: code ?? -1,
        };
        if (totalBytes > this.#maxBufferBytes) {
          reject(
            new McpError(
              JsonRpcErrorCode.ValidationError,
              `Git ${subcommand} output exceeded the configured buffer limit.`,
              { subcommand, maxBufferBytes: this.#maxBufferBytes },
            ),
          );
        } else if (result.exitCode !== 0 && !allowNonZeroExit) {
          reject(
            new McpError(
              JsonRpcErrorCode.InvalidRequest,
              `Read-only Git ${subcommand} failed: ${result.stderr.trim() || 'unknown error'}`,
              { subcommand, exitCode: result.exitCode },
            ),
          );
        } else resolve(result);
      });
    });
  }

  async #resolveRepository(selector: string): Promise<ResolvedRepository> {
    const normalized = normalizeRepositorySelector(selector);
    const candidate = path.resolve(this.#baseDirectory, normalized);
    if (!isInside(this.#baseDirectory, candidate)) {
      throw new McpError(
        JsonRpcErrorCode.Forbidden,
        'Repository resolves outside REVIEW_BASE_DIR.',
        { repository: selector },
      );
    }
    const resolvedCandidate = await realpath(candidate).catch(() => {
      throw new McpError(
        JsonRpcErrorCode.NotFound,
        'Selected repository path does not exist.',
        { repository: selector },
      );
    });
    if (!isInside(this.#baseDirectory, resolvedCandidate)) {
      throw new McpError(
        JsonRpcErrorCode.Forbidden,
        'Repository symlink escapes REVIEW_BASE_DIR.',
        { repository: selector },
      );
    }
    const rootResult = await this.#runGit(
      'rev-parse',
      ['--show-toplevel'],
      resolvedCandidate,
    );
    const root = await realpath(rootResult.stdout.trim());
    if (!isInside(this.#baseDirectory, root)) {
      throw new McpError(
        JsonRpcErrorCode.Forbidden,
        'Git repository root is outside REVIEW_BASE_DIR.',
        { repository: selector },
      );
    }
    return {
      identifier: path.relative(this.#baseDirectory, root) || '.',
      root,
    };
  }

  async #readStatus(root: string): Promise<ParsedStatus> {
    const result = await this.#runGit(
      'status',
      ['--porcelain=v1', '-z', '--untracked-files=all'],
      root,
    );
    return parseStatus(result.stdout);
  }

  async #resolveRevision(root: string, revision: string): Promise<string> {
    const safe = validateSafeRevision(revision);
    const result = await this.#runGit(
      'rev-parse',
      ['--verify', `${safe}^{commit}`],
      root,
    );
    return result.stdout.trim();
  }

  async #snapshot(
    repository: ResolvedRepository,
    status?: ParsedStatus,
  ): Promise<{ id: string; headSha: string; status: ParsedStatus }> {
    const currentStatus = status ?? (await this.#readStatus(repository.root));
    const [head, staged, unstaged] = await Promise.all([
      this.#runGit('rev-parse', ['--verify', 'HEAD'], repository.root),
      this.#runGit(
        'diff',
        [...SAFE_DIFF_FLAGS, '--binary', '--cached', 'HEAD', '--'],
        repository.root,
      ),
      this.#runGit(
        'diff',
        [...SAFE_DIFF_FLAGS, '--binary', '--'],
        repository.root,
      ),
    ]);
    const untrackedMetadata: string[] = [];
    for (const untrackedPath of currentStatus.untracked) {
      const absolute = path.resolve(repository.root, untrackedPath);
      if (!isInside(repository.root, absolute)) continue;
      const fileStat = await lstat(absolute).catch(() => undefined);
      if (fileStat) {
        untrackedMetadata.push(
          `${untrackedPath}\0${fileStat.size}\0${fileStat.mtimeMs}\0${fileStat.mode}`,
        );
      }
    }
    const id = createHash('sha256')
      .update(repository.identifier)
      .update('\0')
      .update(head.stdout.trim())
      .update('\0')
      .update(currentStatus.raw)
      .update('\0')
      .update(staged.stdout)
      .update('\0')
      .update(unstaged.stdout)
      .update('\0')
      .update(untrackedMetadata.join('\0'))
      .digest('hex');
    return { id, headSha: head.stdout.trim(), status: currentStatus };
  }

  #assertExpectedSnapshot(expected: string | undefined, actual: string): void {
    if (expected && expected !== actual) {
      throw new McpError(
        JsonRpcErrorCode.Conflict,
        'snapshot_changed: repository state no longer matches the expected snapshot.',
        {
          reason: 'snapshot_changed',
          expectedSnapshotId: expected,
          actualSnapshotId: actual,
        },
      );
    }
  }

  async status(
    input: ReviewStatusInput,
    context: ReviewOperationContext,
  ): Promise<ReviewStatusResult> {
    const repository = await this.#resolveRepository(input.repository);
    const parsed = await this.#readStatus(repository.root);
    const snapshot = await this.#snapshot(repository, parsed);
    const branchResult = await this.#runGit(
      'symbolic-ref',
      ['--quiet', '--short', 'HEAD'],
      repository.root,
      true,
    );
    const branch =
      branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
    let upstream: string | undefined;
    let ahead: number | undefined;
    let behind: number | undefined;
    if (branch) {
      const tracking = await this.#runGit(
        'for-each-ref',
        [
          '--format=%(upstream:short)%00%(upstream:track)',
          `refs/heads/${branch}`,
        ],
        repository.root,
        true,
      );
      const [upstreamValue = '', track = ''] = tracking.stdout
        .trim()
        .split('\0');
      upstream = upstreamValue || undefined;
      const aheadMatch = track.match(/ahead (\d+)/);
      const behindMatch = track.match(/behind (\d+)/);
      ahead = aheadMatch ? Number(aheadMatch[1]) : upstream ? 0 : undefined;
      behind = behindMatch ? Number(behindMatch[1]) : upstream ? 0 : undefined;
    }
    const allChanged = uniqueSorted([
      ...parsed.staged,
      ...parsed.unstaged,
      ...parsed.untracked,
      ...parsed.conflicts,
    ]);
    logger.debug('Read repository review status', {
      ...context.requestContext,
      repository: repository.identifier,
      changedFiles: allChanged.length,
    });
    return {
      repository: repository.identifier,
      branch,
      detached: branch === null,
      headSha: snapshot.headSha,
      ...(upstream ? { upstream } : {}),
      ...(ahead !== undefined ? { ahead } : {}),
      ...(behind !== undefined ? { behind } : {}),
      staged: parsed.staged.slice(0, MAX_STATUS_FILES),
      unstaged: parsed.unstaged.slice(0, MAX_STATUS_FILES),
      untracked: parsed.untracked.slice(0, MAX_STATUS_FILES),
      conflicts: parsed.conflicts.slice(0, MAX_STATUS_FILES),
      snapshotId: snapshot.id,
      truncated:
        parsed.staged.length > MAX_STATUS_FILES ||
        parsed.unstaged.length > MAX_STATUS_FILES ||
        parsed.untracked.length > MAX_STATUS_FILES ||
        parsed.conflicts.length > MAX_STATUS_FILES,
      totalChangedFiles: allChanged.length,
    };
  }

  async #commitSummary(
    root: string,
    revision: string,
    includeAuthorName = true,
  ): Promise<ReviewCommitSummary> {
    const result = await this.#runGit(
      'show',
      ['--no-patch', '--format=%H%x00%aI%x00%an%x00%s', revision],
      root,
    );
    const [sha = '', authorDate = '', authorName = '', subject = ''] =
      result.stdout.trimEnd().split('\0');
    return {
      sha,
      subject,
      authorDate,
      ...(includeAuthorName && authorName ? { authorName } : {}),
    };
  }

  async #revisionPaths(root: string, revision: string): Promise<string[]> {
    const result = await this.#runGit(
      'show',
      [
        '--format=',
        '--name-only',
        '-z',
        '--no-renames',
        ...SAFE_DIFF_FLAGS,
        revision,
      ],
      root,
    );
    return uniqueSorted(result.stdout.split('\0').filter(Boolean));
  }

  async #readCurrentFileForPatch(
    repository: ResolvedRepository,
    filePath: string,
    byteLimit: number,
  ): Promise<{ patch: string; insertions: number; binary: boolean }> {
    const safePath = validateReviewPath(filePath);
    const absolute = path.resolve(repository.root, safePath);
    const fileStat = await lstat(absolute).catch(() => undefined);
    if (!fileStat || !fileStat.isFile() || fileStat.isSymbolicLink()) {
      return { patch: '', insertions: 0, binary: false };
    }
    const resolved = await realpath(absolute);
    if (!isInside(repository.root, resolved)) {
      throw new McpError(
        JsonRpcErrorCode.Forbidden,
        'Changed file symlink escapes the repository.',
        { path: safePath },
      );
    }
    const handle = await open(resolved, 'r');
    const buffer = Buffer.alloc(Math.min(fileStat.size, byteLimit) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    await handle.close();
    const contentBuffer = buffer.subarray(0, bytesRead);
    if (contentBuffer.includes(0))
      return { patch: '', insertions: 0, binary: true };
    const content = contentBuffer.toString('utf8');
    const lines = content.split('\n');
    const body = lines.map((line) => `+${line}`).join('\n');
    return {
      patch: `diff --git a/${safePath} b/${safePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${safePath}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`,
      insertions: lines.length,
      binary: false,
    };
  }

  async diff(
    input: ReviewDiffInput,
    context: ReviewOperationContext,
  ): Promise<ReviewDiffResult> {
    const repository = await this.#resolveRepository(input.repository);
    const before = await this.#snapshot(repository);
    this.#assertExpectedSnapshot(input.expectedSnapshotId, before.id);
    let paths: string[] = [];
    let patchArgs: string[] = [];
    let statArgs: string[] = [];
    let base: ReviewCommitSummary | undefined;
    let head: ReviewCommitSummary | undefined;
    let includeUntracked = false;

    if (
      input.scope === 'working' ||
      input.scope === 'staged' ||
      input.scope === 'unstaged'
    ) {
      base = await this.#commitSummary(repository.root, before.headSha);
      paths =
        input.scope === 'working'
          ? uniqueSorted([
              ...before.status.staged,
              ...before.status.unstaged,
              ...before.status.untracked,
            ])
          : input.scope === 'staged'
            ? before.status.staged
            : before.status.unstaged;
      includeUntracked = input.scope === 'working';
      const tracked = paths.filter(
        (value) => !before.status.untracked.includes(value),
      );
      patchArgs =
        input.scope === 'staged'
          ? [...SAFE_DIFF_FLAGS, '--cached', 'HEAD', '--']
          : input.scope === 'working'
            ? [...SAFE_DIFF_FLAGS, 'HEAD', '--']
            : [...SAFE_DIFF_FLAGS, '--'];
      statArgs = [...patchArgs];
      paths = uniqueSorted([
        ...tracked,
        ...(includeUntracked ? before.status.untracked : []),
      ]);
    } else if (input.scope === 'last_commit' || input.scope === 'commit') {
      const requested = input.scope === 'last_commit' ? 'HEAD' : input.revision;
      if (!requested) {
        throw new McpError(
          JsonRpcErrorCode.ValidationError,
          'revision is required for commit scope.',
        );
      }
      const revision = await this.#resolveRevision(repository.root, requested);
      head = await this.#commitSummary(repository.root, revision);
      const parentResult = await this.#runGit(
        'rev-parse',
        ['--verify', `${revision}^`],
        repository.root,
        true,
      );
      if (parentResult.exitCode === 0)
        base = await this.#commitSummary(
          repository.root,
          parentResult.stdout.trim(),
        );
      paths = await this.#revisionPaths(repository.root, revision);
      patchArgs = ['--format=', '--patch', ...SAFE_DIFF_FLAGS, revision, '--'];
      statArgs = ['--format=', '--numstat', ...SAFE_DIFF_FLAGS, revision, '--'];
    } else {
      if (!input.baseRevision || !input.headRevision) {
        throw new McpError(
          JsonRpcErrorCode.ValidationError,
          'baseRevision and headRevision are required for range scope.',
        );
      }
      const baseSha = await this.#resolveRevision(
        repository.root,
        input.baseRevision,
      );
      const headSha = await this.#resolveRevision(
        repository.root,
        input.headRevision,
      );
      base = await this.#commitSummary(repository.root, baseSha);
      head = await this.#commitSummary(repository.root, headSha);
      const names = await this.#runGit(
        'diff',
        [
          ...SAFE_DIFF_FLAGS,
          '--name-only',
          '-z',
          '--no-renames',
          baseSha,
          headSha,
          '--',
        ],
        repository.root,
      );
      paths = uniqueSorted(names.stdout.split('\0').filter(Boolean));
      patchArgs = [...SAFE_DIFF_FLAGS, baseSha, headSha, '--'];
      statArgs = [...SAFE_DIFF_FLAGS, baseSha, headSha, '--'];
    }

    const omittedSecretPaths = paths.filter(isBlockedSecretPath);
    const safePaths = paths.filter((value) => !isBlockedSecretPath(value));
    const trackedSafePaths = safePaths.filter(
      (value) => !before.status.untracked.includes(value),
    );
    let patch = '';
    let statOutput = '';
    if (trackedSafePaths.length > 0) {
      const patchCommand =
        input.scope === 'last_commit' || input.scope === 'commit'
          ? 'show'
          : 'diff';
      const [patchResult, statResult] = await Promise.all([
        this.#runGit(
          patchCommand,
          [...patchArgs, ...trackedSafePaths],
          repository.root,
        ),
        this.#runGit(
          patchCommand,
          input.scope === 'last_commit' || input.scope === 'commit'
            ? [...statArgs, ...trackedSafePaths]
            : ['--numstat', ...statArgs, ...trackedSafePaths],
          repository.root,
        ),
      ]);
      patch = patchResult.stdout;
      statOutput = statResult.stdout;
    }
    const diffStat: ReviewDiffStat = {
      filesChanged: safePaths.length,
      insertions: 0,
      deletions: 0,
      binaryFiles: 0,
    };
    for (const line of statOutput.split('\n')) {
      const [added, deleted] = line.split('\t');
      if (added === '-' || deleted === '-') diffStat.binaryFiles += 1;
      else {
        diffStat.insertions += Number(added) || 0;
        diffStat.deletions += Number(deleted) || 0;
      }
    }
    if (includeUntracked) {
      for (const untrackedPath of before.status.untracked.filter(
        (value) => !isBlockedSecretPath(value),
      )) {
        const untracked = await this.#readCurrentFileForPatch(
          repository,
          untrackedPath,
          input.maxPatchBytes,
        );
        patch += untracked.patch;
        diffStat.insertions += untracked.insertions;
        if (untracked.binary) diffStat.binaryFiles += 1;
      }
    }
    const redacted = redactCredentials(patch);
    const bounded = truncateUtf8(redacted.content, input.maxPatchBytes);
    const after = await this.#snapshot(repository);
    if (after.id !== before.id)
      this.#assertExpectedSnapshot(before.id, after.id);
    logger.debug('Read repository review diff', {
      ...context.requestContext,
      repository: repository.identifier,
      scope: input.scope,
      filesChanged: paths.length,
    });
    return {
      repository: repository.identifier,
      scope: input.scope,
      snapshotId: before.id,
      ...(base ? { base } : {}),
      ...(head ? { head } : {}),
      changedFiles: paths.slice(0, MAX_STATUS_FILES),
      changedFilesTruncated: paths.length > MAX_STATUS_FILES,
      totalChangedFiles: paths.length,
      omittedSecretPaths: omittedSecretPaths.slice(0, MAX_STATUS_FILES),
      diffStat,
      patch: bounded.value,
      truncation: {
        truncated: bounded.truncated,
        maxBytes: input.maxPatchBytes,
        originalBytes: bounded.originalBytes,
        returnedBytes: bounded.returnedBytes,
      },
    };
  }

  async log(
    input: ReviewLogInput,
    context: ReviewOperationContext,
  ): Promise<ReviewLogResult> {
    const repository = await this.#resolveRepository(input.repository);
    const result = await this.#runGit(
      'log',
      [`--max-count=${input.limit}`, '--format=%H%x00%aI%x00%an%x00%s%x00'],
      repository.root,
    );
    const values = result.stdout.split('\0');
    const commits: ReviewCommitSummary[] = [];
    for (let index = 0; index + 3 < values.length; index += 4) {
      const sha = values[index]?.trimStart();
      if (!sha) continue;
      commits.push({
        sha,
        authorDate: values[index + 1] ?? '',
        ...(input.includeAuthorName && values[index + 2]
          ? { authorName: values[index + 2] }
          : {}),
        subject: values[index + 3] ?? '',
      });
    }
    logger.debug('Read bounded repository history', {
      ...context.requestContext,
      repository: repository.identifier,
      commits: commits.length,
    });
    return { repository: repository.identifier, commits, limit: input.limit };
  }

  #readBoundedText(
    buffer: Buffer,
    originalBytes: number,
    byteLimit: number,
    lineLimit: number,
  ): Omit<ReviewFileResult, 'repository' | 'path'> {
    if (
      buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0) ||
      !isUtf8(buffer)
    ) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        'Binary files are not reviewable as text.',
      );
    }
    const byteBounded = truncateUtf8(buffer.toString('utf8'), byteLimit);
    const allLines = byteBounded.value.split('\n');
    const returnedLines = allLines.slice(0, lineLimit);
    const lineTruncated = allLines.length > lineLimit;
    const joined = returnedLines.join('\n');
    const redacted = redactCredentials(joined);
    return {
      content: redacted.content,
      redacted: redacted.count > 0,
      redactionCount: redacted.count,
      truncation: {
        truncated: byteBounded.truncated || lineTruncated,
        byteLimit,
        lineLimit,
        originalBytes,
        returnedBytes: Buffer.byteLength(redacted.content),
        ...(!byteBounded.truncated ? { originalLines: allLines.length } : {}),
        returnedLines: returnedLines.length,
      },
    };
  }

  async changedFile(
    input: ReviewFileInput,
    context: ReviewOperationContext,
  ): Promise<ReviewFileResult> {
    const repository = await this.#resolveRepository(input.repository);
    const safePath = validateReviewPath(input.path);
    if (isBlockedSecretPath(safePath)) {
      throw new McpError(
        JsonRpcErrorCode.Forbidden,
        'Secret or credential paths cannot be read.',
        { path: safePath },
      );
    }
    const before = await this.#snapshot(repository);
    this.#assertExpectedSnapshot(input.expectedSnapshotId, before.id);
    const changed = new Set([
      ...before.status.staged,
      ...before.status.unstaged,
      ...before.status.untracked,
      ...before.status.conflicts,
    ]);
    if (!changed.has(safePath)) {
      throw new McpError(
        JsonRpcErrorCode.Forbidden,
        'Path is not present in the current changed-file set.',
        { path: safePath },
      );
    }
    const absolute = path.resolve(repository.root, safePath);
    const fileStat = await lstat(absolute).catch(() => {
      throw new McpError(
        JsonRpcErrorCode.NotFound,
        'Changed file is not present in the working tree.',
        { path: safePath },
      );
    });
    if (fileStat.isSymbolicLink()) {
      throw new McpError(
        JsonRpcErrorCode.Forbidden,
        'Symbolic-link file reads are not permitted.',
        { path: safePath },
      );
    }
    if (!fileStat.isFile()) {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        'Changed path is not a regular file.',
        { path: safePath },
      );
    }
    const resolved = await realpath(absolute);
    if (!isInside(repository.root, resolved)) {
      throw new McpError(
        JsonRpcErrorCode.Forbidden,
        'Changed file resolves outside the repository.',
        { path: safePath },
      );
    }
    const handle = await open(resolved, 'r');
    const buffer = Buffer.alloc(Math.min(fileStat.size, input.byteLimit) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    await handle.close();
    const output = this.#readBoundedText(
      buffer.subarray(0, bytesRead),
      fileStat.size,
      input.byteLimit,
      input.lineLimit,
    );
    const after = await this.#snapshot(repository);
    if (after.id !== before.id)
      this.#assertExpectedSnapshot(before.id, after.id);
    logger.debug('Read current changed file', {
      ...context.requestContext,
      repository: repository.identifier,
      path: safePath,
    });
    return {
      repository: repository.identifier,
      path: safePath,
      snapshotId: before.id,
      ...output,
    };
  }

  async fileAtRevision(
    input: ReviewFileAtRevisionInput,
    context: ReviewOperationContext,
  ): Promise<ReviewFileResult> {
    const repository = await this.#resolveRepository(input.repository);
    const safePath = validateReviewPath(input.path);
    if (isBlockedSecretPath(safePath)) {
      throw new McpError(
        JsonRpcErrorCode.Forbidden,
        'Secret or credential paths cannot be read.',
        { path: safePath },
      );
    }
    const revision = await this.#resolveRevision(
      repository.root,
      input.revision,
    );
    const object = `${revision}:${safePath}`;
    const [typeResult, sizeResult] = await Promise.all([
      this.#runGit('cat-file', ['-t', object], repository.root),
      this.#runGit('cat-file', ['-s', object], repository.root),
    ]);
    if (typeResult.stdout.trim() !== 'blob') {
      throw new McpError(
        JsonRpcErrorCode.ValidationError,
        'Revision path does not resolve to a file blob.',
        { path: safePath, revision },
      );
    }
    const blobSize = Number(sizeResult.stdout.trim());
    const [blobShaResult, contentResult] = await Promise.all([
      this.#runGit('rev-parse', ['--verify', object], repository.root),
      this.#runGit('show', [object], repository.root),
    ]);
    const output = this.#readBoundedText(
      contentResult.stdoutBuffer,
      blobSize,
      input.byteLimit,
      input.lineLimit,
    );
    logger.debug('Read file at safe revision', {
      ...context.requestContext,
      repository: repository.identifier,
      path: safePath,
      revision,
    });
    return {
      repository: repository.identifier,
      path: safePath,
      revision,
      blobSha: blobShaResult.stdout.trim(),
      blobSize,
      ...output,
    };
  }
}
