/**
 * Agent Identity Tools — Body 4.
 *
 * Tools for the agent to inspect and use its Ed25519 identity keypair.
 */
import { z } from "zod";
import type { ToolEntry } from "../registry.js";

export interface AgentIdentityServices {
  getPubkey: () => Promise<string>;
  getHexPubkey: () => Promise<string>;
  signMessage: (message: string) => Promise<{ signature: string; pubkey: string }>;
  verifySignature: (message: string, signature: string, pubkey: string) => Promise<boolean>;
}

/** Alias for consumers that import via the shorter name. */
export type IdentityServices = AgentIdentityServices;

export function registerAgentIdentityTools(
  services: AgentIdentityServices,
): ToolEntry[] {
  return [
    {
      name: "get_agent_pubkey",
      description:
        "Get your Ed25519 public key (base58 encoded). This is your canonical identity across platforms.",
      category: "identity",
      inputSchema: z.object({}),
      execute: async () => {
        const pubkey = await services.getPubkey();
        return { success: true, pubkey };
      },
    },
    {
      name: "get_agent_pubkey_hex",
      description:
        "Get your Ed25519 public key in hex format.",
      category: "identity",
      inputSchema: z.object({}),
      execute: async () => {
        const pubkey = await services.getHexPubkey();
        return { success: true, pubkey };
      },
    },
    {
      name: "sign_message",
      description:
        "Sign a message with your Ed25519 identity keypair. Returns the base58-encoded signature and your public key.",
      category: "identity",
      inputSchema: z.object({
        message: z.string().describe("The message to sign"),
      }),
      execute: async (args) => {
        const result = await services.signMessage(args.message);
        return { success: true, ...result };
      },
    },
  ];
}
