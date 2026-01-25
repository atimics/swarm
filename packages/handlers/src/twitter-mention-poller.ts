/**
 * Legacy Twitter Mention Poller (single-avatar)
 *
 * This handler has been retired in favor of the shared multi-tenant poller
 * (twitter-mention-poller-shared). It is intentionally a no-op so that any
 * stale infra wiring fails safely without polling.
 */
import type { ScheduledHandler } from 'aws-lambda';
import { logger } from '@swarm/core';

export const handler: ScheduledHandler = async () => {
  logger.warn('Legacy single-avatar Twitter mention poller is disabled. Use shared poller.', {
    event: 'handler_skipped',
    subsystem: 'twitter',
    reason: 'legacy_poller_removed',
  });
};

