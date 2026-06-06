/**
 * Agent Identity Service
 *
 * Gives every avatar an Ed25519 keypair (Body 4 of the Five Bodies).
 * Compatible with Signal stations (TweetNaCl), Solana (same curve),
 * and raticross (ActorSchema.pubkey).
 *
 * The keypair is stored encrypted via the existing secrets infrastructure.
 * The seed never touches disk unencrypted.
 */
import nacl from "tweetnacl";
import { randomBytes } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentKeypair {
  /** 32-byte secret seed */
  seed: Uint8Array;
  /** 32-byte public key */
  pubkey: Uint8Array;
  /** 64-byte NaCl secret key (seed || pubkey) */
  secretKey: Uint8Array;
}

export interface AgentIdentity {
  /** base58-encoded Ed25519 public key */
  pubkey: string;
  /** encrypted seed material (base64) */
  encryptedSeed: string;
  /** how the keypair was created */
  derivation: {
    type: "random" | "derived";
    /** derivation provenance string, if derived */
    provenance?: string;
  };
}

// ---------------------------------------------------------------------------
// Keypair generation
// ---------------------------------------------------------------------------

/**
 * Generate a new random Ed25519 keypair.
 * Returns raw bytes; caller must encrypt the seed before storage.
 */
export function generateAgentKeypair(): AgentKeypair {
  const seed = randomBytes(32);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return {
    seed,
    pubkey: kp.publicKey,
    secretKey: kp.secretKey, // NaCl format: 64 bytes (seed || pubkey)
  };
}

/**
 * Derive a keypair deterministically from a seed phrase and provenance string.
 * Uses SHA-512 of (seed || provenance) as the Ed25519 seed.
 * Matches Signal's station key derivation pattern.
 */
export function deriveAgentKeypair(seedPhrase: string, provenance: string): AgentKeypair {
  const { createHash } = require("crypto");
  const hash = createHash("sha512")
    .update(seedPhrase)
    .update(":")
    .update(provenance)
    .digest();
  const seed = hash.subarray(0, 32);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return {
    seed,
    pubkey: kp.publicKey,
    secretKey: kp.secretKey,
  };
}

/**
 * Sign a message with the agent's keypair.
 * Returns the signature as a Uint8Array (64 bytes, Ed25519).
 */
export function signMessage(keypair: AgentKeypair, message: Uint8Array): Uint8Array {
  return nacl.sign.detached(message, keypair.secretKey);
}

/**
 * Verify a signature against the agent's public key.
 */
export function verifySignature(pubkey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  return nacl.sign.detached.verify(message, signature, pubkey);
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/** Bitcoin-style base58 (compatible with Solana). */
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function toBase58(buf: Uint8Array): string {
  const digits = [0];
  for (let i = 0; i < buf.length; i++) {
    let carry = buf[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  // Leading zeros
  for (let i = 0; i < buf.length && buf[i] === 0; i++) {
    digits.push(0);
  }
  return digits.reverse().map(d => BASE58_ALPHABET[d]).join("");
}

export function toHex(buf: Uint8Array): string {
  return Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function toBase64(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64");
}

export function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}
