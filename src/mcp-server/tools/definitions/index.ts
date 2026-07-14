/** @fileoverview Exact public Repo Review MCP tool surface. @module mcp-server/tools/definitions */
import { reviewChangedFileTool } from './review-changed-file.tool.js';
import { reviewDiffTool } from './review-diff.tool.js';
import { reviewFileAtRevisionTool } from './review-file-at-revision.tool.js';
import { reviewLogTool } from './review-log.tool.js';
import { reviewStatusTool } from './review-status.tool.js';

export const allToolDefinitions = [
  reviewStatusTool,
  reviewDiffTool,
  reviewLogTool,
  reviewChangedFileTool,
  reviewFileAtRevisionTool,
];
