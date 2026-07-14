/**
 * @fileoverview Read-only repository review service types.
 * @module services/git/types
 */

import type { RequestContext } from '@/utils/index.js';

export type ReviewDiffScope =
  'working' | 'staged' | 'unstaged' | 'last_commit' | 'commit' | 'range';

export interface ReviewOperationContext {
  requestContext: RequestContext;
  tenantId: string;
}

export interface ReviewStatusInput {
  repository: string;
}

export interface ReviewStatusResult {
  repository: string;
  branch: string | null;
  detached: boolean;
  headSha: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicts: string[];
  snapshotId: string;
  truncated: boolean;
  totalChangedFiles: number;
}

export interface ReviewCommitSummary {
  sha: string;
  subject: string;
  authorDate: string;
  authorName?: string;
}

export interface ReviewDiffInput {
  repository: string;
  scope: ReviewDiffScope;
  revision?: string;
  baseRevision?: string;
  headRevision?: string;
  expectedSnapshotId?: string;
  maxPatchBytes: number;
}

export interface ReviewDiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
  binaryFiles: number;
}

export interface ReviewDiffResult {
  repository: string;
  scope: ReviewDiffScope;
  snapshotId: string;
  base?: ReviewCommitSummary;
  head?: ReviewCommitSummary;
  changedFiles: string[];
  changedFilesTruncated: boolean;
  totalChangedFiles: number;
  omittedSecretPaths: string[];
  diffStat: ReviewDiffStat;
  patch: string;
  truncation: {
    truncated: boolean;
    maxBytes: number;
    originalBytes: number;
    returnedBytes: number;
  };
}

export interface ReviewLogInput {
  repository: string;
  limit: number;
  includeAuthorName: boolean;
}

export interface ReviewLogResult {
  repository: string;
  commits: ReviewCommitSummary[];
  limit: number;
}

export interface ReviewFileInput {
  repository: string;
  path: string;
  byteLimit: number;
  lineLimit: number;
  expectedSnapshotId?: string;
}

export interface ReviewFileAtRevisionInput extends ReviewFileInput {
  revision: string;
}

export interface ReviewFileResult {
  repository: string;
  path: string;
  content: string;
  redacted: boolean;
  redactionCount: number;
  snapshotId?: string;
  revision?: string;
  blobSha?: string;
  blobSize?: number;
  truncation: {
    truncated: boolean;
    byteLimit: number;
    lineLimit: number;
    originalBytes: number;
    returnedBytes: number;
    originalLines?: number;
    returnedLines: number;
  };
}
