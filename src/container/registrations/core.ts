/**
 * @fileoverview Registers core application services with the DI container.
 * This module encapsulates the registration of fundamental services such as
 * configuration, logging, storage, and git provider.
 * @module src/container/registrations/core
 */
import { container, Lifecycle } from 'tsyringe';

import { parseConfig } from '@/config/index.js';
import {
  AppConfig,
  Logger,
  RateLimiterService,
  ReviewProvider,
} from '@/container/tokens.js';
import { CliReviewProvider } from '@/services/git/providers/cli/CliReviewProvider.js';
import { logger } from '@/utils/index.js';
import { RateLimiter } from '@/utils/security/rateLimiter.js';

/**
 * Registers core application services and values with the tsyringe container.
 */
export const registerCoreServices = () => {
  // Configuration (parsed and registered as a static value)
  const config = parseConfig();
  container.register(AppConfig, { useValue: config });

  // Logger (as a static value)
  container.register(Logger, { useValue: logger });

  // Register RateLimiter as a singleton service
  container.register<RateLimiter>(
    RateLimiterService,
    { useClass: RateLimiter },
    { lifecycle: Lifecycle.Singleton },
  );

  container.register(ReviewProvider, {
    useFactory: (c) => {
      const cfg = c.resolve<ReturnType<typeof parseConfig>>(AppConfig);
      return new CliReviewProvider(
        cfg.review.baseDir,
        cfg.review.maxCommandTimeoutMs,
        cfg.review.maxBufferSizeMb,
      );
    },
  });

  logger.info('Core services registered with the DI container.');
};
