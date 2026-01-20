/**
 * Issues API Handler
 *
 * REST endpoints for the auto-issues tracking system.
 * Allows external services (like browser tests, CI) to report errors
 * that get fingerprinted and deduplicated.
 *
 * Endpoints:
 *   POST /issues - Record a new error/issue occurrence
 *   GET /issues - List all issues (optionally filtered)
 *   GET /issues/{id} - Get issue details with occurrences
 *   PATCH /issues/{id} - Update issue status
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { logger } from '@swarm/core';
import * as autoIssues from '../services/auto-issues.js';
import { getCorsHeaders } from '../http/cors.js';



// Internal test key for CI/CD access (set in Lambda env)
const INTERNAL_TEST_KEY = process.env.INTERNAL_TEST_KEY;

/**
 * Validate internal test key for CI/CD requests
 */
function validateTestKey(event: APIGatewayProxyEventV2): boolean {
  if (!INTERNAL_TEST_KEY) return false;
  const providedKey = event.headers['x-internal-test-key'];
  return providedKey === INTERNAL_TEST_KEY;
}

/**
 * Lambda handler for issues API
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const corsHeaders = getCorsHeaders(event);
  const method = event.requestContext.http.method;
  const rawPath = event.rawPath;
  const normalizedPath = rawPath === '/api'
    ? '/'
    : rawPath.startsWith('/api/')
      ? rawPath.slice('/api'.length)
      : rawPath;
  const path = normalizedPath.replace(/^\/issues/, '') || '/';

  // Handle preflight
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  // Set logging context
  logger.setContext({ subsystem: 'issues', requestId: event.requestContext.requestId });

  try {
    // Require internal test key for write operations
    const hasTestKey = validateTestKey(event);

    // POST /issues - Record a new error
    if (method === 'POST' && path === '/') {
      if (!hasTestKey) {
        return {
          statusCode: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Unauthorized - x-internal-test-key required' }),
        };
      }

      const body = JSON.parse(event.body || '{}');
      const { error, stack, subsystem, category, avatarId, requestId, context } = body;

      if (!error || !subsystem) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Missing required fields: error, subsystem' }),
        };
      }

      const result = await autoIssues.recordError({
        error,
        stack,
        subsystem,
        category,
        avatarId,
        requestId,
        context,
      });

      logger.info('Issue recorded', {
        event: 'issue_recorded',
        issueId: result.issueId,
        isNew: result.isNew,
        occurrenceCount: result.occurrenceCount,
        subsystem,
      });

      return {
        statusCode: result.isNew ? 201 : 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: true,
          ...result,
        }),
      };
    }

    // GET /issues - List all issues
    if (method === 'GET' && path === '/') {
      const params = event.queryStringParameters || {};
      const status = params.status as autoIssues.IssueStatus | undefined;
      const severity = params.severity as autoIssues.IssueSeverity | undefined;
      const subsystem = params.subsystem;
      const limit = params.limit ? parseInt(params.limit, 10) : undefined;

      const issues = await autoIssues.listIssues({ status, severity, subsystem, limit });

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ issues, count: issues.length }),
      };
    }

    // GET /issues/{id} - Get issue details
    const issueMatch = path.match(/^\/([^/]+)$/);
    if (method === 'GET' && issueMatch) {
      const issueId = issueMatch[1];
      const result = await autoIssues.getIssue(issueId);

      if (!result.issue) {
        return {
          statusCode: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Issue not found' }),
        };
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      };
    }

    // PATCH /issues/{id} - Update issue status
    if (method === 'PATCH' && issueMatch) {
      if (!hasTestKey) {
        return {
          statusCode: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Unauthorized' }),
        };
      }

      const issueId = issueMatch[1];
      const body = JSON.parse(event.body || '{}');
      const { status } = body;

      if (!status || !['open', 'acknowledged', 'investigating', 'resolved', 'wontfix'].includes(status)) {
        return {
          statusCode: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Invalid status' }),
        };
      }

      await autoIssues.updateIssueStatus(issueId, status);

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, issueId, status }),
      };
    }

    // Not found
    return {
      statusCode: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Not found' }),
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Issues handler error', error);

    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error', message: errorMessage }),
    };
  }
}
