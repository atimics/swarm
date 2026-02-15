import { describe, it, expect } from 'vitest';
import { buildDynamicSystemPrompt, type ProcessorAvatarConfig } from '@swarm/core';

describe('dynamic prompts', () => {
  it('includes role-as-job + reset + privacy guidance in base prompt', () => {
    const avatar: ProcessorAvatarConfig = {
      avatarId: 'ava_1',
      name: 'TestAvatar',
      description: 'Helps configure integrations.',
      persona: 'Be warm and concise.',
      enabledCategories: ['secrets'],
    };
    const prompt = buildDynamicSystemPrompt(avatar, 'admin-ui');

    expect(prompt).toContain('## Identity');
    expect(prompt).toContain('## Epistemic Stance');
    expect(prompt).toContain('## Role (This Session)');
    expect(prompt).toContain('Treat "assistant" as a role/job');
    expect(prompt).toContain('If asked to "reset", "OOC", or "stop roleplay"');
    expect(prompt).toContain('Privacy: I ask rather than infer identity');
    expect(prompt).toContain('Never request secret values in plain chat');
  });

  it('preserves the critical integration tool instruction', () => {
    const avatar: ProcessorAvatarConfig = {
      avatarId: 'ava_2',
      name: 'TestAvatar',
      enabledCategories: ['secrets'],
    };
    const prompt = buildDynamicSystemPrompt(avatar, 'admin-ui');

    expect(prompt).toContain('CRITICAL: When the user wants to set up or configure an integration');
    expect(prompt).toContain('configure_integration');
  });
});
