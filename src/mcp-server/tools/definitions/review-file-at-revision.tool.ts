/** @fileoverview Safe historical file reader. @module mcp-server/tools/definitions/review-file-at-revision */
import { z } from 'zod';

import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import {
  ByteLimitSchema,
  LineLimitSchema,
  RepositorySchema,
  ReviewFileOutputSchema,
  RevisionSchema,
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
      .describe('Validated repository-relative file path.'),
    revision: RevisionSchema,
    byteLimit: ByteLimitSchema,
    lineLimit: LineLimitSchema,
  })
  .strict();
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof ReviewFileOutputSchema>;

async function logic(
  input: Input,
  { provider, appContext }: ToolLogicDependencies,
): Promise<Output> {
  return provider.fileAtRevision(input, {
    requestContext: appContext,
    tenantId: appContext.tenantId || 'default-tenant',
  });
}

export const reviewFileAtRevisionTool: ToolDefinition<
  typeof InputSchema,
  typeof ReviewFileOutputSchema
> = {
  name: 'review_file_at_revision',
  title: 'Review File at Revision',
  description:
    'Read one bounded text blob from a strictly validated local revision and safe path.',
  inputSchema: InputSchema,
  outputSchema: ReviewFileOutputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  logic: withToolAuth(['tool:git:read'], createToolHandler(logic)),
  responseFormatter: createJsonFormatter<Output>(),
};
