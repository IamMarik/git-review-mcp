/**
 * @fileoverview Typed, read-only contract for repository review operations.
 * @module services/git/core/IReviewProvider
 */

import type {
  ReviewDiffInput,
  ReviewDiffResult,
  ReviewFileAtRevisionInput,
  ReviewFileInput,
  ReviewFileResult,
  ReviewLogInput,
  ReviewLogResult,
  ReviewOperationContext,
  ReviewStatusInput,
  ReviewStatusResult,
} from '../types.js';

/** No generic command or arbitrary argument execution is exposed by this API. */
export interface IReviewProvider {
  status(
    input: ReviewStatusInput,
    context: ReviewOperationContext,
  ): Promise<ReviewStatusResult>;
  diff(
    input: ReviewDiffInput,
    context: ReviewOperationContext,
  ): Promise<ReviewDiffResult>;
  log(
    input: ReviewLogInput,
    context: ReviewOperationContext,
  ): Promise<ReviewLogResult>;
  changedFile(
    input: ReviewFileInput,
    context: ReviewOperationContext,
  ): Promise<ReviewFileResult>;
  fileAtRevision(
    input: ReviewFileAtRevisionInput,
    context: ReviewOperationContext,
  ): Promise<ReviewFileResult>;
}
