/**
 * @fileoverview Fail-closed platform primitives for secure current-file reads.
 * @module services/git/providers/cli/secureCurrentFile
 */

import { constants, type Stats } from 'node:fs';
import { mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { JsonRpcErrorCode, McpError } from '@/types-global/errors.js';

export type SecureCurrentFileCapabilityReason =
  | 'no_follow_unavailable'
  | 'descriptor_path_unavailable'
  | 'temporary_probe_unavailable'
  | 'temporary_probe_cleanup_failed';

export interface SecureCurrentFileHandle {
  readonly fd: number;
  stat(): Promise<Stats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number; buffer: Buffer }>;
  close(): Promise<void>;
}

export interface SecureCurrentFileIo {
  noFollowFlag: number | undefined;
  open(filePath: string, flags: number): Promise<SecureCurrentFileHandle>;
  realpath(filePath: string): Promise<string>;
  descriptorPaths(fd: number): readonly string[];
}

interface SecureCurrentFileCapabilityIo extends SecureCurrentFileIo {
  createTemporaryDirectory(): Promise<string>;
  createProbeFile(directory: string): Promise<string>;
  removeTemporaryDirectory(directory: string): Promise<void>;
}

export interface SecureCurrentFileCapabilityResult {
  supported: true;
}

export const DEFAULT_SECURE_CURRENT_FILE_IO: SecureCurrentFileIo = {
  noFollowFlag: constants.O_NOFOLLOW,
  open: async (filePath, flags) => await open(filePath, flags),
  realpath,
  descriptorPaths: (fd) => [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`],
};

const DEFAULT_CAPABILITY_IO: SecureCurrentFileCapabilityIo = {
  ...DEFAULT_SECURE_CURRENT_FILE_IO,
  createTemporaryDirectory: async () =>
    await mkdtemp(path.join(tmpdir(), 'repo-review-secure-read-')),
  createProbeFile: async (directory) => {
    const probePath = path.join(directory, 'probe');
    await writeFile(probePath, 'secure-current-file-read-probe\n', {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return probePath;
  },
  removeTemporaryDirectory: async (directory) => {
    await rm(directory, { force: true, recursive: true });
  },
};

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

export function secureCurrentFileError(
  code:
    JsonRpcErrorCode.ServiceUnavailable | JsonRpcErrorCode.InitializationFailed,
  reason: SecureCurrentFileCapabilityReason,
  safePath?: string,
): McpError {
  const detail =
    reason === 'no_follow_unavailable'
      ? 'a usable no-follow open flag'
      : reason === 'descriptor_path_unavailable'
        ? 'opened-descriptor containment verification'
        : reason === 'temporary_probe_cleanup_failed'
          ? 'safe cleanup of its capability probe'
          : 'a temporary capability probe';
  return new McpError(
    code,
    `The host platform cannot provide ${detail} required for secure current-file reads by Repo Review MCP.`,
    {
      reason,
      platform: process.platform,
      ...(safePath === undefined ? {} : { path: safePath }),
    },
  );
}

export function secureReadOnlyFlags(io: SecureCurrentFileIo): number {
  if (
    typeof io.noFollowFlag !== 'number' ||
    !Number.isInteger(io.noFollowFlag) ||
    io.noFollowFlag <= 0
  ) {
    throw secureCurrentFileError(
      JsonRpcErrorCode.ServiceUnavailable,
      'no_follow_unavailable',
    );
  }
  return (
    constants.O_RDONLY |
    io.noFollowFlag |
    (typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0)
  );
}

export async function resolveOpenedDescriptorPaths(
  handle: SecureCurrentFileHandle,
  io: SecureCurrentFileIo,
): Promise<string[]> {
  const resolvedPaths: string[] = [];
  for (const candidate of io.descriptorPaths(handle.fd)) {
    const resolved = await io.realpath(candidate).catch(() => undefined);
    if (resolved !== undefined) resolvedPaths.push(resolved);
  }
  return resolvedPaths;
}

/**
 * Verifies at startup that the host can enforce secure current-file reads.
 *
 * @internal The override seam exists only for deterministic capability tests.
 */
export async function assertSecureCurrentFileReadCapability(
  overrides: Partial<SecureCurrentFileCapabilityIo> = {},
): Promise<SecureCurrentFileCapabilityResult> {
  const io = { ...DEFAULT_CAPABILITY_IO, ...overrides };
  let temporaryDirectory: string | undefined;
  let handle: SecureCurrentFileHandle | undefined;
  let cleanupRequired = false;

  try {
    let flags: number;
    try {
      flags = secureReadOnlyFlags(io);
    } catch {
      throw secureCurrentFileError(
        JsonRpcErrorCode.InitializationFailed,
        'no_follow_unavailable',
      );
    }

    temporaryDirectory = await io.createTemporaryDirectory().catch(() => {
      throw secureCurrentFileError(
        JsonRpcErrorCode.InitializationFailed,
        'temporary_probe_unavailable',
      );
    });
    cleanupRequired = true;
    const expectedDirectory = await io
      .realpath(temporaryDirectory)
      .catch(() => {
        throw secureCurrentFileError(
          JsonRpcErrorCode.InitializationFailed,
          'temporary_probe_unavailable',
        );
      });
    const probePath = await io.createProbeFile(temporaryDirectory).catch(() => {
      throw secureCurrentFileError(
        JsonRpcErrorCode.InitializationFailed,
        'temporary_probe_unavailable',
      );
    });
    const expectedProbePath = await io.realpath(probePath).catch(() => {
      throw secureCurrentFileError(
        JsonRpcErrorCode.InitializationFailed,
        'temporary_probe_unavailable',
      );
    });

    try {
      handle = await io.open(expectedProbePath, flags);
    } catch (error) {
      const code = errorCode(error);
      throw secureCurrentFileError(
        JsonRpcErrorCode.InitializationFailed,
        code === 'EINVAL' || code === 'ENOTSUP' || code === 'EOPNOTSUPP'
          ? 'no_follow_unavailable'
          : 'temporary_probe_unavailable',
      );
    }

    const openedStat = await handle.stat().catch(() => undefined);
    if (!openedStat?.isFile()) {
      throw secureCurrentFileError(
        JsonRpcErrorCode.InitializationFailed,
        'temporary_probe_unavailable',
      );
    }
    const descriptorPaths = await resolveOpenedDescriptorPaths(handle, io);
    const verifiedDescriptorPath = descriptorPaths.find(
      (descriptorPath) =>
        isInside(expectedDirectory, descriptorPath) &&
        descriptorPath === expectedProbePath,
    );
    if (verifiedDescriptorPath === undefined) {
      throw secureCurrentFileError(
        JsonRpcErrorCode.InitializationFailed,
        'descriptor_path_unavailable',
      );
    }

    return { supported: true };
  } finally {
    let cleanupFailed = false;
    if (handle !== undefined) {
      await handle.close().catch(() => {
        cleanupFailed = true;
      });
    }
    if (cleanupRequired && temporaryDirectory !== undefined) {
      await io.removeTemporaryDirectory(temporaryDirectory).catch(() => {
        cleanupFailed = true;
      });
    }
    if (cleanupFailed) {
      throw secureCurrentFileError(
        JsonRpcErrorCode.InitializationFailed,
        'temporary_probe_cleanup_failed',
      );
    }
  }
}
