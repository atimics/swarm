/**
 * Landing Page - Shown to unauthenticated users
 * Explains what the platform is and guides users to sign in
 */
import { useState } from 'react';
import { LoginOptions } from './LoginOptions';
import { PrivacyPolicy } from './PrivacyPolicy';

export function LandingPage() {
  const [showPrivacy, setShowPrivacy] = useState(false);

  if (showPrivacy) {
    return <PrivacyPolicy onClose={() => setShowPrivacy(false)} />;
  }

  return (
    <div className="min-h-[100dvh] bg-[var(--color-bg)] flex flex-col">
      {/* Safe area spacer for iOS */}
      <div 
        className="flex-shrink-0" 
        style={{ height: 'env(safe-area-inset-top, 0px)' }} 
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        {/* Logo and title */}
        <div className="flex items-center gap-3 mb-8">
          <img src="/swarm.svg" alt="Swarm" className="w-12 h-12" />
          <h1 className="text-3xl font-bold text-[var(--color-text)]">Swarm</h1>
        </div>

        {/* Tagline */}
        <p className="text-xl text-[var(--color-text-secondary)] text-center mb-12 max-w-md">
          Create and inhabit AI avatars on Solana
        </p>

        {/* Feature cards */}
        <div className="grid gap-4 mb-12 max-w-lg w-full">
          <FeatureCard
            icon="🤖"
            title="Create Your Avatar"
            description="Every wallet gets one free AI avatar. Configure its personality, connect it to Telegram, Twitter, and more."
          />
          <FeatureCard
            icon="👻"
            title="Inhabit & Evolve"
            description="Take control of unclaimed avatars or create your own. Your avatar evolves through each era of inhabitation."
          />
          <FeatureCard
            icon="🔮"
            title="Collect Orbs"
            description="Hold Orb NFTs to unlock additional avatar slots and exclusive features."
          />
        </div>

        {/* Login options */}
        <LoginOptions className="w-full max-w-sm" />
      </div>

      {/* Footer */}
      <footer className="py-6 text-center text-xs text-[var(--color-text-muted)] space-y-1">
        <p>Powered by Solana • Built with AI</p>
        <button
          onClick={() => setShowPrivacy(true)}
          className="underline hover:text-[var(--color-text-secondary)] transition-colors"
        >
          Privacy Policy
        </button>
      </footer>

      {/* Safe area spacer for iOS home indicator */}
      <div 
        className="flex-shrink-0" 
        style={{ height: 'env(safe-area-inset-bottom, 0px)' }} 
      />
    </div>
  );
}

interface FeatureCardProps {
  icon: string;
  title: string;
  description: string;
}

function FeatureCard({ icon, title, description }: FeatureCardProps) {
  return (
    <div className="flex items-start gap-4 p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
      <span className="text-2xl">{icon}</span>
      <div>
        <h3 className="font-semibold text-[var(--color-text)] mb-1">{title}</h3>
        <p className="text-sm text-[var(--color-text-secondary)]">{description}</p>
      </div>
    </div>
  );
}

