import { useState } from 'react';
import { copyTextToClipboard } from '../utils/clipboard';
import { formatAddress } from '../auth/linked-wallets';

interface CopyableAddressProps {
  address: string;
  truncate?: boolean;
  className?: string;
  onCopied?: () => void;
}

export function CopyableAddress({ address, truncate = true, className = '', onCopied }: CopyableAddressProps) {
  const [copied, setCopied] = useState(false);
  const display = truncate ? formatAddress(address) : address;

  const handleCopy = async () => {
    await copyTextToClipboard(address);
    setCopied(true);
    onCopied?.();
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex items-center gap-1 font-mono text-xs sm:text-sm px-2 py-1 rounded hover:bg-[var(--color-bg-secondary)] text-[var(--color-text)] ${className}`}
      title={`Click to copy: ${address}`}
    >
      <span className="truncate max-w-[180px] sm:max-w-none">{display}</span>
      <span className="text-[10px] text-[var(--color-text-muted)]">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}
