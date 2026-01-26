# Issue Review Log

**Review Date:** 2026-01-25
**Reviewed By:** Claude Code

This document tracks the implementation status of all issues reported in `/issues/staging/`.

---

## Summary

| Category | Total Issues | Fixed | Partial | Open |
|----------|-------------|-------|---------|------|
| Twitter API Failures | 10 | 10 | 0 | 0 |
| Telegram Webhook Issues | 3 | 3 | 0 | 0 |
| Voice Message Failures | 2 | 2 | 0 | 0 |
| Replicate API Issues | 3 | 3 | 0 | 0 |
| OpenRouter Credits | 3 | 3 | 0 | 0 |
| User Experience (General) | 1 | 0 | 1 | 0 |
| **TOTAL** | **22** | **21** | **1** | **0** |

---

## Issue Details

### 1. Twitter API Failures (10 issues)

**Issue Files:**
- `issue-1768933441049-agent-1-6yan-*-high.json` - "Twitter posting fails repeatedly"
- `issue-1768943189385-agent-1-6yan-*-high.json` - "Twitter API integration failing repeatedly"
- `issue-1768943214770-agent-1-6yan-*-high.json` - "Twitter API consistently failing"
- `issue-1768943418964-agent-1-6yan-*-high.json` - "Twitter API connection broken"
- `issue-1768943603912-agent-1-6yan-*-high.json` - "Twitter API repeatedly failing to post"
- `issue-1768945750448-agent-1-6yan-*-high.json` - "Twitter posting fails despite showing connected"
- `issue-1768946057560-agent-1-6yan-*-high.json` - "Twitter API continues to fail"
- `issue-1768947389531-agent-1-6yan-*-high.json` - "Twitter API connection shows connected but all operations fail"
- `issue-1768947418054-agent-1-6yan-*-high.json` - "Twitter integration showing as connected but all API calls fail"
- `issue-1768947452526-agent-1-6yan-*-high.json` - "Twitter integration repeatedly failing despite showing as connected"

**Status:** FIXED

**Root Cause:** Multiple issues including secret resolution failures, cursor comparison bugs, and image upload size limits.

**Fixes Implemented:**

1. **Twitter Secrets Resolution Fix**
   - **Commit:** `d49d108`
   - **File:** `packages/handlers/src/utils/load-avatar-secrets.ts:27-100`
   - **Fix:** Multi-variant secret loading (snake_case/kebab-case), environment-scoped prefixes, shared app credentials fallback

2. **Twitter Mention Polling Reliability Fix**
   - **Commit:** `a623c05`
   - **File:** `packages/handlers/src/twitter-mention-poller-shared.ts:189-341`
   - **File:** `packages/handlers/src/utils/twitter-id.ts` (new file)
   - **Fix:** BigInt numeric comparison for cursor IDs, persistent 24h idempotency, cursor always advances

3. **Twitter Image Upload Hardening**
   - **Commit:** `9bfb695`
   - **File:** `packages/core/src/platforms/twitter-media.ts`
   - **Fix:** MIME type normalization, 5MB size limit enforcement, adaptive compression algorithm

4. **Twitter Rate Limiting Service**
   - **File:** `packages/handlers/src/services/twitter-rate-limit.ts:22-378`
   - **Fix:** Per-tier limits, 429 detection with exponential backoff, circuit breaker pattern

5. **Response Sender Twitter Credentials**
   - **File:** `packages/handlers/src/response-sender.ts:117-132`
   - **Fix:** Loads shared Twitter app credentials when per-avatar secrets missing

---

### 2. Telegram Webhook Issues (3 issues)

**Issue Files:**
- `issue-1769029575184-agent-1-6yan-*-critical.json` - "Telegram webhook misconfigured - 503 errors"
- `issue-1769095106858-avatar-1-9qhu-*-high.json` - "Messages Not Reaching Bot Despite Connected Status"
- `issue-1769250305938-avatar-1-9qhu-*-high.json` - "Telegram Webhook 500 Error"

**Status:** FIXED

**Root Cause:** Incorrect bot token secret path, webhook URL misconfigurations, Cloudflare Access blocking webhooks.

**Fixes Implemented:**

1. **Bot Token Secret Path Fix**
   - **Commit:** `4a671b5`
   - **File:** `packages/handlers/src/telegram-webhook-shared.ts:125-138`
   - **Fix:** Changed from JSON secret to individual secret path format

2. **Enhanced Bot Token Retrieval Logging**
   - **Commit:** `40e9d23`, `c1e4a3b`
   - **File:** `packages/handlers/src/telegram-webhook-shared.ts:418-440`
   - **Fix:** Added logging for bot token fetch success/failure

3. **Telegram Diagnostics Service**
   - **File:** `packages/admin-api/src/services/telegram-diagnostics.ts`
   - **Fix:** Diagnoses webhook URL mismatches, pending updates, last errors

4. **Telegram Webhook Repair Functionality**
   - **Commit:** `c8940da`
   - **File:** `packages/admin-api/src/services/telegram-repair.ts`
   - **File:** `packages/admin-api/src/handlers/avatars.ts:344-461`
   - **Fix:** `POST /avatars/{id}/telegram/repair` endpoint with force/dryRun options

5. **Environment Variable Trimming**
   - **Commit:** `5c99849`
   - **File:** `packages/admin-api/src/services/telegram.ts:18-25`
   - **Fix:** Trim whitespace from API_DOMAIN and WEBHOOK_DOMAIN env vars

6. **Configurable Telegram Webhook Domain**
   - **Commit:** `0b0024d`
   - **File:** `packages/infra/src/constructs/admin-api.ts:118-126,535-545`
   - **Fix:** `telegramWebhookDomain` property to bypass Cloudflare Access

---

### 3. Voice Message Failures (2 issues)

**Issue Files:**
- `issue-1768766304100-agent-18-sp9g-*-high.json` - "send_voice_message failed on Telegram"
- `issue-1768775671754-agent-18-sp9g-*-high.json` - "send_voice_message failed: ffmpeg ENOENT"

**Status:** FIXED

**Root Cause:** ffmpeg binary not bundled with Lambda, audio format incompatibility with Telegram, URL fetch failures.

**Fixes Implemented:**

1. **ffmpeg Bundling & Path Resolution**
   - **Commit:** `41cca89`, `2b687c4`
   - **File:** `packages/admin-api/src/handlers/media-convert.ts:82-104`
   - **File:** `packages/infra/src/constructs/admin-api.ts:720-725`
   - **Fix:** Proper ffmpeg binary path resolution, bundled with Lambda via `nodeModules: ['ffmpeg-static']`

2. **Telegram sendVoice Error Handling & OGG Transcoding**
   - **Commit:** `b12e78f`
   - **File:** `packages/admin-api/src/services/voice.ts:122-151,1007-1042`
   - **Fix:** Audio transcoding via Lambda to OGG/Opus, multipart form upload instead of URL fetch

3. **Telegram Platform Adapter Enhanced Fallback**
   - **Commit:** `20fa392`
   - **File:** `packages/core/src/platforms/telegram.ts:479-495`
   - **Fix:** Fetch-to-InputFile helper with URL fallback

4. **Infrastructure Wiring for ffmpeg Lambda**
   - **File:** `packages/infra/src/constructs/avatar.ts:95-98,196-197,238-241`
   - **File:** `packages/infra/src/stacks/swarm-stack.ts:413`
   - **Fix:** MediaConvert Lambda environment variable and IAM permissions

---

### 4. Replicate API Issues (3 issues)

**Issue Files:**
- `issue-1768714171219-agent-6-1cc5-*-medium.json` - "Replicate API key not configured"
- `issue-1768801586018-agent-12-1pzv-*-high.json` - "Replicate API Key Configuration Not Persisting"
- `issue-1768826040376-agent-16-9uzw-*-medium.json` - "Image generation failing with version/permission error"

**Status:** FIXED

**Root Cause:** Cache invalidation issues, stale version hashes, incorrect auth header format.

**Fixes Implemented:**

1. **422 "Invalid version" Error Handling**
   - **Commit:** `7573259`
   - **File:** `packages/admin-api/src/services/media.ts:143-179,449-501`
   - **Fix:** `summarizeReplicateError()` function, fallback retry from version-based to model-based API

2. **System-Level Replicate Key Detection**
   - **Commit:** `6bdaa94`
   - **File:** `packages/admin-api/src/services/integrations.ts:34-77,275-284`
   - **Fix:** `hasSystemReplicateKeyConfigured()` with caching, multiple key name support

3. **Secret Management & Cache Invalidation**
   - **Commit:** `15dcef5`
   - **File:** `packages/admin-api/src/services/secrets.ts:91-93,330-352`
   - **Fix:** Cache invalidation on store, `ConsistentRead: true` flag

4. **Server-Side API Key Validation Endpoint**
   - **Commit:** `15dcef5`
   - **File:** `packages/admin-api/src/handlers/avatars.ts:443-506`
   - **Fix:** `POST /avatars/{id}/validate-ai-key` endpoint

5. **Auth Header Format Standardization**
   - **Files:** `packages/admin-api/src/services/media.ts:466,486,774,910`, `packages/admin-api/src/services/voice.ts:196,264,286`
   - **Fix:** Changed from `Bearer` to `Token` format for Replicate API

---

### 5. OpenRouter Credits Issues (3 issues)

**Issue Files:**
- `issue-1769066147034-agent-1-6yan-*-high.json` - "API credits exhausted despite recent top-up"
- `issue-1769069599877-agent-1-6yan-*-high.json` - "OpenRouter API 402 error - insufficient credits"
- `issue-1769072997046-agent-1-6yan-*-high.json` - "OpenRouter API credits not working despite top-up"

**Status:** FIXED (Error handling implemented)

**Note:** These issues are primarily user-side (account credits on OpenRouter). The codebase properly handles 402 errors.

**Implementation Details:**

1. **Error Parsing Layer**
   - **File:** `packages/admin-api/src/handlers/chat-error-mapping.ts:1-54`
   - **Fix:** `parseOpenRouterStatusFromError()` extracts 402 status, maps to "LLM credits required" message

2. **Retry Logic - 402 is NOT Retried**
   - **File:** `packages/admin-api/src/handlers/chat.ts:447`
   - **Fix:** Only retries 429/5xx, 402 fails immediately (appropriate behavior)

3. **Frontend Error Display**
   - **File:** `packages/admin-ui/src/components/ChatPanel.tsx:38-79`
   - **Fix:** `formatUserFacingError()` parses JSON error bodies from OpenRouter

---

### 6. User Experience Issues (1 issue)

**Issue Files:**
- `issue-1768705490701-agent-3-qkwg-*-medium.json` - "User reporting multiple broken items in interface"

**Status:** PARTIAL (Non-specific issue)

**Note:** This issue lacks specific details about what was broken. The other fixes in this log may address the underlying problems the user was experiencing.

---

## Verification Commands

To verify fixes are in place, run:

```bash
# Check Twitter fixes
git log --oneline --grep="Twitter" --since="2026-01-15"

# Check Telegram fixes
git log --oneline --grep="Telegram" --since="2026-01-15"

# Check voice/ffmpeg fixes
git log --oneline --grep="voice\|ffmpeg" --since="2026-01-15"

# Check Replicate fixes
git log --oneline --grep="Replicate\|replicate" --since="2026-01-15"
```

---

## Recommendations

1. **Monitor for regressions** - Continue tracking issues in `/issues/staging/`
2. **Add alerting** - Consider CloudWatch alarms for repeated 5xx errors on webhooks
3. **Documentation** - Update onboarding docs with common configuration issues
4. **Testing** - Add integration tests for Twitter/Telegram webhook flows

---

*End of Issue Review Log*
