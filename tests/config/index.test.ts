/**
 * @fileoverview Unit tests for configuration parsing.
 * @module tests/config/index.test
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { JsonRpcErrorCode, McpError } from '../../src/types-global/errors.js';

const originalEnv = { ...process.env };
const originalIsTTY = process.stdout.isTTY;

let parseConfig: typeof import('../../src/config/index.js').parseConfig;

beforeAll(async () => {
  ({ parseConfig } = await import('../../src/config/index.js'));
});

describe('config parsing', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.stdout.isTTY = originalIsTTY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    process.stdout.isTTY = originalIsTTY;
  });

  it('normalizes aliases, trims arrays, and applies defaults', async () => {
    process.env.MCP_LOG_LEVEL = 'Warning';
    process.env.NODE_ENV = 'prod';
    process.env.MCP_ALLOWED_ORIGINS =
      'https://a.example.com, https://b.example.com ';
    process.env.DEV_MCP_SCOPES = 'scope:read, scope:write';
    process.env.MCP_SESSION_MODE = ''; // exercise empty-string sanitization
    process.env.OTEL_ENABLED = 'true';
    process.env.OTEL_LOG_LEVEL = 'warning';
    process.env.OTEL_TRACES_SAMPLER_ARG = '0.5';
    const parsed = parseConfig();

    expect(parsed.logLevel).toBe('warn');
    expect(parsed.environment).toBe('production');
    expect(parsed.mcpSessionMode).toBe('auto');
    expect(parsed.mcpAllowedOrigins).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
    expect(parsed.devMcpScopes).toEqual(['scope:read', 'scope:write']);
    expect(parsed.openTelemetry.enabled).toBe(true);
    expect(parsed.openTelemetry.logLevel).toBe('WARN');
    expect(parsed.openTelemetry.samplingRatio).toBe(0.5);
  });

  it('throws a configuration error when validation fails', async () => {
    process.env.MCP_LOG_LEVEL = 'invalid-level';
    process.stdout.isTTY = true;
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let thrown: unknown;
    try {
      parseConfig();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(McpError);
    const mcpError = thrown as McpError;
    expect(mcpError.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(consoleSpy).toHaveBeenCalledWith(
      '❌ Invalid configuration found. Please check your environment variables.',
      expect.any(Object),
    );

    consoleSpy.mockRestore();
  });

  it('requires an existing absolute REVIEW_BASE_DIR', () => {
    delete process.env.REVIEW_BASE_DIR;
    expect(() => parseConfig()).toThrow(/Invalid application configuration/);

    process.env.REVIEW_BASE_DIR = 'relative/path';
    expect(() => parseConfig()).toThrow(/Invalid application configuration/);

    process.env.REVIEW_BASE_DIR = '/path/that/does/not/exist/repo-review';
    expect(() => parseConfig()).toThrow(/must exist/);
  });
});
