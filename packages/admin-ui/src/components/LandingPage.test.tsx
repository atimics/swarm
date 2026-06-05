import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LandingPage } from './LandingPage';
import { useAuthStore } from '../store/auth';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'auth.loginWithPrivy': 'Login',
        'landing.primaryCta': 'Get Started',
        'landing.pricingTitle': 'Start free. Upgrade for expanded limits.',
        'landing.featureMultiDesc':
          'Connect your own Telegram, Discord, and X credentials. Same voice in every group; per-platform memory by default.',
        'landing.comparison4': 'Choose from the OpenRouter model catalog per avatar',
        'landing.tierFreeButton': 'Get Started',
        'landing.tierCreatorButton': 'Get Started',
      };
      return labels[key] ?? key;
    },
    i18n: {
      language: 'en',
      changeLanguage: vi.fn(),
    },
  }),
}));

describe('LandingPage', () => {
  beforeEach(() => {
    useAuthStore.getState().resetLocal();
  });

  it('renders login buttons on free and creator tiers', () => {
    render(<LandingPage />);

    const pricing = screen.getByRole('region', { name: 'Start free. Upgrade for expanded limits.' });
    const pricingButtons = within(pricing).getAllByRole('button', { name: 'Get Started' });

    expect(pricingButtons).toHaveLength(2);
  });

  it('uses precise platform and model-selection claims', () => {
    render(<LandingPage />);

    expect(
      screen.getByText('Connect your own Telegram, Discord, and X credentials. Same voice in every group; per-platform memory by default.'),
    ).toBeDefined();

    expect(
      screen.getByText('Choose from the OpenRouter model catalog per avatar'),
    ).toBeDefined();
  });
});
