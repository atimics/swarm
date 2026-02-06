/**
 * System & integration model routes.
 *
 * - GET /system/status
 * - GET /integrations/models
 */
import type { RouteContext } from './types.js';
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { jsonResponse, parseSinceQueryParam } from './shared.js';
import * as observabilityService from '../../services/observability.js';
import * as integrationsService from '../../services/integrations.js';

export async function handleSystemRoutes(
  ctx: RouteContext,
): Promise<APIGatewayProxyResultV2 | null> {
  const { method, path, corsHeaders, event, effectiveIsAdmin } = ctx;

  // GET /system/status — Admin-only system overview
  if (method === 'GET' && path === '/system/status') {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }
    const params = event.queryStringParameters || {};
    const since = parseSinceQueryParam(params.since);
    const avatarId = params.avatarId;
    const status = await observabilityService.getSystemStatus({ since, avatarId });
    return jsonResponse(corsHeaders, 200, status);
  }

  // GET /integrations/models — Centralized model catalog
  if (method === 'GET' && path === '/integrations/models') {
    const integrationParam = event.queryStringParameters?.integration;
    const allowed = ['replicate', 'openai', 'anthropic', 'openrouter'] as const;

    if (integrationParam && !allowed.includes(integrationParam as (typeof allowed)[number])) {
      return jsonResponse(corsHeaders, 400, {
        error: `Unknown integration: ${integrationParam}`,
      });
    }

    if (integrationParam) {
      const modelsByCapability = integrationsService.getAvailableModelsForIntegration(
        integrationParam as (typeof allowed)[number],
      );
      return jsonResponse(corsHeaders, 200, {
        integration: integrationParam,
        modelsByCapability,
      });
    }

    const integrations = allowed.reduce<
      Record<string, ReturnType<typeof integrationsService.getAvailableModelsForIntegration>>
    >((acc, integration) => {
      acc[integration] = integrationsService.getAvailableModelsForIntegration(integration);
      return acc;
    }, {});

    return jsonResponse(corsHeaders, 200, { integrations });
  }

  return null;
}
