/**
 * The few cryptographic pieces the service needs, all from Node itself: random tokens, their hashes, a sealed
 * box for what is stored about how to reach an owner, and the check of a wallet's signature.
 *
 * A token is shown to its holder once and kept here only as a hash, so the stored file does not let anyone
 * act as an owner.
 */
import { createCipheriv, createDecipheriv, createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

/** 32 random bytes, as text that is safe in a header and a URL. */
export const randomToken = (): string => randomBytes(32).toString("base64url");

export const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

/** Compares two hashes without telling a guesser how much of one was right. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** The key that seals stored channel targets: 32 bytes, given as base64. Null when it is not one. */
export function dataKeyFrom(base64: string | undefined): Buffer | null {
  if (!base64) return null;
  const key = Buffer.from(base64, "base64");
  return key.length === 32 ? key : null;
}

/** AES-256-GCM. The result carries its own nonce and tag: nonce(12) | tag(16) | ciphertext, in base64. */
export function seal(key: Buffer, text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** Null when the box was not sealed with this key, or was changed. */
export function unseal(key: Buffer, sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, "base64");
    if (raw.length < 28) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** A Solana address as its 32 bytes, or null when the text is not one. */
export function addressBytes(address: string): Uint8Array | null {
  if (typeof address !== "string" || address.length < 32 || address.length > 44) return null;
  try { return new PublicKey(address).toBytes(); } catch { return null; }
}

// an ed25519 public key as Node wants it: the fixed SubjectPublicKeyInfo header, then the 32 bytes
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** True when `signature` is this address's ed25519 signature over exactly these bytes. */
export function verifyWalletSignature(address: string, message: Uint8Array, signature: Uint8Array): boolean {
  const key = addressBytes(address);
  if (!key || signature.length !== 64) return false;
  try {
    return verify(null, message, createPublicKey({ key: Buffer.concat([SPKI_ED25519, key]), format: "der", type: "spki" }), signature);
  } catch {
    return false;
  }
}

/** A transaction signature as Solana writes it: 64 bytes in base58. */
export const looksLikeSignature = (s: unknown): s is string => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s);
