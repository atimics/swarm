import type { AvatarConfig } from '@swarm/core';

export function extractAvatarConfigFromStateItem(item: unknown): AvatarConfig | null {
  if (!item || typeof item !== 'object') return null;

  // Current shape in the state table: { pk, sk: 'CONFIG', config: AvatarConfig, ... }
  if ('config' in item) {
    const nested = (item as { config?: unknown }).config;
    if (nested && typeof nested === 'object') {
      return nested as AvatarConfig;
    }
  }

  // Legacy shape (or direct reads): item is AvatarConfig
  return item as AvatarConfig;
}
