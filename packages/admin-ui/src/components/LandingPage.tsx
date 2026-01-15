/**
 * Landing Page - Shown to unauthenticated users
 * Explains what the platform is and guides users to connect a Solana wallet
 */
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useWalletAuth } from '../store/walletAuth';

export function LandingPage() {
  const { setVisible } = useWalletModal();
  const { isLoading } = useWalletAuth();

  const handleConnect = () => {
    setVisible(true);
  };

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
          Create and inhabit AI agents on Solana
        </p>

        {/* Feature cards */}
        <div className="grid gap-4 mb-12 max-w-lg w-full">
          <FeatureCard
            icon="🤖"
            title="Create Your Agent"
            description="Every wallet gets one free AI agent. Configure its personality, connect it to Telegram, Twitter, and more."
          />
          <FeatureCard
            icon="👻"
            title="Inhabit & Evolve"
            description="Take control of unclaimed agents or create your own. Your agent evolves through each era of inhabitation."
          />
          <FeatureCard
            icon="🔮"
            title="Collect Orbs"
            description="Hold Orb NFTs to unlock additional agent slots and exclusive features."
          />
        </div>

        {/* Connect button */}
        <button
          onClick={handleConnect}
          disabled={isLoading}
          className="flex items-center gap-3 px-8 py-4 rounded-xl bg-gradient-to-r from-brand-500 to-brand-600 hover:from-brand-600 hover:to-brand-700 text-white font-semibold text-lg transition-all shadow-lg shadow-brand-500/30 hover:shadow-brand-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? (
            <>
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              <span>Connecting...</span>
            </>
          ) : (
            <>
              <WalletIcon />
              <span>Connect Wallet</span>
            </>
          )}
        </button>

        {/* Wallet help text */}
        <p className="mt-6 text-sm text-[var(--color-text-muted)] text-center">
          Don't have a wallet?{' '}
          <a
            href="https://phantom.app/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-brand-400 hover:text-brand-300 underline"
          >
            Download Phantom
          </a>
        </p>

        {/* Additional wallet options */}
        <div className="mt-4 flex flex-wrap justify-center gap-4 text-xs text-[var(--color-text-muted)]">
          <span>Also works with:</span>
          <a
            href="https://solflare.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          >
            Solflare
          </a>
          <a
            href="https://backpack.app/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          >
            Backpack
          </a>
          <a
            href="https://glow.app/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
          >
            Glow
          </a>
        </div>
      </div>

      {/* Footer */}
      <footer className="py-6 text-center text-xs text-[var(--color-text-muted)]">
        <p>Powered by Solana • Built with AI</p>
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

function WalletIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
    </svg>
  );
}
