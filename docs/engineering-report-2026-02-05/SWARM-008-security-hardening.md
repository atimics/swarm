# SWARM-008: Security Hardening

**Priority:** P2 — Planned
**Package:** `@swarm/infra`

## Worker Assignment

- **Assigned Worker:** `worker-008`
- **Branch:** `feat/swarm-008`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-008`
- **Core Mission:** Close known infra security gaps with additive, auditable controls that reduce exposure without disrupting existing traffic paths.

## Items

### 1. Add WAF to CloudFront and API Gateway
Currently no AWS WAF is attached. The system relies on Cloudflare Access, but API Gateway URLs are directly accessible.

- Attach WAF WebACL with rate limiting and IP reputation rules
- Apply to Admin API HTTP API and all CloudFront distributions

### 2. Scope Bedrock IAM Policies
`bedrock:InvokeModel` uses `Resource: *`. Scope to specific model ARNs:
`arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-*`

### 3. Encrypt Per-Avatar SQS Queues
Shared handler queues use `SQS_MANAGED` encryption. Per-avatar queues do not.
Add `encryption: sqs.QueueEncryption.SQS_MANAGED` to all per-avatar queue constructs.

### 4. Remove Disabled Dangerous Code
Deploy workflow contains disabled S3 bucket deletion code. Remove entirely.

## Acceptance Criteria

- [ ] WAF WebACL deployed on admin API and CloudFront distributions
- [ ] Bedrock IAM scoped to specific model ARN patterns
- [ ] All SQS queues encrypted
- [ ] Dangerous disabled code removed from deploy workflow
