/**
 * @fileoverview Shared schemas for the read-only repository review API.
 * @module mcp-server/tools/schemas/review
 */
import { z } from 'zod';

export const RepositorySchema = z
  .string()
  .min(1)
  .max(500)
  .default('.')
  .describe('Relative repository path beneath REVIEW_BASE_DIR.');

export const RevisionSchema = z
  .string()
  .min(1)
  .max(256)
  .describe(
    'Safe revision: HEAD, HEAD^, HEAD~0..20, origin/<safe-branch>, or a 7-64 character hexadecimal commit SHA.',
  );

export const ExpectedSnapshotSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .optional()
  .describe('Expected snapshot ID; state drift fails with snapshot_changed.');

export const ByteLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(500_000)
  .default(100_000)
  .describe('Maximum UTF-8 bytes returned, from 1 through 500000.');

export const LineLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(10_000)
  .default(2_000)
  .describe('Maximum text lines returned, from 1 through 10000.');

export const CommitSummarySchema = z
  .object({
    sha: z.string().describe('Full commit SHA.'),
    subject: z.string().describe('Commit subject line.'),
    authorDate: z.string().describe('Author date in ISO 8601 form.'),
    authorName: z
      .string()
      .optional()
      .describe('Author name when requested or relevant.'),
  })
  .describe('Bounded commit metadata.');

export const FileTruncationSchema = z
  .object({
    truncated: z.boolean().describe('Whether any content was omitted.'),
    byteLimit: z.number().int().describe('Applied byte limit.'),
    lineLimit: z.number().int().describe('Applied line limit.'),
    originalBytes: z
      .number()
      .int()
      .describe('Original blob or file byte size.'),
    returnedBytes: z
      .number()
      .int()
      .describe('UTF-8 bytes returned after redaction.'),
    originalLines: z
      .number()
      .int()
      .optional()
      .describe(
        'Original line count when the byte boundary allowed it to be known.',
      ),
    returnedLines: z.number().int().describe('Number of lines returned.'),
  })
  .describe('File content truncation details.');

export const ReviewFileOutputSchema = z.object({
  repository: z
    .string()
    .describe('Repository identifier relative to REVIEW_BASE_DIR.'),
  path: z.string().describe('Validated repository-relative file path.'),
  content: z
    .string()
    .describe('Bounded text content with credential redaction applied.'),
  redacted: z
    .boolean()
    .describe('Whether obvious credential values were redacted.'),
  redactionCount: z
    .number()
    .int()
    .describe('Number of credential values redacted.'),
  snapshotId: z
    .string()
    .optional()
    .describe('Working-tree snapshot ID for a current changed file.'),
  revision: z
    .string()
    .optional()
    .describe('Resolved full revision SHA for historical content.'),
  blobSha: z
    .string()
    .optional()
    .describe('Git blob SHA for historical content.'),
  blobSize: z
    .number()
    .int()
    .optional()
    .describe('Original Git blob size in bytes.'),
  truncation: FileTruncationSchema,
});
