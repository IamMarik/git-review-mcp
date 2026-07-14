/** @fileoverview Exact Repo Review MCP public surface tests. @module tests/mcp-server/tools/review-surface */
import { describe, expect, it } from 'vitest';

import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { reviewDiffTool } from '@/mcp-server/tools/definitions/review-diff.tool.js';
import { reviewLogTool } from '@/mcp-server/tools/definitions/review-log.tool.js';
import { allPromptDefinitions } from '@/mcp-server/prompts/definitions/index.js';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';

describe('public review surface', () => {
  it('exposes exactly the five review tools', () => {
    expect(allToolDefinitions.map((tool) => tool.name)).toEqual([
      'review_status',
      'review_diff',
      'review_log',
      'review_changed_file',
      'review_file_at_revision',
    ]);
    expect(
      allToolDefinitions.every(
        (tool) => tool.annotations?.readOnlyHint === true,
      ),
    ).toBe(true);
    expect(allPromptDefinitions).toEqual([]);
    expect(allResourceDefinitions).toEqual([]);
  });

  it('enforces diff scope and log caps at the MCP boundary', () => {
    expect(
      reviewDiffTool.inputSchema.safeParse({
        repository: '.',
        scope: 'anything',
      }).success,
    ).toBe(false);
    expect(
      reviewDiffTool.inputSchema.safeParse({ repository: '.', scope: 'commit' })
        .success,
    ).toBe(false);
    expect(
      reviewDiffTool.inputSchema.safeParse({
        repository: '.',
        scope: 'commit',
        revision: 'HEAD',
      }).success,
    ).toBe(true);
    expect(
      reviewLogTool.inputSchema.safeParse({ repository: '.', limit: 101 })
        .success,
    ).toBe(false);
    expect(reviewLogTool.inputSchema.parse({ repository: '.' }).limit).toBe(20);
  });
});
