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
    <div className="min-h-[100dvh] bg-[var(--color-bg)] flex flex-col relative overflow-hidden">
      {/* Layered background gradients */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(122,99,149,0.3),transparent)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_40%_at_80%_60%,rgba(167,139,250,0.08),transparent)]" />
      </div>

      {/* Safe area spacer for iOS */}
      <div
        className="flex-shrink-0"
        style={{ height: 'env(safe-area-inset-top, 0px)' }}
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12 z-10">
        {/* Logo and title */}
        <div className="flex items-center gap-3 mb-4">
          <img src="/swarm.svg" alt="Swarm" className="w-14 h-14 drop-shadow-[0_0_12px_rgba(122,99,149,0.5)]" />
          <h1 className="text-4xl font-bold tracking-tight text-[var(--color-text)]">Swarm</h1>
        </div>

        {/* Tagline */}
        <p className="text-lg text-[var(--color-text-secondary)] text-center mb-2 max-w-sm">
          Your AI. Your voice. On-chain.
        </p>
        <p className="text-sm text-[var(--color-text-muted)] text-center mb-10 max-w-md">
          Create autonomous AI avatars on Solana — connect them to Telegram, Twitter, and Discord.
        </p>

        {/* Feature cards */}
        <div className="grid gap-3 mb-10 max-w-lg w-full">
          <FeatureCard
            icon={<AvatarIcon />}
            title="Create Your Avatar"
            description="Every wallet gets one free AI avatar. Configure its personality, voice, and channel integrations."
          />
          <FeatureCard
            icon={<InhabitIcon />}
            title="Inhabit & Evolve"
            description="Take control of unclaimed avatars. Each era of inhabitation shapes its memories and personality."
          />
          <FeatureCard
            icon={<OrbIcon />}
            title="Collect Orbs"
            description="Hold Orb NFTs to unlock additional avatar slots, premium models, and exclusive features."
          />
        </div>

        {/* Login options */}
        <LoginOptions className="w-full max-w-sm" />
      </div>

      {/* Footer */}
      <footer className="py-6 text-center text-xs text-[var(--color-text-muted)] space-y-1.5 z-10">
        <p className="flex items-center justify-center gap-1.5">
          <span>Powered by</span>
          <span className="font-medium text-[var(--color-text-tertiary)]">Solana</span>
          <span className="text-[var(--color-border-secondary)]">·</span>
          <span>Built with</span>
          <span className="font-medium text-[var(--color-text-tertiary)]">AI</span>
        </p>
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
  icon: React.ReactNode;
  title: string;
  description: string;
}

function FeatureCard({ icon, title, description }: FeatureCardProps) {
  return (
    <div className="flex items-start gap-4 p-4 rounded-xl bg-[var(--color-bg-secondary)]/60 backdrop-blur-sm border border-[var(--color-border)] hover:border-brand-500/40 transition-all group">
      <div className="w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-lg bg-brand-500/10 border border-brand-500/20 text-brand-300 group-hover:bg-brand-500/15 group-hover:border-brand-500/30 transition-all">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-[var(--color-text)] mb-0.5 text-sm">{title}</h3>
        <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">{description}</p>
      </div>
    </div>
  );
}

/* ---- Inline SVG Icons ---- */

function AvatarIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
    </svg>
  );
}

function InhabitIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
    </svg>
  );
}

function OrbIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
    </svg>
  );
}

