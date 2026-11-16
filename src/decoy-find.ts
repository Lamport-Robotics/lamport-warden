/**
 * Finding a browser a decoy of its own on the chain. Kept apart from decoy.ts, which carries the whole reading
 * of transactions with it: the settings page finds a decoy too, and needs none of that.
 */
import type { FetchLike } from "./rpc.js";

/** The least a wallet has to hold, in lamports, to be found as a decoy: three SOL. Less, and a thief that looks it up may not think it worth showing its hand. */
export const DECOY_LEAST_LAMPORTS = 3_000_000_000;
/** How long a decoy found for a browser stands before another is found: a week. A wallet in use does not hold the same for ever, and a thief who has learnt one decoy has not learnt the next. */
export const DECOY_KEPT_SECONDS = 7 * 86_400;
const VOTE = "Vote111111111111111111111111111111111111111";
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * The wallets in a block that could stand as a decoy: whoever paid for a transaction that went through, and
 * was left holding at least so much SOL. Such a wallet has a key (it signed), is in use this minute, and
 * holds something; and nobody here has that key. Validators voting are left out: they are a few hundred
 * wallets that anyone can list.
 */
export function decoysIn(block: any, least: number = DECOY_LEAST_LAMPORTS): string[] {
  const found = new Set<string>();
  for (const tx of Array.isArray(block?.transactions) ? block.transactions : []) {
    if (!tx || tx.meta?.err !== null) continue;
    const keys: unknown[] = Array.isArray(tx.transaction?.accountKeys) ? tx.transaction.accountKeys : [];
    const name = (k: any): unknown => (typeof k === "string" ? k : k?.pubkey);
    const payer = name(keys[0]);
    if (typeof payer !== "string" || !ADDRESS.test(payer) || keys.some((k) => name(k) === VOTE)) continue;
    const left = tx.meta?.postBalances?.[0];
    if (typeof left === "number" && Number.isSafeInteger(left) && left >= least) found.add(payer);
  }
  return [...found];
}

/**
 * A decoy of this browser's own, found on the chain: one of the wallets that paid for a transaction in a
 * block made final a moment ago and holds at least three SOL, picked by `pick` (a number below the one it
 * is given). Every browser finds a different one, so there is no list of decoys for a thief to learn, and
 * nothing for anybody to fund. It is somebody's real wallet, and nobody here has its key.
 *
 * The RPC is asked for the newest final slot and for blocks everyone can read: it learns that somebody
 * asked, and nothing about the owner. Null when no block could be read or none had such a wallet in it.
 */
export async function findDecoy(rpcUrl: string, fetchImpl: FetchLike, pick: (below: number) => number, timeoutMs = 8000): Promise<string | null> {
  if (!rpcUrl) return null;
  const ask = async (method: string, params: unknown[]): Promise<any> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctl.signal });
      if (!res.ok) throw new Error("the RPC did not answer");
      return (await res.json())?.result;
    } finally { clearTimeout(timer); }
  };
  try {
    const blockAt = (at: number, version: number): Promise<any> => ask("getBlock", [at, { encoding: "json", transactionDetails: "accounts", rewards: false, maxSupportedTransactionVersion: version, commitment: "finalized" }]).then((b) => b ?? null, () => null);
    const slot = await ask("getSlot", [{ commitment: "finalized" }]);
    if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot <= 0) return null;
    // a few blocks back from the newest: a slot may have no block, and one block may have few wallets worth showing
    const found = new Set<string>();
    for (let back = 0; back < 4 && found.size < 16; back++) {
      // The newest kind of transaction first: an RPC refuses a whole block that has one in it to a caller who did
      // not say it can read them. An RPC that knows no such kind is asked the older way.
      const block = (await blockAt(slot - back, 1)) ?? (await blockAt(slot - back, 0));
      for (const wallet of decoysIn(block)) found.add(wallet);
    }
    const wallets = [...found];
    if (wallets.length === 0) return null;
    const at = pick(wallets.length);
    return wallets[Number.isInteger(at) && at >= 0 && at < wallets.length ? at : 0]!;
  } catch { return null; }
}
