/** @fileoverview Read-only repository status tool. @module mcp-server/tools/definitions/review-status */
import { z } from 'zod';

import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import { RepositorySchema } from '../schemas/review.js';
import type { ToolDefinition } from '../utils/toolDefinition.js';
import {
  createToolHandler,
  type ToolLogicDependencies,
} from '../utils/toolHandlerFactory.js';
import { createJsonFormatter } from '../utils/json-response-formatter.js';

const InputSchema = z.object({ repository: RepositorySchema }).strict();
const OutputSchema = z.object({
  repository: z
    .string()
    .describe('Repository identifier relative to REVIEW_BASE_DIR.'),
  branch: z
    .string()
    .nullable()
    .describe('Current branch, or null for detached HEAD.'),
  detached: z.boolean().describe('Whether HEAD is detached.'),
  headSha: z.string().describe('Full HEAD commit SHA.'),
  upstream: z
    .string()
    .optional()
    .describe('Configured local tracking upstream.'),
  ahead: z
    .number()
    .int()
    .optional()
    .describe('Local commits ahead of upstream without fetching.'),
  behind: z
    .number()
    .int()
    .optional()
    .describe('Local commits behind upstream without fetching.'),
  staged: z.array(z.string()).describe('Staged changed paths.'),
  unstaged: z.array(z.string()).describe('Unstaged changed paths.'),
  untracked: z.array(z.string()).describe('Untracked paths.'),
  conflicts: z.array(z.string()).describe('Paths with merge conflicts.'),
  snapshotId: z.string().describe('Deterministic current review snapshot ID.'),
  truncated: z
    .boolean()
    .describe('Whether any status path list hit its hard limit.'),
  totalChangedFiles: z
    .number()
    .int()
    .describe('Total unique changed paths before list limits.'),
});
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

async function logic(
  input: Input,
  { provider, appContext }: ToolLogicDependencies,
): Promise<Output> {
  return provider.status(input, {
    requestContext: appContext,
    tenantId: appContext.tenantId || 'default-tenant',
  });
}

export const reviewStatusTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  name: 'review_status',
  title: 'Review Status',
  description:
    'Inspect bounded local repository state without fetching or modifying the repository.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  logic: withToolAuth(['tool:git:read'], createToolHandler(logic)),
  responseFormatter: createJsonFormatter<Output>(),
};
