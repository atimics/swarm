/**
 * Agent Identity MCP Services — Body 4 tools.
 */
import type { AvatarRecord } from "../../types.js";
import { toBase58, toHex, signMessage, fromHex, fromBase64 } from "@swarm/core";
import nacl from "tweetnacl";

export interface IdentityServices {
  getPubkey: () => Promise<string>;
  getHexPubkey: () => Promise<string>;
  signMessage: (message: string) => Promise<{ signature: string; pubkey: string }>;
  verifySignature: (message: string, signature: string, pubkey: string) => Promise<boolean>;
}

export function createIdentityServices(avatar: AvatarRecord): IdentityServices {
  const identity = avatar.identity;

  async function loadKeypair(): Promise<{ pubkey: Uint8Array; secretKey: Uint8Array }> {
    if (!identity?.encryptedSeed) {
      throw new Error("Agent has no identity keypair");
    }
    // Decrypt the seed (currently stored as base64-encoded raw seed; TODO: actual encryption)
    const seed = fromBase64(identity.encryptedSeed);
    const kp = nacl.sign.keyPair.fromSeed(seed);
    return { pubkey: kp.publicKey, secretKey: kp.secretKey };
  }

  return {
    getPubkey: async () => {
      if (!identity?.pubkey) throw new Error("Agent has no identity");
      return identity.pubkey;
    },

    getHexPubkey: async () => {
      if (!identity?.pubkey) throw new Error("Agent has no identity");
      const kp = await loadKeypair();
      return toHex(kp.pubkey);
    },

    signMessage: async (message: string) => {
      const kp = await loadKeypair();
      const sig = nacl.sign.detached(Buffer.from(message, "utf8"), kp.secretKey);
      return {
        signature: toBase58(sig),
        pubkey: identity!.pubkey,
      };
    },

    verifySignature: async (message: string, signatureB58: string, pubkeyB58: string) => {
      try {
        // Convert base58 signatures back for verification
        // For now, accept the agent's own pubkey only
        if (pubkeyB58 !== identity?.pubkey) return false;
        const kp = await loadKeypair();
        const sig = nacl.sign.detached(Buffer.from(message, "utf8"), kp.secretKey);
        return toBase58(sig) === signatureB58;
      } catch {
        return false;
      }
    },
  };
}
