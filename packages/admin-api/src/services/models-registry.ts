/**
 * Models Registry
 * Catalog of available AI models for each provider and capability.
 */
import type { AICapability } from '../types.js';

/**
 * Information about an AI model
 */
export interface ModelInfo {
  id: string;                      // Model identifier (e.g., 'google/nano-banana-pro')
  name: string;                    // Display name
  provider: 'replicate' | 'openai' | 'anthropic' | 'openrouter';
  capabilities: AICapability[];   // What this model can do
  description: string;
  version?: string;               // For Replicate: model version hash
  tier: 'free' | 'standard' | 'premium';
  speed: 'fast' | 'medium' | 'slow';
  quality: 'draft' | 'standard' | 'high';
  isDefault?: boolean;            // Whether this is the default for its capability
}

/**
 * Replicate model versions (required for predictions API)
 * Models using the /models/{owner}/{name}/predictions endpoint don't need versions
 */
export const REPLICATE_MODEL_VERSIONS: Record<string, string | undefined> = {
  'google/nano-banana-pro': '58b32e7d9b4e25d727c98ee665e1aabdf9673a3ab6693ce5fe4b68f8cd5dc8f5',
  'black-forest-labs/flux-schnell': 'f2ab8a5bfe79f02f0789a146cf5e73d2a4ff2684a98c2b303d1e1ff3814271db',
  // Models below use the model API endpoint, not version-based predictions
  'minimax/video-01': undefined,
  'stability-ai/stable-audio-2.5': undefined,
  'lucataco/xtts-v2': undefined,
};

/**
 * Available models registry
 */
export const AVAILABLE_MODELS: ModelInfo[] = [
  // ==========================================================================
  // IMAGE GENERATION
  // ==========================================================================
  {
    id: 'google/nano-banana-pro',
    name: 'Nano Banana Pro',
    provider: 'replicate',
    capabilities: ['image_generation'],
    description: 'Fast image generation with character reference support. Great for consistent character images.',
    version: REPLICATE_MODEL_VERSIONS['google/nano-banana-pro'],
    tier: 'standard',
    speed: 'fast',
    quality: 'high',
    isDefault: true,
  },
  {
    id: 'black-forest-labs/flux-schnell',
    name: 'FLUX Schnell',
    provider: 'replicate',
    capabilities: ['image_generation'],
    description: 'High-quality, fast image generation. Good general-purpose model.',
    version: REPLICATE_MODEL_VERSIONS['black-forest-labs/flux-schnell'],
    tier: 'standard',
    speed: 'fast',
    quality: 'high',
  },
  {
    id: 'black-forest-labs/flux-dev',
    name: 'FLUX Dev',
    provider: 'replicate',
    capabilities: ['image_generation'],
    description: 'Development version of FLUX with more features.',
    tier: 'premium',
    speed: 'medium',
    quality: 'high',
  },

  // ==========================================================================
  // VIDEO GENERATION
  // ==========================================================================
  {
    id: 'minimax/video-01',
    name: 'Minimax Video',
    provider: 'replicate',
    capabilities: ['video_generation'],
    description: 'Text-to-video and image-to-video generation. Creates short video clips.',
    tier: 'premium',
    speed: 'slow',
    quality: 'high',
    isDefault: true,
  },
  {
    id: 'luma/ray',
    name: 'Luma Ray',
    provider: 'replicate',
    capabilities: ['video_generation'],
    description: 'High-quality video generation with good motion.',
    tier: 'premium',
    speed: 'slow',
    quality: 'high',
  },

  // ==========================================================================
  // AUDIO GENERATION
  // ==========================================================================
  {
    id: 'stability-ai/stable-audio-2.5',
    name: 'Stable Audio 2.5',
    provider: 'replicate',
    capabilities: ['audio_generation'],
    description: 'Generate music, sound effects, and abstract audio from text prompts.',
    tier: 'standard',
    speed: 'fast',
    quality: 'high',
    isDefault: true,
  },

  // ==========================================================================
  // VOICE CLONE / TTS
  // ==========================================================================
  {
    id: 'lucataco/xtts-v2',
    name: 'XTTS v2',
    provider: 'replicate',
    capabilities: ['voice_clone', 'text_to_speech'],
    description: 'Voice cloning and text-to-speech from a reference audio sample.',
    tier: 'standard',
    speed: 'medium',
    quality: 'high',
    isDefault: true,
  },
  {
    id: 'gpt-4o-mini-tts',
    name: 'GPT-4o Mini TTS',
    provider: 'openai',
    capabilities: ['text_to_speech'],
    description: 'OpenAI text-to-speech with multiple voice options.',
    tier: 'standard',
    speed: 'fast',
    quality: 'high',
  },

  // ==========================================================================
  // TRANSCRIPTION
  // ==========================================================================
  {
    id: 'whisper-1',
    name: 'Whisper',
    provider: 'openai',
    capabilities: ['transcription'],
    description: 'Speech-to-text transcription with high accuracy.',
    tier: 'standard',
    speed: 'fast',
    quality: 'high',
    isDefault: true,
  },
  {
    id: 'openai/whisper',
    name: 'Whisper (Replicate)',
    provider: 'replicate',
    capabilities: ['transcription'],
    description: 'Whisper model running on Replicate infrastructure.',
    tier: 'standard',
    speed: 'medium',
    quality: 'high',
  },

  // ==========================================================================
  // LLM (for reference, typically configured separately)
  // ==========================================================================
  {
    id: 'anthropic/claude-3-5-sonnet-latest',
    name: 'Claude 3.5 Sonnet',
    provider: 'anthropic',
    capabilities: ['llm'],
    description: 'Fast, intelligent model for most tasks.',
    tier: 'standard',
    speed: 'fast',
    quality: 'high',
    isDefault: true,
  },
  {
    id: 'anthropic/claude-3-opus-latest',
    name: 'Claude 3 Opus',
    provider: 'anthropic',
    capabilities: ['llm'],
    description: 'Most capable model for complex reasoning.',
    tier: 'premium',
    speed: 'medium',
    quality: 'high',
  },
  {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    capabilities: ['llm'],
    description: 'OpenAI multimodal model.',
    tier: 'standard',
    speed: 'fast',
    quality: 'high',
  },
];

/**
 * Get models for a specific capability
 */
export function getModelsForCapability(
  capability: AICapability,
  provider?: string
): ModelInfo[] {
  return AVAILABLE_MODELS.filter(
    (model) =>
      model.capabilities.includes(capability) &&
      (!provider || model.provider === provider)
  );
}

/**
 * Get the default model for a capability
 */
export function getDefaultModel(
  capability: AICapability,
  provider?: string
): ModelInfo | undefined {
  const models = getModelsForCapability(capability, provider);
  return models.find((m) => m.isDefault) || models[0];
}

/**
 * Get model by ID
 */
export function getModelById(id: string): ModelInfo | undefined {
  return AVAILABLE_MODELS.find((m) => m.id === id);
}

/**
 * Get all models for a provider
 */
export function getModelsForProvider(provider: string): ModelInfo[] {
  return AVAILABLE_MODELS.filter((m) => m.provider === provider);
}

/**
 * Get the Replicate version hash for a model (if applicable)
 */
export function getReplicateVersion(modelId: string): string | undefined {
  return REPLICATE_MODEL_VERSIONS[modelId];
}

/**
 * Default model IDs by capability
 */
export const DEFAULT_MODELS: Record<AICapability, string> = {
  image_generation: 'google/nano-banana-pro',
  video_generation: 'minimax/video-01',
  audio_generation: 'stability-ai/stable-audio-2.5',
  voice_clone: 'lucataco/xtts-v2',
  text_to_speech: 'lucataco/xtts-v2',
  transcription: 'whisper-1',
  llm: 'anthropic/claude-3-5-sonnet-latest',
};
