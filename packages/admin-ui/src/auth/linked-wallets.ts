export function formatAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

export function getLinkedWalletDisplay(params: {
  linkedWallets: string[];
  primaryWallet: string;
  maxLabels?: number;
}): { labels: string[]; overflow: number } {
  const { linkedWallets, primaryWallet, maxLabels = 2 } = params;

  const otherWallets = linkedWallets.filter((w) => w !== primaryWallet);
  const labels = otherWallets.slice(0, maxLabels).map(formatAddress);
  const overflow = Math.max(0, otherWallets.length - labels.length);

  return { labels, overflow };
}
