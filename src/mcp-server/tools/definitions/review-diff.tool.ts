/** @fileoverview Bounded read-only review diff tool. @module mcp-server/tools/definitions/review-diff */
import { z } from 'zod';

import { withToolAuth } from '@/mcp-server/transports/auth/lib/withAuth.js';
import {
  CommitSummarySchema,
  ExpectedSnapshotSchema,
  RepositorySchema,
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
    scope: z
      .enum(['working', 'staged', 'unstaged', 'last_commit', 'commit', 'range'])
      .describe('Strict diff scope; arbitrary Git flags are not accepted.'),
    revision: RevisionSchema.optional().describe(
      'Required safe revision for commit scope.',
    ),
    baseRevision: RevisionSchema.optional().describe(
      'Required safe base revision for range scope.',
    ),
    headRevision: RevisionSchema.optional().describe(
      'Required safe head revision for range scope.',
    ),
    expectedSnapshotId: ExpectedSnapshotSchema,
    maxPatchBytes: z
      .number()
      .int()
      .min(1)
      .max(500_000)
      .default(200_000)
      .describe('Maximum patch bytes returned, from 1 through 500000.'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === 'commit' && !value.revision)
      ctx.addIssue({
        code: 'custom',
        path: ['revision'],
        message: 'revision is required for commit scope',
      });
    if (value.scope === 'range' && (!value.baseRevision || !value.headRevision))
      ctx.addIssue({
        code: 'custom',
        path: ['baseRevision'],
        message: 'baseRevision and headRevision are required for range scope',
      });
  });
const OutputSchema = z.object({
  repository: z
    .string()
    .describe('Repository identifier relative to REVIEW_BASE_DIR.'),
  scope: z
    .enum(['working', 'staged', 'unstaged', 'last_commit', 'commit', 'range'])
    .describe('Applied diff scope.'),
  snapshotId: z.string().describe('Snapshot ID used to produce this result.'),
  base: CommitSummarySchema.optional().describe(
    'Base commit metadata where relevant.',
  ),
  head: CommitSummarySchema.optional().describe(
    'Head commit metadata where relevant.',
  ),
  changedFiles: z
    .array(z.string())
    .describe('Changed paths, bounded to the status hard limit.'),
  changedFilesTruncated: z
    .boolean()
    .describe('Whether changedFiles hit the hard path limit.'),
  totalChangedFiles: z
    .number()
    .int()
    .describe('Total changed paths before the hard path limit.'),
  omittedSecretPaths: z
    .array(z.string())
    .describe('Changed secret paths omitted from patch content.'),
  diffStat: z
    .object({
      filesChanged: z
        .number()
        .int()
        .describe('Number of non-secret changed files represented.'),
      insertions: z
        .number()
        .int()
        .describe('Insertion count for represented text files.'),
      deletions: z
        .number()
        .int()
        .describe('Deletion count for represented text files.'),
      binaryFiles: z
        .number()
        .int()
        .describe('Binary file count for represented files.'),
    })
    .describe('Structured diff statistics.'),
  patch: z.string().describe('Bounded patch with credential values redacted.'),
  truncation: z
    .object({
      truncated: z.boolean().describe('Whether patch bytes were omitted.'),
      maxBytes: z.number().int().describe('Applied patch byte limit.'),
      originalBytes: z
        .number()
        .int()
        .describe('Patch bytes before truncation.'),
      returnedBytes: z.number().int().describe('Patch bytes returned.'),
    })
    .describe('Patch truncation metadata.'),
});
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

async function logic(
  input: Input,
  { provider, appContext }: ToolLogicDependencies,
): Promise<Output> {
  return provider.diff(
    {
      repository: input.repository,
      scope: input.scope,
      maxPatchBytes: input.maxPatchBytes,
      ...(input.revision ? { revision: input.revision } : {}),
      ...(input.baseRevision ? { baseRevision: input.baseRevision } : {}),
      ...(input.headRevision ? { headRevision: input.headRevision } : {}),
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

export const reviewDiffTool: ToolDefinition<
  typeof InputSchema,
  typeof OutputSchema
> = {
  name: 'review_diff',
  title: 'Review Diff',
  description:
    'Inspect one strict local diff scope with bounded, redacted patch output and snapshot drift detection.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  annotations: { readOnlyHint: true, openWorldHint: false },
  logic: withToolAuth(['tool:git:read'], createToolHandler(logic)),
  responseFormatter: createJsonFormatter<Output>(),
};
