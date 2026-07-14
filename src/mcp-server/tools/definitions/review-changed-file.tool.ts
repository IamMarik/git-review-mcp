/** @fileoverview Safe current changed-file reader. @module mcp-server/tools/definitions/review-changed-file */
import { z } from 'zod';

import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import {
  ByteLimitSchema,
  ExpectedSnapshotSchema,
  LineLimitSchema,
  RepositorySchema,
  ReviewFileOutputSchema,
} from '../schemas/review.js';
import type { ToolDefinition } from '../utils/toolDefinition.js';
import {
  createToolHandler,
  type ToolLogicDependencies,
} from '../utils/toolHandlerFactory.js';
import { createJsonFormatter } from '../utils/json-response-formatter.js';

const InputSchema = z
  .object({
    repository: RepositorySchema,
    path: z
      .string()
      .min(1)
      .max(1_000)
      .describe(
        'Repository-relative path that must be in the current changed-file set.',
      ),
    byteLimit: ByteLimitSchema,
    lineLimit: LineLimitSchema,
    expectedSnapshotId: ExpectedSnapshotSchema,
  })
  .strict();
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof ReviewFileOutputSchema>;

async function logic(
  input: Input,
  { provider, appContext }: ToolLogicDependencies,
): Promise<Output> {
  return provider.changedFile(
    {
      repository: input.repository,
      path: input.path,
      byteLimit: input.byteLimit,
      lineLimit: input.lineLimit,
      ...(input.expectedSnapshotId
        ? { expectedSnapshotId: input.expectedSnapshotId }
        : {}),
    },
    {
      requestContext: appContext,
      tenantId: appContext.tenantId || 'default-tenant',
    },
  );
}

export const reviewChangedFileTool: ToolDefinition<
  typeof InputSchema,
  typeof ReviewFileOutputSchema
> = {
  name: 'review_changed_file',
  title: 'Review Changed File',
  description:
    'Read bounded text from a current changed file after repository, symlink, binary, and secret-path checks.',
  inputSchema: InputSchema,
  outputSchema: ReviewFileOutputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  logic: withToolAuth(['tool:git:read'], createToolHandler(logic)),
  responseFormatter: createJsonFormatter<Output>(),
};
