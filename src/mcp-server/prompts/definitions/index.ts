/**
 * @fileoverview Barrel file for all prompt definitions.
 * This file re-exports all prompt definitions for easy import and registration.
 * @module src/mcp-server/prompts/definitions
 */

/**
 * An array containing all prompt definitions for easy iteration.
 */
import type { PromptDefinition } from '../utils/promptDefinition.js';
import type { ZodObject, ZodRawShape } from 'zod';

export const allPromptDefinitions: PromptDefinition<ZodObject<ZodRawShape>>[] =
  [];
