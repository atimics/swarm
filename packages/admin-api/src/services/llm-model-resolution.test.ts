import { describe, it, expect } from 'vitest';
import { resolveChatModel } from './models-registry.js';

describe('resolveChatModel', () => {
  it('prefers request model over avatar model', () => {
    expect(
      resolveChatModel({
        requestModel: 'anthropic/claude-opus-4',
        avatarModel: 'anthropic/claude-haiku-4.5',
        defaultModel: 'openai/gpt-4o-mini',
      })
    ).toBe('anthropic/claude-opus-4');
  });

  it('falls back to avatar model when request model is missing/blank', () => {
    expect(
      resolveChatModel({
        requestModel: '   ',
        avatarModel: 'anthropic/claude-sonnet-4',
        defaultModel: 'openai/gpt-4o-mini',
      })
    ).toBe('anthropic/claude-sonnet-4');
  });

  it('falls back to default model when neither request nor avatar specify a model', () => {
    expect(
      resolveChatModel({
        requestModel: undefined,
        avatarModel: null,
        defaultModel: 'anthropic/claude-haiku-4.5',
      })
    ).toBe('anthropic/claude-haiku-4.5');
  });
});
