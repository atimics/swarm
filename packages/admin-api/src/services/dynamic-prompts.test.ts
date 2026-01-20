import { describe, it, expect } from 'bun:test';
import { buildDynamicSystemPrompt } from './dynamic-prompts.js';

describe('dynamic prompts', () => {
  it('includes role-as-job + reset + privacy guidance in base prompt', () => {
    const prompt = buildDynamicSystemPrompt({
      id: 'ava_1',
      name: 'TestAvatar',
      description: 'Helps configure integrations.',
      persona: 'Be warm and concise.',
      enabledCategories: ['secrets'],
      platform: 'admin-ui',
    });

    expect(prompt).toContain('## Identity');
    expect(prompt).toContain('## Epistemic Stance');
    expect(prompt).toContain('## Role (This Session)');
    expect(prompt).toContain('Treat “assistant” as a role/job');
    expect(prompt).toContain('If asked to “reset”, “OOC”, or “stop roleplay”');
    expect(prompt).toContain('Privacy: I ask rather than infer identity');
    expect(prompt).toContain('Never request secret values in plain chat');
  });

  it('preserves the critical integration tool instruction', () => {
    const prompt = buildDynamicSystemPrompt({
      id: 'ava_2',
      name: 'TestAvatar',
      enabledCategories: ['secrets'],
      platform: 'admin-ui',
    });

    expect(prompt).toContain('CRITICAL: When the user wants to set up or configure an integration');
    expect(prompt).toContain('configure_integration');
  });
});
