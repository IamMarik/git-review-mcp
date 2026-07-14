/**
 * @fileoverview Secure current-file startup capability tests.
 * @module tests/services/git/providers/cli/secureCurrentFile
 */

import { constants } from 'node:fs';
import { mkdtemp, open, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertSecureCurrentFileReadCapability } from '@/services/git/providers/cli/secureCurrentFile.js';

function supportedDescriptorIo() {
  let openedPath: string | undefined;
  return {
    open: async (filePath: string, flags: number) => {
      openedPath = filePath;
      return await open(filePath, flags);
    },
    descriptorPaths: (fd: number) => [
      `/unavailable-descriptor/${fd}`,
      `/test-descriptor/${fd}`,
    ],
    realpath: async (filePath: string) =>
      filePath.startsWith('/test-descriptor/') && openedPath !== undefined
        ? await realpath(openedPath)
        : await realpath(filePath),
  };
}

async function doesNotExist(filePath: string): Promise<boolean> {
  return await stat(filePath)
    .then(() => false)
    .catch(() => true);
}

describe('secure current-file startup capability', () => {
  it('reports success when no-follow and descriptor containment work', async () => {
    await expect(
      assertSecureCurrentFileReadCapability(supportedDescriptorIo()),
    ).resolves.toEqual({ supported: true });
  });

  it('fails with a structured reason when O_NOFOLLOW is missing', async () => {
    let openCalled = false;

    await expect(
      assertSecureCurrentFileReadCapability({
        noFollowFlag: undefined,
        open: async (filePath, flags) => {
          openCalled = true;
          return await open(filePath, flags);
        },
      }),
    ).rejects.toMatchObject({
      code: -32009,
      data: {
        reason: 'no_follow_unavailable',
      },
      message: expect.stringMatching(/host platform.*no-follow/i),
    });
    expect(openCalled).toBe(false);
  });

  it('fails with a structured reason when descriptor paths are unavailable', async () => {
    await expect(
      assertSecureCurrentFileReadCapability({
        descriptorPaths: () => [],
      }),
    ).rejects.toMatchObject({
      code: -32009,
      data: {
        reason: 'descriptor_path_unavailable',
      },
      message: expect.stringMatching(/host platform.*descriptor/i),
    });
  });

  it('removes the temporary probe after a successful check', async () => {
    let temporaryDirectory = '';
    let cleanupCalls = 0;
    let closeCalls = 0;
    const descriptorIo = supportedDescriptorIo();

    await assertSecureCurrentFileReadCapability({
      ...descriptorIo,
      open: async (filePath, flags) => {
        const handle = await descriptorIo.open(filePath, flags);
        return {
          fd: handle.fd,
          stat: () => handle.stat(),
          read: (buffer, offset, length, position) =>
            handle.read(buffer, offset, length, position),
          close: async () => {
            closeCalls += 1;
            await handle.close();
          },
        };
      },
      createTemporaryDirectory: async () => {
        temporaryDirectory = await mkdtemp(
          path.join(tmpdir(), 'repo-review-capability-success-'),
        );
        return temporaryDirectory;
      },
      removeTemporaryDirectory: async (directory) => {
        cleanupCalls += 1;
        await rm(directory, { force: true, recursive: true });
      },
    });

    expect(cleanupCalls).toBe(1);
    expect(closeCalls).toBe(1);
    expect(await doesNotExist(temporaryDirectory)).toBe(true);
  });

  it('removes the temporary probe after a failed check', async () => {
    let temporaryDirectory = '';
    let cleanupCalls = 0;

    await expect(
      assertSecureCurrentFileReadCapability({
        descriptorPaths: () => [],
        createTemporaryDirectory: async () => {
          temporaryDirectory = await mkdtemp(
            path.join(tmpdir(), 'repo-review-capability-failure-'),
          );
          return temporaryDirectory;
        },
        removeTemporaryDirectory: async (directory) => {
          cleanupCalls += 1;
          await rm(directory, { force: true, recursive: true });
        },
      }),
    ).rejects.toMatchObject({
      data: { reason: 'descriptor_path_unavailable' },
    });

    expect(cleanupCalls).toBe(1);
    expect(await doesNotExist(temporaryDirectory)).toBe(true);
  });

  it('uses numeric read-only no-follow flags and has no ordinary-open fallback', async () => {
    let openedFlags: number | undefined;
    let openedPath: string | undefined;

    await assertSecureCurrentFileReadCapability({
      open: async (filePath, flags) => {
        openedFlags = flags;
        openedPath = filePath;
        return await open(filePath, flags);
      },
      descriptorPaths: (fd) => [`/test-descriptor/${fd}`],
      realpath: async (filePath) =>
        filePath.startsWith('/test-descriptor/') && openedPath !== undefined
          ? await realpath(openedPath)
          : await realpath(filePath),
    });

    expect(openedFlags).toBeTypeOf('number');
    expect((openedFlags ?? 0) & constants.O_NOFOLLOW).toBe(
      constants.O_NOFOLLOW,
    );
    expect((openedFlags ?? 0) & constants.O_WRONLY).toBe(0);
    expect((openedFlags ?? 0) & constants.O_RDWR).toBe(0);
  });

  it('closes its descriptor when capability validation fails', async () => {
    let closeCalls = 0;

    await expect(
      assertSecureCurrentFileReadCapability({
        descriptorPaths: () => [],
        open: async (filePath, flags) => {
          const handle = await open(filePath, flags);
          return {
            fd: handle.fd,
            stat: () => handle.stat(),
            read: (buffer, offset, length, position) =>
              handle.read(buffer, offset, length, position),
            close: async () => {
              closeCalls += 1;
              await handle.close();
            },
          };
        },
      }),
    ).rejects.toMatchObject({
      data: { reason: 'descriptor_path_unavailable' },
    });

    expect(closeCalls).toBe(1);
  });
});
