/**
 * Shared types for decomposed avatar route handlers.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { UserSession } from '../../types.js';

/**
 * Context object threaded through all domain route handlers.
 * Built once in the top-level router and passed to each handler.
 */
export type RouteContext = {
  event: APIGatewayProxyEventV2;
  method: string;
  path: string;
  corsHeaders: Record<string, string>;
  session: UserSession;
  walletAddress: string | null;
  /** accountId from the wallet session (if available). */
  accountId: string | undefined;
  effectiveIsAdmin: boolean;
};

/**
 * A domain route handler.
 * Returns a response if the route matches, or `null` to fall through to the next handler.
 */
export type RouteHandler = (ctx: RouteContext) => Promise<APIGatewayProxyResultV2 | null>;
