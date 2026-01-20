import { describe, it, expect } from 'bun:test';
import { extractAvatarConfigFromStateItem } from './extract-avatar-config.js';

describe('extractAvatarConfigFromStateItem', () => {
  it('extracts config from the nested state-table shape', () => {
    const cfg = extractAvatarConfigFromStateItem({
      pk: 'AVATAR#test',
      sk: 'CONFIG',
      config: { id: 'test', llm: { model: 'anthropic/claude-opus-4' } },
    });

    expect(cfg?.id).toBe('test');
    expect(cfg?.llm?.model).toBe('anthropic/claude-opus-4');
  });

  it('passes through legacy direct config items', () => {
    const cfg = extractAvatarConfigFromStateItem({
      id: 'legacy',
      llm: { model: 'anthropic/claude-haiku-4.5' },
    });

    expect(cfg?.id).toBe('legacy');
    expect(cfg?.llm?.model).toBe('anthropic/claude-haiku-4.5');
  });

  it('returns null for non-objects', () => {
    expect(extractAvatarConfigFromStateItem(null)).toBeNull();
    expect(extractAvatarConfigFromStateItem('nope')).toBeNull();
  });
});
