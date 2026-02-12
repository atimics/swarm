# Repository Guidelines

## Project Structure & Module Organization
- `packages/` hosts the main modules: `core` (shared runtime), `handlers` (Lambda entrypoints), `admin-api`, `admin-ui`, and `infra` (CDK).
- `scripts/` holds helper scripts.
- Tests live alongside packages as `packages/**/*.test.ts`.

## Build, Test, and Development Commands
- `pnpm install` installs workspace dependencies.
- `pnpm build` builds all packages (`pnpm -r build`).
- `pnpm dev` runs package dev/watch tasks in parallel.
- `bun test` runs tests across packages (uses Bun's built-in test runner with vitest compatibility).
- `pnpm lint` runs ESLint where configured (ex: `packages/core`, `packages/admin-ui`).
- `pnpm cdk diff` or `pnpm synth` previews infra changes via `@swarm/infra`.
- Deployments are typically handled via GitHub Actions; only run `pnpm deploy:dev`/`pnpm deploy:prod` if explicitly requested.

## Coding Style & Naming Conventions
- TypeScript, ES2022, ESM (`import ... from './file.js'`); `tsconfig.base.json` enforces strictness and no unused locals/params.
- Use 2-space indentation and match the existing file style.
- Prefer `camelCase` for variables/functions and `PascalCase` for types/classes.
- Avatar folder names should be kebab-case IDs that match runtime avatar IDs.

## Testing Guidelines
- Tests use Bun's built-in test runner (`bun test`) which is vitest-compatible.
- Test files match `packages/**/*.test.ts` and use vitest imports (`describe`, `it`, `expect`, `vi`).
- Coverage uses the V8 provider and targets `packages/*/src/**/*.ts` (infra/admin-ui are excluded by default).
- Name new tests `*.test.ts` and keep them near the package they validate.

## Commit & Pull Request Guidelines
- Use Conventional Commits with package scopes, e.g. `feat(admin-api): add wallet tool`.
- Branches follow `<type>/issue-<number>-<short-description>` (ex: `fix/issue-42-dynamo-query`).
- Reference issues in commit bodies or PR descriptions; PR titles should follow the same commit convention.
- Use the PR template, describe changes and tests, and expect squash merges to `main`.

## Security & Configuration Tips
- Never commit secrets; use AWS Secrets Manager and environment variables (ex: `ADMIN_TABLE`, `STATE_TABLE`, `MESSAGE_QUEUE_URL`).
- Local dev expects AWS credentials and the CDK-managed tables/queues/buckets to exist.

## Logs & Debugging

### Consolidated Logs Endpoint
Each avatar has a logs endpoint: `GET /avatars/{avatarId}/logs`

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `level` | string | Filter by log level (`ERROR`, `WARN`, `INFO`, `DEBUG`) |
| `subsystem` | string | Filter by component (`telegram`, `chat`, `llm`, `state`, etc.) |
| `since` | string | Relative time (e.g., `30m`, `2h`, `1d`) |
| `start` | number | Start timestamp (ms since epoch) |
| `end` | number | End timestamp (ms since epoch) |
| `limit` | number | Max results (default 200, max 500) |
| `query` | string | Free-text search in log messages |

**Example:**
```bash
# Get last 30 minutes of ERROR logs for an avatar
curl "https://swarm.rati.chat/api/avatars/my-avatar/logs?level=ERROR&since=30m"

# Search for specific text in last hour
curl "https://swarm.rati.chat/api/avatars/my-avatar/logs?query=timeout&since=1h"

# Filter by subsystem (telegram, chat, llm)
curl "https://swarm.rati.chat/api/avatars/my-avatar/logs?subsystem=telegram&since=1h"
```

**Response:**
```json
{
  "avatarId": "my-avatar",
  "startTime": 1736531232000,
  "endTime": 1736533032000,
  "logGroups": ["/aws/lambda/my-avatar-webhook", "/aws/lambda/AdminApiChatHandler..."],
  "filters": { "level": "ERROR", "limit": 200 },
  "events": [
    { "timestamp": "2026-01-10T19:07:12.531Z", "message": "...", "logGroup": "...", "logStream": "..." }
  ]
}
```

### Structured Log Format
Handlers log structured JSON for queryability:
```json
{
  "level": "INFO|WARN|ERROR",
  "subsystem": "telegram|chat|llm",
  "event": "request_received|channel_processed|validation_error|handler_error",
  "avatarId": "avatar-id",
  "requestId": "aws-request-id",
  ...
}
```

### Direct API Testing (Internal)
For testing API endpoints directly (bypassing upstream auth layers):
```bash
# Use the test script (requires AWS credentials)
./scripts/test-api.sh staging chat '{"message":"hello","history":[]}'
./scripts/test-api.sh staging avatars GET

# Or manually with the internal test key from Lambda env:
INTERNAL_TEST_KEY=$(aws lambda get-function-configuration \
  --function-name "SwarmStack-staging-AdminApiChatHandler..." \
  --query "Environment.Variables.INTERNAL_TEST_KEY" --output text)

curl "https://g5wetlu97i.execute-api.us-east-1.amazonaws.com/chat" \
  -H "x-internal-test-key: $INTERNAL_TEST_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"test","history":[]}'
```

### AWS CLI Log Commands
```bash
# List log groups for admin API
aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/SwarmStack-staging-AdminApi"

# Tail recent logs
aws logs filter-log-events \
  --log-group-name "/aws/lambda/SwarmStack-staging-AdminApiChatHandler..." \
  --start-time $(($(date +%s) * 1000 - 300000)) \
  --query 'events[*].message' --output text

# Search for errors
aws logs filter-log-events \
  --log-group-name "/aws/lambda/..." \
  --filter-pattern "ERROR" \
  --limit 20

# Search for structured logs by avatarId
aws logs filter-log-events \
  --log-group-name "/aws/lambda/..." \
  --filter-pattern '{ $.avatarId = "my-avatar" }' \
  --limit 20
```

### Common Issues
- **400 on `/chat`**: Check Zod validation - request body must have `message` (string) and `history` (array). If sending `avatar`, it needs at least `id`.
- **403 Forbidden**: Missing/expired first-party session cookie, or missing/invalid `x-internal-test-key` for internal test calls
- **DynamoDB reserved keywords**: Use expression attribute names for reserved words like `ttl` → `#ttl`
