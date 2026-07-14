/** @fileoverview Bounded read-only repository history tool. @module mcp-server/tools/definitions/review-log */
import { z } from 'zod';

import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import { CommitSummarySchema, RepositorySchema } from '../schemas/review.js';
import type { ToolDefinition } from '../utils/toolDefinition.js';
import {
  createToolHandler,
  type ToolLogicDependencies,
} from '../utils/toolHandlerFactory.js';
import { createJsonFormatter } from '../utils/json-response-formatter.js';

const InputSchema = z
  .object({
    repository: RepositorySchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Commit count, from 1 through the hard maximum of 100.'),
    includeAuthorName: z
      .boolean()
      .default(false)
      .describe(
        'Include author names already stored in local commit metadata.',
      ),
  })
  .strict();
const OutputSchema = z.object({
  repository: z
    .string()
    .describe('Repository identifier relative to REVIEW_BASE_DIR.'),
  commits: z
    .array(CommitSummarySchema)
    .describe('Recent commit summaries, newest first.'),
  limit: z.number().int().describe('Applied commit limit.'),
});
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

async function logic(
  input: Input,
  { provider, appContext }: ToolLogicDependencies,
): Promise<Output> {
  return provider.log(input, {
    requestContext: appContext,
    tenantId: appContext.tenantId || 'default-tenant',
  });
}

export const reviewLogTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  name: 'review_log',
  title: 'Review Log',
  description:
    'Return bounded structured summaries from local commit history; arbitrary formats and flags are not accepted.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  logic: withToolAuth(['tool:git:read'], createToolHandler(logic)),
  responseFormatter: createJsonFormatter<Output>(),
};
