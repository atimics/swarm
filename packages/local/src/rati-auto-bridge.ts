/**
 * RATi Auto-Bridge.
 *
 * Background service that watches for RATi mining and checks the
 * avatar'\''s Solana wallet balance. Uses Solana JSON RPC directly
 * (no @solana/web3.js dependency).
 *
 * In dev mode without Signal, simulates mining at a configurable
 * interval so the avatar wallet accumulates RATi over time.
 */

const DEVNET_RPC = "https://api.devnet.solana.com";
const RATI_MINT = "8ZscSWe5ZSFbGYg4JzA3eqpf6iCnwT72i8TZvVni2yMY";

async function rpcCall(method: string, params: any[]): Promise<any> {
  const res = await fetch(DEVNET_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await res.json() as any;
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

export interface AutoBridgeState {
  running: boolean;
  totalMined: number;
  lastMineTime: number;
  walletBalance: number;
}

export interface TreasuryConfig {
  /** Share of bridged RATi that goes to miners as relay bounty. Default 0.10 (10%). */
  minerShare: number;
  /** Share of bridged RATi locked in station treasury. Default 0.90 (90%). */
  treasuryShare: number;
  /** Solana LP pool address for auto-depositing treasury RATi (optional). */
  lpPoolAddress?: string;
}

export const DEFAULT_TREASURY: TreasuryConfig = {
  minerShare: 0.10,
  treasuryShare: 0.90,
};

export interface AutoBridgeDeps {
  getAvatarPubkey: () => string | null;
  /** Treasury config for split: minerShare to relayers, treasuryShare locked. */
  treasury?: TreasuryConfig;
  onMine?: (amount: number, minerAmount: number, treasuryAmount: number) => void;
}

/**
 * Get the RATi token balance for a Solana wallet on devnet.
 * Uses the getTokenAccountsByOwner RPC method.
 */
export async function getRatiBalance(pubkey: string): Promise<number> {
  try {
    const result = await rpcCall("getTokenAccountsByOwner", [
      pubkey,
      { mint: RATI_MINT },
      { encoding: "jsonParsed" },
    ]);
    if (result.value?.length > 0) {
      const info = result.value[0].account.data.parsed.info.tokenAmount;
      return Number(info.uiAmount || 0);
    }
  } catch {
    // Wallet might not have a RATi token account yet
  }
  return 0;
}

/**
 * Get SOL balance for a wallet on devnet.
 */
export async function getSolBalance(pubkey: string): Promise<number> {
  try {
    const result = await rpcCall("getBalance", [pubkey]);
    return result.value / 1_000_000_000; // lamports → SOL
  } catch {
    return 0;
  }
}

/**
 * Start the auto-bridge background service.
 */
export function startAutoBridge(deps: AutoBridgeDeps): {
  stop: () => void;
  getState: () => AutoBridgeState;
} {
  const state: AutoBridgeState = {
    running: true,
    totalMined: 0,
    lastMineTime: 0,
    walletBalance: 0,
  };

  async function tick() {
    if (!state.running) return;
    const pubkey = deps.getAvatarPubkey();
    if (!pubkey) return;

    // Check live balance
    try {
      state.walletBalance = await getRatiBalance(pubkey);
    } catch {}

    // Simulate mining: 0.25 RATi per cycle (~every 30s)
    const mined = 0.25;
    state.totalMined = +(state.totalMined + mined).toFixed(6);
    state.lastMineTime = Date.now();

    const treasury = deps.treasury ?? DEFAULT_TREASURY;
    const minerAmount = mined * treasury.minerShare;
    const treasuryAmount = mined * treasury.treasuryShare;
    deps.onMine?.(mined, minerAmount, treasuryAmount);
  }

  const interval = setInterval(tick, 30_000);
  setTimeout(tick, 3_000);

  return {
    stop: () => { state.running = false; clearInterval(interval); },
    getState: () => ({ ...state }),
  };
}
