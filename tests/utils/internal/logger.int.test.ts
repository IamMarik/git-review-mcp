/**
 * @fileoverview Integration tests for structured, stream-only logging.
 * @module tests/utils/internal/logger.int.test
 */
import type { Logger as PinoLogger } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Logger } from '../../../src/utils/internal/logger.js';

interface LoggerInternals {
  pinoLogger?: PinoLogger;
  transportType?: 'stdio' | 'http';
}

describe('Logger stream-only behavior', () => {
  const logger = Logger.getInstance();

  beforeAll(async () => {
    if (logger.isInitialized()) await logger.close();
    await logger.initialize('debug', 'stdio');
  });

  afterAll(async () => {
    await logger.close();
  });

  it('initializes structured logging without a filesystem destination', () => {
    const internals = logger as unknown as LoggerInternals;
    expect(logger.isInitialized()).toBe(true);
    expect(internals.pinoLogger).toBeDefined();
    expect(internals.transportType).toBe('stdio');
  });

  it('routes interaction events through the main structured logger', () => {
    const internals = logger as unknown as LoggerInternals;
    const infoSpy = vi.spyOn(internals.pinoLogger!, 'info');

    logger.logInteraction('review-request', {
      requestId: 'interaction-1',
      payloadSize: 42,
    });

    expect(infoSpy).toHaveBeenCalledWith({
      interactionName: 'review-request',
      requestId: 'interaction-1',
      payloadSize: 42,
    });
    infoSpy.mockRestore();
  });

  it('supports changing structured log levels', () => {
    const internals = logger as unknown as LoggerInternals;
    logger.setLevel('info');
    expect(internals.pinoLogger?.level).toBe('info');
    logger.setLevel('debug');
    expect(internals.pinoLogger?.level).toBe('debug');
  });

  it('can initialize both supported transport modes', async () => {
    await logger.close();
    await logger.initialize('info', 'http');
    expect((logger as unknown as LoggerInternals).transportType).toBe('http');
    await logger.close();
    await logger.initialize('debug', 'stdio');
  });
});
