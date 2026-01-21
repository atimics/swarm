# Proposal: Unified Integration Configuration

**Status:** Proposal (deferred until after M1)

This document is a design direction for post-MVP cleanup and unification. For current MVP sequencing and what to ship first, see:
- [docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md](../../../ROADMAP-M1-PAID-TELEGRAM-MVP.md)

## Executive Summary

This proposal introduces a unified configuration pattern for all integrations (platforms and AI providers) in AWS Swarm. It consolidates the scattered configuration for Replicate, Telegram, Twitter, Discord, and future integrations into a consistent, extensible architecture.

## Current State Analysis

### Integration Configuration Today

| Integration | Secrets | Settings | How Configured |
|-------------|---------|----------|----------------|
| **Telegram** | `telegram_bot_token`, `telegram_webhook_secret` | `platforms.telegram.enabled`, `botUsername`, `botId` | `configure_integration('telegram')` manual tool |
| **Twitter** | 5 OAuth tokens | `platforms.twitter.enabled`, `username` | `request_twitter_connection` OAuth flow |
| **Discord** | 4 secrets | `platforms.discord.*` (mode, intents, channels) | `configure_integration('discord')` manual tool |
| **Replicate** | `replicate_api_key` | None (hardcoded models in env vars) | Manual secret storage only |
| **OpenAI** | `openai_api_key` | None | Manual secret storage only |

### Problems with Current Approach

1. **Scattered Configuration**: Replicate is used for 5 different capabilities (audio generation, voice cloning, TTS, image generation, video generation), but there's no unified way to configure which models to use.

2. **Hardcoded Models**: Model selection is via environment variables (`STABLE_AUDIO_MODEL`, `VOICE_TTS_MODEL`, `DEFAULT_IMAGE_MODEL`, `DEFAULT_VIDEO_MODEL`) - not configurable per-avatar.

3. **No AI Provider Panel**: Unlike Telegram/Discord, there's no "Configure Replicate" or "Configure AI" panel in the chat interface.

4. **Inconsistent Patterns**: Platform integrations (Telegram, Discord) have a clean `configure_integration` flow, but AI providers don't.

5. **No Capability Mapping**: No clear association between integrations and what capabilities they enable.

---

## Proposed Architecture

### 1. Unified Integration Schema

```typescript
// packages/admin-api/src/types.ts

export type IntegrationType =
  // Platforms
  | 'telegram' | 'twitter' | 'discord' | 'web'
  // AI Providers
  | 'replicate' | 'openai' | 'anthropic' | 'openrouter'
  // Blockchain
  | 'solana' | 'ethereum';

export type AICapability =
  | 'image_generation'
  | 'video_generation'
  | 'audio_generation'    // abstract audio/music/sound effects
  | 'voice_clone'         // clone voice from reference
  | 'text_to_speech'      // generate speech from text
  | 'transcription'       // speech to text
  | 'llm';                // text generation

export interface IntegrationConfig {
  // Core fields (all integrations)
  type: IntegrationType;
  enabled: boolean;

  // What this integration provides when configured
  capabilities: AICapability[];

  // Required secrets (type -> display name)
  requiredSecrets: Record<SecretType, string>;

  // Optional settings schema (validated with zod)
  settings?: Record<string, unknown>;

  // Connection status
  status: 'not_configured' | 'configured' | 'error';
  statusMessage?: string;
  lastCheckedAt?: number;
}
```

### 2. AI Provider Configuration

```typescript
// packages/admin-api/src/types.ts

export interface AIProviderConfig {
  type: 'replicate' | 'openai' | 'anthropic' | 'openrouter';
  enabled: boolean;

  // API key status (not the actual key)
  hasApiKey: boolean;
  useGlobalKey: boolean;

  // Model preferences per capability
  models: {
    image_generation?: string;     // e.g., 'google/nano-banana-pro'
    video_generation?: string;     // e.g., 'minimax/video-01'
    audio_generation?: string;     // e.g., 'stability-ai/stable-audio-2.5'
    voice_clone?: string;          // e.g., 'lucataco/xtts-v2'
    text_to_speech?: string;       // e.g., 'lucataco/xtts-v2'
    transcription?: string;        // e.g., 'openai/whisper'
  };

  // Provider-specific settings
  settings?: {
    webhookUrl?: string;           // For async predictions
    pollIntervalMs?: number;       // For sync predictions
  };
}

// Updated AvatarRecord
export interface AvatarRecord {
  // ... existing fields ...

  // NEW: Unified integrations configuration
  integrations?: {
    // AI Providers
    replicate?: AIProviderConfig;
    openai?: AIProviderConfig;
    anthropic?: AIProviderConfig;
    openrouter?: AIProviderConfig;

    // Platform integrations (moved from platforms)
    telegram?: PlatformConfig;
    twitter?: PlatformConfig;
    discord?: PlatformConfig;
  };

  // DEPRECATED: Will be migrated to integrations
  platforms?: { ... };
  mediaConfig?: { ... };
  voiceConfig?: { ... };
}
```

### 3. Available Models Registry

```typescript
// packages/admin-api/src/services/models-registry.ts

export interface ModelInfo {
  id: string;                      // e.g., 'google/nano-banana-pro'
  name: string;                    // e.g., 'Nano Banana Pro'
  provider: 'replicate' | 'openai' | 'anthropic';
  capabilities: AICapability[];
  description: string;
  version?: string;                // Replicate model version hash
  tier: 'free' | 'standard' | 'premium';
  speed: 'fast' | 'medium' | 'slow';
  quality: 'draft' | 'standard' | 'high';
}

export const AVAILABLE_MODELS: ModelInfo[] = [
  // Image Generation
  {
    id: 'google/nano-banana-pro',
    name: 'Nano Banana Pro',
    provider: 'replicate',
    capabilities: ['image_generation'],
    description: 'Fast image generation with character reference support',
    tier: 'standard',
    speed: 'fast',
    quality: 'high',
  },
  {
    id: 'black-forest-labs/flux-schnell',
    name: 'FLUX Schnell',
    provider: 'replicate',
    capabilities: ['image_generation'],
    description: 'High-quality image generation',
    tier: 'standard',
    speed: 'fast',
    quality: 'high',
  },

  // Video Generation
  {
    id: 'minimax/video-01',
    name: 'Minimax Video',
    provider: 'replicate',
    capabilities: ['video_generation'],
    description: 'Text-to-video and image-to-video generation',
    tier: 'premium',
    speed: 'slow',
    quality: 'high',
  },

  // Audio/Voice
  {
    id: 'stability-ai/stable-audio-2.5',
    name: 'Stable Audio 2.5',
    provider: 'replicate',
    capabilities: ['audio_generation'],
    description: 'Generate music, sound effects, and abstract audio',
    tier: 'standard',
    speed: 'fast',
    quality: 'high',
  },
  {
    id: 'lucataco/xtts-v2',
    name: 'XTTS v2',
    provider: 'replicate',
    capabilities: ['voice_clone', 'text_to_speech'],
    description: 'Voice cloning and TTS from reference audio',
    tier: 'standard',
    speed: 'medium',
    quality: 'high',
  },

  // OpenAI models
  {
    id: 'gpt-4o-mini-tts',
    name: 'GPT-4o Mini TTS',
    provider: 'openai',
    capabilities: ['text_to_speech'],
    description: 'OpenAI text-to-speech',
    tier: 'standard',
    speed: 'fast',
    quality: 'high',
  },
  {
    id: 'whisper-1',
    name: 'Whisper',
    provider: 'openai',
    capabilities: ['transcription'],
    description: 'Speech-to-text transcription',
    tier: 'standard',
    speed: 'fast',
    quality: 'high',
  },
];
```

### 4. Extended Configure Integration Tool

```typescript
// packages/mcp-server/src/tools/admin.ts

export const CONFIGURABLE_INTEGRATIONS = [
  // Platforms
  'telegram',
  'twitter',
  'discord',
  // AI Providers (NEW)
  'replicate',
  'openai',
  'anthropic',
  'openrouter',
] as const;

// Integration metadata for UI rendering
export const INTEGRATION_METADATA: Record<string, IntegrationMetadata> = {
  telegram: {
    name: 'Telegram',
    icon: 'telegram',
    description: 'Connect to Telegram to receive and send messages',
    requiredSecrets: ['telegram_bot_token'],
    optionalSecrets: ['telegram_webhook_secret'],
    capabilities: [],
    configFields: [
      { key: 'botUsername', label: 'Bot Username', type: 'text' },
    ],
  },

  replicate: {
    name: 'Replicate',
    icon: 'replicate',
    description: 'AI models for image, video, audio, and voice generation',
    requiredSecrets: ['replicate_api_key'],
    optionalSecrets: [],
    capabilities: ['image_generation', 'video_generation', 'audio_generation', 'voice_clone', 'text_to_speech'],
    configFields: [
      {
        key: 'models.image_generation',
        label: 'Image Generation Model',
        type: 'select',
        options: () => getModelsForCapability('image_generation', 'replicate'),
        default: 'google/nano-banana-pro',
      },
      {
        key: 'models.video_generation',
        label: 'Video Generation Model',
        type: 'select',
        options: () => getModelsForCapability('video_generation', 'replicate'),
        default: 'minimax/video-01',
      },
      {
        key: 'models.audio_generation',
        label: 'Audio Generation Model',
        type: 'select',
        options: () => getModelsForCapability('audio_generation', 'replicate'),
        default: 'stability-ai/stable-audio-2.5',
      },
      {
        key: 'models.voice_clone',
        label: 'Voice Clone Model',
        type: 'select',
        options: () => getModelsForCapability('voice_clone', 'replicate'),
        default: 'lucataco/xtts-v2',
      },
      {
        key: 'useGlobalKey',
        label: 'Use Global API Key',
        type: 'checkbox',
        description: 'Use the system-wide Replicate key instead of avatar-specific',
        default: true,
      },
    ],
  },

  openai: {
    name: 'OpenAI',
    icon: 'openai',
    description: 'GPT models for LLM, TTS, and transcription',
    requiredSecrets: ['openai_api_key'],
    optionalSecrets: [],
    capabilities: ['llm', 'text_to_speech', 'transcription'],
    configFields: [
      {
        key: 'models.text_to_speech',
        label: 'TTS Model',
        type: 'select',
        options: () => getModelsForCapability('text_to_speech', 'openai'),
        default: 'gpt-4o-mini-tts',
      },
      {
        key: 'useGlobalKey',
        label: 'Use Global API Key',
        type: 'checkbox',
        default: true,
      },
    ],
  },
};
```

### 5. Admin UI Integration Panel Component

```typescript
// packages/admin-ui/src/components/IntegrationConfigPanel.tsx

interface IntegrationConfigPanelProps {
  integration: string;
  avatarId: string;
  currentConfig?: IntegrationConfig;
  onSave: (config: IntegrationConfig, secrets: Record<string, string>) => void;
  onCancel: () => void;
}

export function IntegrationConfigPanel({
  integration,
  avatarId,
  currentConfig,
  onSave,
  onCancel,
}: IntegrationConfigPanelProps) {
  const metadata = INTEGRATION_METADATA[integration];

  return (
    <div className="integration-config-panel">
      <header>
        <Icon name={metadata.icon} />
        <h2>Configure {metadata.name}</h2>
        <p>{metadata.description}</p>
      </header>

      {/* Secrets Section */}
      <section>
        <h3>API Credentials</h3>
        {metadata.requiredSecrets.map(secretType => (
          <SecretInput
            key={secretType}
            type={secretType}
            label={getSecretLabel(secretType)}
            required
            currentStatus={currentConfig?.secrets?.[secretType] ? 'set' : 'not_set'}
          />
        ))}
      </section>

      {/* Model Selection (for AI providers) */}
      {metadata.capabilities.length > 0 && (
        <section>
          <h3>Model Preferences</h3>
          {metadata.configFields
            .filter(f => f.key.startsWith('models.'))
            .map(field => (
              <ModelSelector
                key={field.key}
                field={field}
                currentValue={currentConfig?.settings?.[field.key]}
              />
            ))}
        </section>
      )}

      {/* Other Settings */}
      <section>
        <h3>Settings</h3>
        {metadata.configFields
          .filter(f => !f.key.startsWith('models.'))
          .map(field => (
            <ConfigField key={field.key} field={field} />
          ))}
      </section>

      {/* Test Connection */}
      <TestConnectionButton integration={integration} />

      <footer>
        <Button onClick={onCancel}>Cancel</Button>
        <Button primary onClick={handleSave}>Save Configuration</Button>
      </footer>
    </div>
  );
}
```

### 6. Service Layer Updates

```typescript
// packages/admin-api/src/services/integrations.ts

export async function getIntegrationStatus(
  avatarId: string,
  integration: IntegrationType
): Promise<IntegrationStatus> {
  const metadata = INTEGRATION_METADATA[integration];

  // Check if all required secrets are set
  const secretStatuses = await Promise.all(
    metadata.requiredSecrets.map(async (secretType) => {
      const hasSecret = await hasSecretValue(avatarId, secretType);
      const hasGlobal = await hasSecretValue('GLOBAL', secretType);
      return { secretType, hasSecret, hasGlobal };
    })
  );

  const allSecretsConfigured = secretStatuses.every(
    s => s.hasSecret || s.hasGlobal
  );

  // Get avatar config for this integration
  const avatar = await getAvatar(avatarId);
  const config = avatar?.integrations?.[integration];

  return {
    integration,
    status: allSecretsConfigured ? 'configured' : 'not_configured',
    enabled: config?.enabled ?? false,
    hasApiKey: secretStatuses.some(s => s.hasSecret),
    hasGlobalKey: secretStatuses.some(s => s.hasGlobal),
    useGlobalKey: config?.useGlobalKey ?? true,
    models: config?.models ?? {},
    capabilities: metadata.capabilities,
  };
}

export async function configureIntegration(
  avatarId: string,
  integration: IntegrationType,
  config: Partial<IntegrationConfig>,
  secrets: Record<SecretType, string>,
  session: UserSession
): Promise<void> {
  // Store secrets
  for (const [secretType, value] of Object.entries(secrets)) {
    if (value) {
      await storeSecret(avatarId, secretType as SecretType, value, session);
    }
  }

  // Update avatar integration config
  const avatar = await getAvatar(avatarId);
  const updatedIntegrations = {
    ...avatar.integrations,
    [integration]: {
      ...avatar.integrations?.[integration],
      ...config,
      enabled: true,
    },
  };

  await updateAvatar(avatarId, { integrations: updatedIntegrations }, session);

  // Trigger any post-configuration hooks (e.g., Telegram webhook setup)
  await runIntegrationPostConfig(avatarId, integration);
}

export async function testIntegrationConnection(
  avatarId: string,
  integration: IntegrationType
): Promise<{ success: boolean; message: string }> {
  const metadata = INTEGRATION_METADATA[integration];

  switch (integration) {
    case 'replicate':
      return testReplicateConnection(avatarId);
    case 'telegram':
      return testTelegramConnection(avatarId);
    case 'twitter':
      return testTwitterConnection(avatarId);
    case 'discord':
      return testDiscordConnection(avatarId);
    case 'openai':
      return testOpenAIConnection(avatarId);
    default:
      return { success: false, message: 'Unknown integration' };
  }
}

async function testReplicateConnection(avatarId: string): Promise<{ success: boolean; message: string }> {
  try {
    const apiKey = await getReplicateKey(avatarId);
    if (!apiKey) {
      return { success: false, message: 'No API key configured' };
    }

    // Test with a simple API call
    const response = await fetch('https://api.replicate.com/v1/account', {
      headers: { 'Authorization': `Token ${apiKey}` },
    });

    if (response.ok) {
      const data = await response.json();
      return {
        success: true,
        message: `Connected as ${data.username}`
      };
    } else {
      return {
        success: false,
        message: `API error: ${response.status}`
      };
    }
  } catch (error) {
    return {
      success: false,
      message: `Connection failed: ${error.message}`
    };
  }
}
```

---

## Migration Plan

### Phase 1: Add New Types (Non-Breaking)
1. Add `IntegrationConfig`, `AIProviderConfig` types
2. Add `integrations` field to `AvatarRecord` (optional)
3. Add `INTEGRATION_METADATA` registry
4. Add `models-registry.ts` with available models

### Phase 2: Service Layer Updates
1. Create `integrations.ts` service
2. Update `getReplicateKey()` to check `integrations.replicate.useGlobalKey`
3. Update `media.ts` to use `integrations.replicate.models.image_generation`
4. Update `voice.ts` to use `integrations.replicate.models.voice_clone`

### Phase 3: Admin Tool Updates
1. Extend `CONFIGURABLE_INTEGRATIONS` to include AI providers
2. Update `configure_integration` tool handler
3. Add `test_integration_connection` tool
4. Add `get_integration_status` tool

### Phase 4: Admin UI Updates
1. Create `IntegrationConfigPanel` component
2. Update chat tool rendering for AI provider configuration
3. Add model selection dropdowns

### Phase 5: Migration & Deprecation
1. Migrate existing `mediaConfig`, `voiceConfig` to `integrations`
2. Add deprecation warnings for old config paths
3. Remove deprecated fields in future release

---

## API Changes

### New Admin Tools

```typescript
// Get all integration statuses for an avatar
get_integration_statuses(avatarId: string): IntegrationStatus[]

// Configure a specific integration
configure_integration(
  integration: IntegrationType,
  config: Partial<IntegrationConfig>,
  secrets: Record<string, string>
): void

// Test integration connection
test_integration_connection(integration: IntegrationType): TestResult

// Get available models for a capability
get_available_models(
  capability: AICapability,
  provider?: string
): ModelInfo[]

// Set model preference for a capability
set_model_preference(
  capability: AICapability,
  modelId: string
): void
```

---

## Benefits

1. **Unified Configuration**: All integrations (platforms + AI providers) follow the same pattern
2. **Per-Avatar Model Selection**: Avatars can choose different models for different capabilities
3. **Chat-First Experience**: Configuration happens in chat via manual tools
4. **Extensible**: Easy to add new integrations (Discord, Eleven Labs, etc.)
5. **Self-Documenting**: `INTEGRATION_METADATA` describes what each integration needs
6. **Testable**: Built-in connection testing for all integrations
7. **Backwards Compatible**: Migration path from old config to new

---

## Future Integrations

This pattern supports easy addition of:

- **Eleven Labs**: TTS and voice cloning
- **Midjourney**: Image generation (via proxy)
- **Runway**: Video generation
- **AssemblyAI**: Transcription
- **Helius**: Solana RPC
- **Alchemy**: Ethereum RPC

Each new integration just needs:
1. Entry in `INTEGRATION_METADATA`
2. Entry in `CONFIGURABLE_INTEGRATIONS`
3. Service implementation
4. Test connection function

---

## Open Questions

1. **Global vs Avatar Keys**: Should we allow mixing (avatar-specific for some capabilities, global for others)?

2. **Model Versioning**: Replicate models have versions - should we pin versions or always use latest?

3. **Cost Tracking**: Should we track API costs per integration per avatar?

4. **Rate Limiting**: Should integrations have configurable rate limits?

5. **Fallback Chain**: Should we support fallback providers (e.g., if Replicate fails, try OpenAI)?
