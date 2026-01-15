/**
 * GitHub Issue Auto-Reporter
 *
 * Automatically creates and updates GitHub issues for errors/warnings.
 * Deduplicates by fingerprinting error messages - repeat occurrences
 * add comments to existing issues instead of creating duplicates.
 *
 * Usage:
 *   import { reportIssue, reportWarning, reportError } from './lib/github-issues.mjs';
 *
 *   await reportError({
 *     title: 'API timeout',
 *     error: 'Request to /chat timed out after 30s',
 *     subsystem: 'browser-test',
 *     context: { step: 5, url: 'https://...' }
 *   });
 */

import { execSync } from 'child_process';
import { createHash } from 'crypto';

// Label used to identify auto-generated issues
const AUTO_ISSUE_LABEL = 'auto-reported';
const FINGERPRINT_LABEL_PREFIX = 'fingerprint:';

/**
 * Normalize an error message by removing variable parts (IDs, timestamps, etc.)
 * This allows grouping similar errors together.
 */
function normalizeMessage(message) {
  return message
    // Remove UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    // Remove long numeric IDs
    .replace(/\b\d{10,}\b/g, '<ID>')
    // Remove ISO timestamps
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*/g, '<TIMESTAMP>')
    // Remove Unix timestamps (10-13 digits)
    .replace(/\b\d{10,13}\b/g, '<TIMESTAMP>')
    // Remove file paths
    .replace(/\/[\w\-./]+\.(js|ts|mjs|mts|json)/g, '<PATH>')
    // Remove URLs but keep the domain
    .replace(/https?:\/\/[^\s]+/g, (url) => {
      try {
        const parsed = new URL(url);
        return `<URL:${parsed.hostname}>`;
      } catch {
        return '<URL>';
      }
    })
    // Remove base64 data
    .replace(/data:[^;]+;base64,[A-Za-z0-9+/=]{20,}/g, '<BASE64>')
    // Remove hex strings (likely hashes/tokens)
    .replace(/\b[0-9a-f]{32,}\b/gi, '<HEX>')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate a fingerprint hash for an error to identify duplicates
 */
function generateFingerprint(message, subsystem, category = 'error') {
  const normalized = normalizeMessage(message);
  const input = `${subsystem}:${category}:${normalized}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

/**
 * Execute a gh CLI command and return the result
 */
function gh(args, options = {}) {
  try {
    const result = execSync(`gh ${args}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    });
    return { success: true, output: result.trim() };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      stderr: err.stderr?.toString() || '',
    };
  }
}

/**
 * Find an existing issue by fingerprint label
 */
function findExistingIssue(fingerprint) {
  const label = `${FINGERPRINT_LABEL_PREFIX}${fingerprint}`;
  const result = gh(`issue list --label "${label}" --state all --json number,title,state,url --limit 1`);

  if (!result.success) {
    return null;
  }

  try {
    const issues = JSON.parse(result.output);
    return issues.length > 0 ? issues[0] : null;
  } catch {
    return null;
  }
}

/**
 * Ensure required labels exist
 */
function ensureLabels(fingerprint, severity) {
  const labels = [
    { name: AUTO_ISSUE_LABEL, color: '6e7681', description: 'Automatically reported issue' },
    { name: `${FINGERPRINT_LABEL_PREFIX}${fingerprint}`, color: 'bfdadc', description: 'Issue fingerprint for deduplication' },
    { name: `severity:${severity}`, color: getSeverityColor(severity), description: `${severity} severity issue` },
  ];

  for (const label of labels) {
    // Try to create, ignore if exists
    gh(`label create "${label.name}" --color "${label.color}" --description "${label.description}" --force 2>/dev/null`);
  }
}

function getSeverityColor(severity) {
  switch (severity) {
    case 'critical': return 'd73a4a';
    case 'high': return 'ff7b00';
    case 'medium': return 'fbca04';
    case 'low': return '0e8a16';
    default: return '6e7681';
  }
}

/**
 * Determine severity based on error characteristics
 */
function determineSeverity(message, category) {
  const lower = message.toLowerCase();

  // Critical
  if (
    lower.includes('authentication') ||
    lower.includes('authorization') ||
    lower.includes('security') ||
    lower.includes('crash') ||
    lower.includes('fatal')
  ) {
    return 'critical';
  }

  // High
  if (
    lower.includes('error') ||
    lower.includes('failed') ||
    lower.includes('timeout') ||
    lower.includes('500') ||
    category === 'error'
  ) {
    return 'high';
  }

  // Medium
  if (
    lower.includes('warning') ||
    lower.includes('not found') ||
    lower.includes('invalid') ||
    category === 'warning'
  ) {
    return 'medium';
  }

  return 'low';
}

/**
 * Format occurrence details for issue body or comment
 */
function formatOccurrence(params) {
  const { error, stack, context, runId, environment } = params;
  const timestamp = new Date().toISOString();

  let details = `**Time:** ${timestamp}\n`;
  if (environment) details += `**Environment:** ${environment}\n`;
  if (runId) details += `**Run ID:** ${runId}\n`;

  details += `\n**Error:**\n\`\`\`\n${error.slice(0, 1000)}\n\`\`\`\n`;

  if (stack) {
    details += `\n<details>\n<summary>Stack Trace</summary>\n\n\`\`\`\n${stack.slice(0, 2000)}\n\`\`\`\n</details>\n`;
  }

  if (context && Object.keys(context).length > 0) {
    details += `\n<details>\n<summary>Context</summary>\n\n\`\`\`json\n${JSON.stringify(context, null, 2).slice(0, 2000)}\n\`\`\`\n</details>\n`;
  }

  return details;
}

/**
 * Report an issue to GitHub
 * Creates a new issue or adds a comment to an existing one
 */
export async function reportIssue(params) {
  const {
    title,
    error,
    stack,
    subsystem,
    category = 'error',
    context = {},
    runId,
    environment,
  } = params;

  const fingerprint = generateFingerprint(error, subsystem, category);
  const severity = determineSeverity(error, category);

  console.log(`📋 Reporting ${category} to GitHub (fingerprint: ${fingerprint})`);

  // Check for existing issue
  const existing = findExistingIssue(fingerprint);

  if (existing) {
    // Add comment to existing issue
    console.log(`   Found existing issue #${existing.number}: ${existing.title}`);

    const comment = `## New Occurrence\n\n${formatOccurrence({ error, stack, context, runId, environment })}`;

    const result = gh(`issue comment ${existing.number} --body "${comment.replace(/"/g, '\\"').replace(/`/g, '\\`')}"`);

    if (result.success) {
      console.log(`   ✅ Added comment to issue #${existing.number}`);

      // Reopen if closed
      if (existing.state === 'closed') {
        gh(`issue reopen ${existing.number}`);
        console.log(`   🔄 Reopened issue #${existing.number}`);
      }
    } else {
      console.error(`   ❌ Failed to add comment: ${result.error}`);
    }

    return {
      isNew: false,
      issueNumber: existing.number,
      issueUrl: existing.url,
      fingerprint,
    };
  }

  // Create new issue
  ensureLabels(fingerprint, severity);

  const labels = [
    AUTO_ISSUE_LABEL,
    `${FINGERPRINT_LABEL_PREFIX}${fingerprint}`,
    `severity:${severity}`,
  ].join(',');

  const body = `## ${category === 'warning' ? '⚠️ Warning' : '🔴 Error'} in \`${subsystem}\`

**Fingerprint:** \`${fingerprint}\`
**Severity:** ${severity}
**Category:** ${category}

---

## First Occurrence

${formatOccurrence({ error, stack, context, runId, environment })}

---

<sub>This issue was automatically created. Additional occurrences will be added as comments.</sub>
`;

  const issueTitle = `[${subsystem}] ${title.slice(0, 80)}${title.length > 80 ? '...' : ''}`;

  // Use heredoc for body to handle special characters
  const result = gh(`issue create --title "${issueTitle.replace(/"/g, '\\"')}" --label "${labels}" --body "${body.replace(/"/g, '\\"').replace(/`/g, '\\`')}"`);

  if (result.success) {
    // Extract issue URL from output
    const urlMatch = result.output.match(/https:\/\/github\.com\/[^\s]+/);
    const issueUrl = urlMatch ? urlMatch[0] : result.output;
    const numberMatch = issueUrl.match(/\/issues\/(\d+)/);
    const issueNumber = numberMatch ? parseInt(numberMatch[1]) : null;

    console.log(`   ✅ Created new issue: ${issueUrl}`);

    return {
      isNew: true,
      issueNumber,
      issueUrl,
      fingerprint,
    };
  } else {
    console.error(`   ❌ Failed to create issue: ${result.error}`);
    return {
      isNew: false,
      error: result.error,
      fingerprint,
    };
  }
}

/**
 * Convenience wrapper for reporting errors
 */
export async function reportError(params) {
  return reportIssue({ ...params, category: 'error' });
}

/**
 * Convenience wrapper for reporting warnings
 */
export async function reportWarning(params) {
  return reportIssue({ ...params, category: 'warning' });
}

/**
 * Report a test failure with screenshot reference
 */
export async function reportTestFailure(params) {
  const {
    testName,
    error,
    screenshotPath,
    runUrl,
    ...rest
  } = params;

  const context = {
    ...rest.context,
    testName,
    screenshotPath,
    runUrl,
  };

  return reportIssue({
    title: `Test failure: ${testName}`,
    error,
    subsystem: 'e2e-test',
    category: 'test-failure',
    context,
    ...rest,
  });
}

// CLI usage
if (process.argv[1]?.endsWith('github-issues.mjs') && process.argv[2]) {
  const [, , command, ...args] = process.argv;

  if (command === 'test') {
    // Test the integration
    reportError({
      title: 'Test error from CLI',
      error: 'This is a test error message to verify GitHub issue creation works',
      subsystem: 'cli-test',
      context: { test: true, timestamp: Date.now() },
    }).then(result => {
      console.log('Result:', result);
    });
  }
}
