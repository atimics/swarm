#!/usr/bin/env bash
# Create GitHub issues from the 2026-02-15 engineering report.
# Run this locally where `gh` is authenticated:
#   chmod +x scripts/create-engineering-issues.sh
#   ./scripts/create-engineering-issues.sh
set -euo pipefail

REPO="atimics/aws-swarm"
ASSIGNEE="copilot-swe-agent[bot]"

create_issue() {
  local title="$1"
  local labels="$2"
  local body="$3"

  echo "Creating: $title"
  gh issue create \
    --repo "$REPO" \
    --title "$title" \
    --label "$labels" \
    --assignee "$ASSIGNEE" \
    --body "$body"
  echo ""
}

echo "=== Creating P0 issues (Critical) ==="

create_issue \
  "fix(claude-code-worker): build fails — missing @types/node and AWS SDK types" \
  "type:bug,priority:high,package:core" \
  "$(cat <<'BODY'
## Problem

`packages/claude-code-worker` fails to compile with `pnpm -r build`:

```
error TS2307: Cannot find module 'path' or its corresponding type declarations.
error TS2307: Cannot find module '@aws-sdk/client-sqs' or its corresponding type declarations.
error TS2580: Cannot find name 'process'. Do you need to install type definitions for node?
```

## Root Cause

- `@types/node` is missing from `devDependencies`
- AWS SDK packages (`@aws-sdk/client-sqs`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`) are missing from `dependencies`
- `child_process` module type declarations are not available

## Fix

1. Add `@types/node` to `devDependencies`
2. Add required AWS SDK packages to `dependencies`
3. Ensure `tsconfig.json` properly inherits from `tsconfig.base.json`
4. Verify the package builds cleanly with `pnpm -r build`

## Acceptance Criteria

- [ ] `pnpm --filter @swarm/claude-code-worker build` succeeds
- [ ] No TypeScript errors in `src/worker.ts`

Ref: docs/engineering-report-2026-02-15 issue #1
BODY
)"

create_issue \
  "fix: resolve 114 test failures and 66 module resolution errors" \
  "type:bug,priority:high" \
  "$(cat <<'BODY'
## Problem

Running `pnpm test` produces:

```
401 pass / 114 fail / 66 errors / 59 skip (574 total)
```

The 66 errors are caused by module resolution failures in the Bun test runner. Key missing modules:

| Module | Occurrences |
|--------|-------------|
| `@aws-sdk/lib-dynamodb` | 18 |
| `@swarm/core` | 8 |
| `zod` | 7 |
| `@aws-sdk/client-dynamodb` | 4 |
| `@solana/web3.js` | 2 |
| `twitter-api-v2` | 2 |
| Others (grammy, yaml, bs58, jimp, tweetnacl, zustand, react) | 10+ |

## Root Cause

Bun cannot resolve workspace dependencies (`@swarm/core`) or third-party packages that should be installed via `pnpm install`. This may be a hoisting or symlink issue between pnpm workspaces and Bun's module resolver.

## Fix

1. Ensure `pnpm install --frozen-lockfile` runs before tests
2. Verify Bun can resolve pnpm workspace protocol links
3. For the 114 genuine test failures (not module errors), triage and fix or skip with comments
4. Consider adding a CI pre-test step that validates module resolution

## Acceptance Criteria

- [ ] `pnpm test` has 0 errors (module resolution issues resolved)
- [ ] Test failures reduced to <10 (known issues documented)
- [ ] CI runs tests reliably

Ref: docs/engineering-report-2026-02-15 issues #2, #3
BODY
)"

echo ""
echo "=== Creating P1 issues (High) ==="

create_issue \
  "refactor(admin-ui): decompose ToolPrompts.tsx (2,876 lines)" \
  "type:feature,priority:high,package:admin" \
  "$(cat <<'BODY'
## Problem

`packages/admin-ui/src/components/ToolPrompts.tsx` is 2,876 lines — the largest file in the entire repository. This makes it:

- Hard to review in PRs
- Difficult to maintain and extend
- Prone to merge conflicts
- Impossible to test individual tool prompts in isolation

## Proposal

Split `ToolPrompts.tsx` into individual tool prompt components:

```
components/tool-prompts/
  index.ts                    # Re-exports + ToolPrompts wrapper
  MediaToolPrompt.tsx
  VoiceToolPrompt.tsx
  TelegramToolPrompt.tsx
  TwitterToolPrompt.tsx
  MemoryToolPrompt.tsx
  WalletToolPrompt.tsx
  ... (one per tool category)
```

## Acceptance Criteria

- [ ] No single file >500 lines
- [ ] All tool prompts render identically (visual regression)
- [ ] Component tests added for at least the 3 most complex tool prompts
- [ ] `ToolPrompts.tsx` deleted or reduced to <100 line barrel export

Ref: docs/engineering-report-2026-02-15 issue #4
BODY
)"

create_issue \
  "test(infra): add CDK infrastructure snapshot tests" \
  "type:feature,priority:high,package:infra" \
  "$(cat <<'BODY'
## Problem

`packages/infra/` has **zero test files** for 5,185 lines of CDK infrastructure code. This means:

- Infrastructure changes are deployed untested
- Accidental resource deletions or permission changes go undetected
- No regression safety net for CDK construct modifications

## Proposal

Add CDK assertion tests using the `aws-cdk-lib/assertions` module:

1. **Snapshot tests** — synthesize each stack and snapshot the CloudFormation template
2. **Fine-grained assertions** — verify critical resources exist (DynamoDB tables, SQS queues, Lambda functions, IAM roles)
3. **Security assertions** — verify IAM policies follow least-privilege, encryption is enabled, DLQs are attached

Example:

```typescript
import { Template } from 'aws-cdk-lib/assertions';
import { SharedInfraStack } from '../src/stacks/shared-infra-stack';

test('SharedInfraStack creates DynamoDB table with encryption', () => {
  const template = Template.fromStack(new SharedInfraStack(...));
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    SSESpecification: { SSEEnabled: true },
  });
});
```

## Acceptance Criteria

- [ ] At least 1 snapshot test per CDK stack (4 stacks)
- [ ] Fine-grained assertions for critical resources (DynamoDB, SQS, Lambda)
- [ ] Tests run in CI alongside other package tests

Ref: docs/engineering-report-2026-02-15 issue #6
BODY
)"

create_issue \
  "chore: raise test coverage threshold from 25% to 40%" \
  "type:feature,priority:high" \
  "$(cat <<'BODY'
## Problem

The test coverage threshold in `vitest.config.ts` is set to 25% for lines, functions, branches, and statements. This is well below industry norms (60-80%) and provides low confidence in code correctness.

## Current State

```typescript
// vitest.config.ts
thresholds: {
  lines: 25,
  functions: 25,
  branches: 25,
  statements: 25,
}
```

## Proposal

1. Raise thresholds to 40% as an intermediate step
2. Add tests to packages with the lowest coverage to meet the new bar
3. Target 60% in a follow-up milestone

Priority areas for new tests:
- `admin-ui` (6 test files for 14K LOC)
- `mcp-server` (4 test files for 10.9K LOC)
- `infra` (0 test files for 5.2K LOC)

## Acceptance Criteria

- [ ] Coverage thresholds raised to 40% in `vitest.config.ts`
- [ ] All packages pass the new threshold in CI
- [ ] No reduction in existing test count

Ref: docs/engineering-report-2026-02-15 issue #7
BODY
)"

echo ""
echo "=== Creating P2 issues (Medium) ==="

create_issue \
  "fix(profile-page): build fails — vite not found" \
  "type:bug,priority:medium" \
  "$(cat <<'BODY'
## Problem

`packages/profile-page` fails to build:

```
sh: 1: vite: not found
```

## Root Cause

`node_modules` is not installed for this workspace member. The `vite` binary is listed as a dependency but is not available on the PATH.

## Fix

1. Ensure `pnpm install` resolves dependencies for `profile-page`
2. Verify `vite` is in `devDependencies` (not just `dependencies`)
3. Verify `pnpm --filter profile-page build` succeeds

## Acceptance Criteria

- [ ] `pnpm --filter profile-page build` succeeds
- [ ] `pnpm -r build` completes with no failures

Ref: docs/engineering-report-2026-02-15 issue #8
BODY
)"

create_issue \
  "chore: consolidate test runner — remove vitest/bun dual config" \
  "type:feature,priority:medium" \
  "$(cat <<'BODY'
## Problem

The repo has both `vitest.config.ts` and `bunfig.toml`, but tests run via `bun test`. This creates confusion:

- `vitest.config.ts` defines coverage thresholds that may not be enforced
- Developers don't know which runner is authoritative
- CI may behave differently from local development

## Proposal

Pick one test runner and remove the other:

**Option A (Recommended): Standardize on Vitest**
- Already has coverage config and thresholds
- Better IDE integration
- More widely supported

**Option B: Standardize on Bun**
- Currently used for execution
- Faster startup
- Requires moving coverage config to Bun's format

## Acceptance Criteria

- [ ] Single test runner configured
- [ ] Coverage thresholds enforced by the chosen runner
- [ ] `pnpm test` and CI use the same runner
- [ ] Removed runner's config files deleted

Ref: docs/engineering-report-2026-02-15 issue #9
BODY
)"

create_issue \
  "test(admin-ui): add component tests for core UI flows" \
  "type:feature,priority:medium,package:admin" \
  "$(cat <<'BODY'
## Problem

`packages/admin-ui` has only 6 test files for 14,028 lines of code. The entire chat experience, onboarding wizard, avatar management, and tool prompt UI are untested.

## Proposal

Add React Testing Library tests for the most critical UI components:

1. **ChatPanel** — message rendering, input handling, streaming
2. **OnboardingWizard** — step progression, validation, error states
3. **ChatMessage** — tool call rendering, markdown rendering, image display
4. **ToolPrompts** — form submission, validation, cancellation
5. **Header** — auth state display, avatar switching

## Acceptance Criteria

- [ ] At least 15 new test cases across 5+ components
- [ ] Tests cover happy path and key error states
- [ ] Tests run in CI with the standard test command

Ref: docs/engineering-report-2026-02-15 issue #10
BODY
)"

create_issue \
  "ci: add dependency security audit to CI pipeline" \
  "type:security,priority:medium" \
  "$(cat <<'BODY'
## Problem

No dependency security audit runs in CI. Vulnerable dependencies could ship to production undetected.

## Proposal

Add `pnpm audit` (or `npm audit`) as a CI step in `ci.yml`:

```yaml
- name: Security audit
  run: pnpm audit --audit-level=high
```

Options:
- Fail on high/critical vulnerabilities only
- Allow known issues via `.npmrc` audit exceptions
- Consider adding Dependabot or Renovate for automated dependency updates

## Acceptance Criteria

- [ ] `pnpm audit` runs in CI on every PR
- [ ] High/critical vulnerabilities block merge
- [ ] Existing vulnerabilities triaged (fixed or excepted)

Ref: docs/engineering-report-2026-02-15 issue #11
BODY
)"

echo ""
echo "=== Creating P3 issues (Low) ==="

create_issue \
  "test(mcp-server): increase test coverage for tool registry" \
  "type:feature,priority:low" \
  "$(cat <<'BODY'
## Problem

`packages/mcp-server` has only 4 test files for 10,938 lines of code. The tool registry, server, and most tool implementations are untested.

## Proposal

Add tests for:

1. **Tool registration and discovery** — verify tools register with correct schemas
2. **Tool execution routing** — verify tool calls dispatch to correct handlers
3. **Schema validation** — verify invalid tool inputs are rejected
4. **Individual tools** — at least smoke tests for the 5 most-used tools

## Acceptance Criteria

- [ ] At least 10 new test cases
- [ ] Coverage for tool registration, routing, and validation
- [ ] Tests run in CI

Ref: docs/engineering-report-2026-02-15 issue #12
BODY
)"

echo ""
echo "=== Done! ==="
echo "All issues created and assigned to $ASSIGNEE"
