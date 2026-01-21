# Proposal: Unified Media Service Architecture

**Status:** Proposal (partially superseded by current implementation; defer big changes until after M1)

Repo note (2026-01-21): this document references a `core/tools/executor.ts` path that does not exist in the current repo. The active convergence work is happening through the core media service and dependency-injected resolvers.

For MVP sequencing and what is actually on the critical path right now, see:
- [docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md](../../../ROADMAP-M1-PAID-TELEGRAM-MVP.md)

## UPDATED: Audit Findings (2026-01-19)

**Critical Discovery (historical note)**: earlier drafts referenced `core/tools/executor.ts` as dead code, but this repo no longer contains that file/path. Treat “core executor” references below as **outdated context** rather than an active cleanup task.

### Actual Active Code Paths (Only 2, Not 5)

| Path | Location | Status | Used By |
|------|----------|--------|---------|
| **Platform Handlers** | `core/services/media/index.ts` | ACTIVE | media-processor, tweet-poster, message-processor |
| **Admin UI/MCP** | `admin-api/services/media.ts` | ACTIVE | HTTP routes, MCP tools |
| ~~Core Executor~~ | ~~`core/tools/executor.ts`~~ | N/A | Not present in current repo |

### Quick Win Already Implemented

The config-sync.ts fix ensures model preferences flow correctly:
```
Admin UI → integrations.replicate.models.image_generation
    ↓ (config-sync.ts - FIXED)
State Table → media.image.model
    ↓
Platform Handlers → avatarConfig.media.image
    ↓
Core Media Service → generateImageReplicate(prompt, config.model)
```

---

## Current State Analysis

### The Problem: 5+ Code Paths for Image Generation

| Path | Location | Model Config | API Key | S3 Upload | Gallery | Credits |
|------|----------|--------------|---------|-----------|---------|---------|
| Admin API sync | `admin-api/services/media.ts` | Full resolution | System + Avatar | Yes | Yes | Yes |
| Admin API async | Same file | Full resolution | System + Avatar | Yes | Yes | Yes |
| Core Executor | `core/tools/executor.ts` | N/A | N/A | N/A | N/A | N/A |
| Media Processor | `handlers/media-processor.ts` | Avatar only | System + Avatar | Yes | No | No |
| SwarmMediaService | `core/services/media/index.ts` | Param only | Param only | Yes | No | No |

### Key Inconsistencies

1. **Model Resolution**: Admin API checks `integrations.replicate.models.image_generation` (user preference), but platform handlers only check `media.image.model` (defaults). This means **avatar model preferences set via admin UI are ignored by platform handlers**.

2. **Credit System Bypassed**: Platform handlers don't check or consume credits, meaning free tier limits don't apply to Telegram/Discord/Twitter.

3. **Gallery Not Updated**: Images generated via platform handlers don't appear in the avatar's gallery.

4. **Reference Images Ignored**: Platform handlers can't use character reference for visual consistency.

5. **Duplicated Replicate Logic**: The same polling/error handling code exists in 3 places.

---

## Proposed Architecture

### Single Authoritative Service

```
┌─────────────────────────────────────────────────────────────────────┐
│                     MediaGenerationService                          │
│  (packages/core/src/services/media-generation/index.ts)            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ Model        │  │ API Key      │  │ Credits      │              │
│  │ Resolver     │  │ Resolver     │  │ Manager      │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │              Provider Adapters                               │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │   │
│  │  │ Replicate│  │ OpenAI   │  │ OpenRouter│  │ Future   │    │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ S3 Storage   │  │ Gallery      │  │ Job Tracking │              │
│  │ Manager      │  │ Manager      │  │ (async)      │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
   ┌──────────┐        ┌──────────┐        ┌──────────┐
   │ Admin API│        │ Platform │        │ MCP      │
   │ Handlers │        │ Handlers │        │ Tools    │
   └──────────┘        └──────────┘        └──────────┘
```

### Core Interface

```typescript
// packages/core/src/services/media-generation/types.ts

export interface MediaGenerationRequest {
  avatarId: string;
  prompt: string;

  // Optional overrides (avatar config used if not provided)
  model?: string;
  provider?: 'replicate' | 'openai' | 'openrouter';

  // Reference images for consistency
  referenceImageUrls?: string[];
  useCharacterReference?: boolean;  // Auto-fetch from avatar config

  // Output options
  resolution?: '1K' | '2K' | '4K';
  aspectRatio?: AspectRatio;

  // Context for gallery/tracking
  platform?: Platform;
  conversationId?: string;
  replyToMessageId?: string;

  // Behavior flags
  saveToGallery?: boolean;      // Default: true
  checkCredits?: boolean;       // Default: true
  async?: boolean;              // Default: false (sync with polling)
}

export interface MediaGenerationResult {
  success: boolean;

  // For sync results
  url?: string;
  s3Key?: string;
  galleryId?: string;

  // For async results
  jobId?: string;
  status?: 'pending' | 'processing' | 'completed' | 'failed';

  // Metadata
  model: string;
  provider: string;
  prompt: string;
  creditsConsumed?: number;

  error?: string;
}

export interface MediaGenerationService {
  generateImage(request: MediaGenerationRequest): Promise<MediaGenerationResult>;
  generateVideo(request: MediaGenerationRequest): Promise<MediaGenerationResult>;
  generateSticker(request: MediaGenerationRequest): Promise<MediaGenerationResult>;

  // Job management (for async)
  getJob(jobId: string): Promise<MediaJob | null>;
  pollJob(jobId: string): Promise<MediaGenerationResult>;
}
```

### Resolver Components

```typescript
// Model Resolver - Unified model selection
export interface ModelResolver {
  resolveModel(
    avatarId: string,
    capability: 'image_generation' | 'video_generation' | 'sticker_generation'
  ): Promise<{ model: string; provider: string; version?: string }>;
}

// Resolution order:
// 1. Request override (if provided)
// 2. Avatar's integration config: integrations.replicate.models.{capability}
// 3. Avatar's media config: media.image.model (legacy)
// 4. System default: DEFAULT_MODELS[capability]
```

```typescript
// API Key Resolver - Unified key retrieval
export interface ApiKeyResolver {
  resolveApiKey(avatarId: string, provider: string): Promise<{
    key: string;
    source: 'avatar' | 'system' | 'trial';
    trialCreditsRemaining?: number;
  }>;
}

// Resolution order:
// 1. Avatar-specific secret in DynamoDB
// 2. System key (env var, Secrets Manager, or DynamoDB global)
// 3. Trial credits (if system key, limited usage)
```

---

## Migration Path

### Phase 1: Extract Shared Logic (Non-breaking)

1. Create `packages/core/src/services/media-generation/` with:
   - `model-resolver.ts` - Extracted from admin-api
   - `api-key-resolver.ts` - Extracted from admin-api
   - `replicate-adapter.ts` - Unified Replicate API code
   - `storage-manager.ts` - S3 upload logic

2. Update admin-api to use new shared components (internal refactor)

### Phase 2: Update Platform Handlers

1. Update `media-processor.ts` to use unified service:
   ```typescript
   // Before
   const media = await mediaService.generateImage(prompt, avatarConfig.media.image);

   // After
   const result = await mediaGenerationService.generateImage({
     avatarId,
     prompt,
     platform: 'telegram',
     conversationId,
     saveToGallery: true,
     checkCredits: true,
   });
   ```

2. Model resolution now respects `integrations.replicate.models.image_generation`

3. Gallery integration happens automatically

4. Credits are checked/consumed

### Phase 3: Deprecate Old Paths

1. Mark `SwarmMediaService` as deprecated (keep for backward compat)
2. Remove `executeImageGeneration` from core executor (unused)
3. Update MCP adapter to use unified service directly

---

## Benefits

### For Users
- **Consistent behavior**: Same model, same quality everywhere
- **Gallery works**: All generated images appear in gallery
- **Credits enforced**: Fair usage limits apply everywhere

### For Developers
- **Single source of truth**: One place to update Replicate API logic
- **Easier testing**: Mock one service instead of many
- **Clear configuration**: One path for model/key resolution

### For Operations
- **Better observability**: All generation goes through one service
- **Easier debugging**: Consistent logging and error handling
- **Simpler updates**: Model changes apply everywhere

---

## Configuration Consolidation

### Current (Confusing)
```typescript
// Used by admin-api
avatar.integrations.replicate.models.image_generation

// Used by platform handlers
avatar.media.image.model

// Different defaults in different places
```

### Proposed (Clear)
```typescript
// Primary source (set via admin UI)
avatar.integrations.replicate.models.image_generation

// Legacy fallback (for backward compat)
avatar.media.image.model

// System default (if neither set)
DEFAULT_MODELS.image_generation = 'black-forest-labs/flux-schnell'
```

The unified service checks in this order, so existing configs continue to work.

---

## Implementation Priority

1. **High Priority**: Model resolution unification
   - Platform handlers should respect admin UI model selection
   - Affects user experience directly

2. **Medium Priority**: Gallery integration
   - Platform-generated images should appear in gallery
   - Enables "post to Twitter" from gallery

3. **Medium Priority**: Credit system integration
   - Prevents abuse of system Replicate key
   - Fair usage for free tier

4. **Lower Priority**: Reference image support
   - Character consistency in platform responses
   - Nice-to-have for visual coherence

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking existing handlers | Feature flags for gradual rollout |
| Performance regression | Keep sync path optimized, async for long jobs |
| Configuration migration | Support both old and new config locations |
| API key resolution complexity | Clear logging of which key source was used |

---

## Open Questions

1. Should platform handlers call admin-api HTTP endpoints, or should we extract to a shared package?
   - **Recommendation**: Shared package to avoid network latency in hot path

2. Should all generations be async (job-based) for consistency?
   - **Recommendation**: No, keep sync for fast models (<5s), async for slow ones

3. How to handle rate limiting at the unified service level?
   - **Recommendation**: Integrate with existing credits system, add per-avatar quotas
