/**
 * @fileoverview Standard MCP handlers and read-only review dependency injection.
 * @module mcp-server/tools/utils/toolHandlerFactory
 */
import { container } from 'tsyringe';

import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type {
  CallToolResult,
  ContentBlock,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

import { ReviewProvider as ReviewProviderToken } from '@/container/tokens.js';
import type { SdkContext } from '@/mcp-server/tools/utils/toolDefinition.js';
import type { IReviewProvider } from '@/services/git/core/IReviewProvider.js';
import { McpError } from '@/types-global/errors.js';
import {
  ErrorHandler,
  logger,
  measureToolExecution,
  requestContextService,
  type RequestContext,
} from '@/utils/index.js';

function validateSdkContext(ctx: unknown): ctx is SdkContext {
  if (typeof ctx !== 'object' || ctx === null) return false;
  const value = ctx as Record<string, unknown>;
  if (
    value.signal !== undefined &&
    value.signal !== null &&
    (typeof value.signal !== 'object' ||
      !('aborted' in value.signal) ||
      typeof (value.signal as { addEventListener?: unknown })
        .addEventListener !== 'function')
  ) {
    return false;
  }
  return (
    (value.sendNotification === undefined ||
      typeof value.sendNotification === 'function') &&
    (value.sendRequest === undefined ||
      typeof value.sendRequest === 'function') &&
    (value.authInfo === undefined ||
      value.authInfo === null ||
      typeof value.authInfo === 'object')
  );
}

const defaultResponseFormatter = (result: unknown): ContentBlock[] => [
  { type: 'text', text: JSON.stringify(result, null, 2) },
];

export type ToolHandlerFactoryOptions<
  TInputSchema extends AnySchema,
  TOutput extends Record<string, unknown>,
> = {
  toolName: string;
  inputSchema: TInputSchema;
  logic: (
    input: z.infer<TInputSchema>,
    appContext: RequestContext,
    sdkContext: SdkContext,
  ) => Promise<TOutput>;
  responseFormatter?: (result: TOutput) => ContentBlock[];
};

/** Wrap tool logic with context, measurement, formatting, and error handling. */
export function createMcpToolHandler<
  TInputSchema extends AnySchema,
  TOutput extends Record<string, unknown>,
>({
  toolName,
  logic,
  responseFormatter = defaultResponseFormatter,
}: ToolHandlerFactoryOptions<TInputSchema, TOutput>): (
  input: z.infer<TInputSchema>,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) => Promise<CallToolResult> {
  return async (input, extra): Promise<CallToolResult> => {
    if (!validateSdkContext(extra) && process.stderr?.isTTY) {
      console.warn(`[${toolName}] Invalid SDK context received.`);
    }
    const sdkContext = extra;
    const sessionId =
      typeof sdkContext?.sessionId === 'string'
        ? sdkContext.sessionId
        : undefined;
    const appContext = requestContextService.createRequestContext({
      parentContext: sdkContext,
      operation: 'HandleToolRequest',
      additionalContext: { toolName, sessionId, input },
    });
    try {
      const result = await measureToolExecution(
        () => logic(input, appContext, sdkContext),
        { ...appContext, toolName },
        input,
      );
      return { structuredContent: result, content: responseFormatter(result) };
    } catch (error) {
      logger.error('Tool execution failed', {
        ...appContext,
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      const mcpError = ErrorHandler.handleError(error, {
        operation: `tool:${toolName}`,
        context: appContext,
        input,
      }) as McpError;
      return {
        isError: true,
        content: [{ type: 'text', text: `Error: ${mcpError.message}` }],
      };
    }
  };
}

export interface ToolLogicDependencies {
  provider: IReviewProvider;
  appContext: RequestContext;
  sdkContext: SdkContext;
}

export type CoreToolLogic<TInput, TOutput> = (
  input: TInput,
  deps: ToolLogicDependencies,
) => Promise<TOutput>;

/** Inject the typed read-only provider; no mutable path/session state is resolved. */
export function createToolHandler<TInput, TOutput>(
  coreLogic: CoreToolLogic<TInput, TOutput>,
): (
  input: TInput,
  appContext: RequestContext,
  sdkContext: SdkContext,
) => Promise<TOutput> {
  let provider: IReviewProvider | undefined;
  return async (input, appContext, sdkContext) => {
    provider ??= container.resolve<IReviewProvider>(ReviewProviderToken);
    logger.debug('Executing read-only review tool', {
      ...appContext,
      inputKeys: typeof input === 'object' && input ? Object.keys(input) : [],
    });
    return coreLogic(input, { provider, appContext, sdkContext });
  };
}
