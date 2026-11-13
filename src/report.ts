/**
 * "This signature was mine": the one thing the extension ever sends to Lamport, and only when the owner
 * turned it on and linked the wallet on the Sentinel page.
 *
 * What is sent is the wallet's address and the transaction's signature, both of which are on the public
 * chain as soon as the transaction lands. Not the site, not the transaction, not the history.
 *
 * It is sent only when it is proved. A page can sit between Warden and the wallet and hand back any
 * signature it likes, so the answer the wallet gave is not taken on trust. Two things must hold, both over
 * the exact transaction Warden read and the owner let through:
 *   - the owner's own key signed it (so this really is the owner's signing);
 *   - the signature that is reported, the first one, which is the name the chain knows the transaction by,
 *     is the fee payer's over those same bytes (so it names this transaction and no other).
 * A wallet that changes a transaction before signing it (some add their own instructions) signs different
 * bytes, and that one is not reported: Sentinel then judges it from the wallet's past, as it would with this
 * off.
 */
import { SENTINEL_API } from "./defaults.js";
import { fromBase58, toBase58 } from "./intercept.js";
import type { SentinelLink } from "./sentinel-link.js";

export type ReportFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; credentials: "omit"; cache: "no-store"; referrerPolicy: "no-referrer"; redirect: "error" }) => Promise<{ ok: boolean; status: number }>;

export interface ReportDeps {
  /** The owner's choice: off unless turned on. */
  enabled(): Promise<boolean>;
  /** The token the Sentinel page gave for this wallet, if any. */
  link(owner: string): Promise<SentinelLink | undefined>;
  fetch: ReportFetch;
  /** True when `signature` is `owner`'s over `message`. */
  verify?: (owner: Uint8Array, message: Uint8Array, signature: Uint8Array) => Promise<boolean>;
}

/** Ed25519 through the browser's own crypto. A browser without it proves nothing, and nothing is sent. */
export async function verifyEd25519(owner: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", owner as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature as BufferSource, message as BufferSource);
  } catch {
    return false;
  }
}

export type ReportOutcome = "sent" | "off" | "unlinked" | "unproven" | "failed";

/**
 * @param judged the transaction Warden judged: its message, and its signers in the order of its signatures
 * @param signatures what the wallet's answer carried, in the transaction's order
 */
export async function reportOwnSignature(deps: ReportDeps, owner: string, judged: { messageBytes: Uint8Array; signers: string[] }, signatures: Uint8Array[]): Promise<ReportOutcome> {
  if (!(await deps.enabled())) return "off";
  const link = await deps.link(owner);
  if (!link) return "unlinked";
  const verify = deps.verify ?? verifyEd25519;
  const signedBy = async (index: number): Promise<boolean> => {
    const key = fromBase58(judged.signers[index] ?? "");
    const signature = signatures[index];
    return !!key && key.length === 32 && !!signature && signature.length === 64 && (await verify(key, judged.messageBytes, signature));
  };
  const mine = judged.signers.indexOf(owner);
  // the fee payer's signature is the transaction's name; the owner's is the proof it was theirs
  if (mine < 0 || !(await signedBy(0)) || (mine !== 0 && !(await signedBy(mine)))) return "unproven";
  try {
    const res = await deps.fetch(`${SENTINEL_API}/v1/report`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${link.token}` },
      body: JSON.stringify({ wallet: owner, signature: toBase58(signatures[0]!) }),
      credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", redirect: "error",
    });
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed"; // Sentinel being away must never be the owner's problem
  }
}
