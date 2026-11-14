/**
 * The one network call Warden makes: reading address lookup tables.
 *
 * Most swaps are version 0 transactions that name their accounts by position in a table stored on chain.
 * Without the table, the accounts are numbers and nothing can be said about where the money goes. Reading a
 * table tells the RPC which table was asked for and from which IP address, and nothing else: not the wallet,
 * not the transaction, not the site. The owner picks the RPC in the settings, or turns the call off.
 *
 * Entries of a lookup table are never changed or removed while the table is live, only appended, so what was
 * read once is kept and a table is fetched again only when a transaction points past what is known.
 */
import { AddressLookupTableAccount, PublicKey, VersionedMessage } from "@solana/web3.js";

export { DEFAULT_RPC } from "./defaults.js";

export type Tables = Record<string, string[]>;
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<any> }>;

/** The tables a message needs, with the highest position it reads in each. Empty for legacy and version 1. */
export function tablesNeeded(messageBytes: Uint8Array): Map<string, number> {
  const out = new Map<string, number>();
  if (messageBytes.length === 0 || messageBytes[0] !== 0x80) return out; // only version 0 has lookup tables
  try {
    const m = VersionedMessage.deserialize(messageBytes);
    for (const l of m.addressTableLookups ?? []) {
      const top = Math.max(-1, ...l.writableIndexes, ...l.readonlyIndexes);
      const key = l.accountKey.toBase58();
      out.set(key, Math.max(out.get(key) ?? -1, top));
    }
  } catch { /* unreadable: the engine says so */ }
  return out;
}

export class TableReader {
  private known = new Map<string, string[]>();
  constructor(private fetchImpl: FetchLike, private timeoutMs = 4000) {}

  /**
   * The contents of every table the message reads, as far as they could be had. A table that cannot be read is
   * left out, and the engine then treats those accounts as unknown.
   */
  async forMessage(messageBytes: Uint8Array, rpcUrl: string): Promise<Tables> {
    const need = tablesNeeded(messageBytes);
    const out: Tables = {};
    const missing: string[] = [];
    for (const [key, top] of need) {
      const have = this.known.get(key);
      if (have && have.length > top) out[key] = have; else missing.push(key);
    }
    if (missing.length === 0 || !rpcUrl) return out;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [missing.slice(0, 100), { encoding: "base64", commitment: "confirmed" }] }),
        signal: ctl.signal,
      });
      if (!res.ok) return out;
      const value = (await res.json())?.result?.value;
      if (!Array.isArray(value)) return out;
      missing.slice(0, 100).forEach((key, i) => {
        const data = value[i]?.data?.[0];
        // only an account the lookup table program owns is a table: anything else would be the RPC, or the page, lying
        if (typeof data !== "string" || value[i]?.owner !== "AddressLookupTab1e1111111111111111111111111") return;
        try {
          const state = AddressLookupTableAccount.deserialize(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
          const addresses = state.addresses.map((a: PublicKey) => a.toBase58());
          this.known.set(key, addresses);
          if (this.known.size > 500) this.known.delete(this.known.keys().next().value!);
          out[key] = addresses;
        } catch { /* not a table */ }
      });
    } catch { /* offline, slow or refused: the request is judged without the tables */ } finally {
      clearTimeout(timer);
    }
    return out;
  }
}

/**
 * Reads one account, for the one question Warden asks about Sentinel: which vault a wallet's setup names
 * (sentinel.ts, `vaultOfConfig`). Null when it is not on the chain; an error when the RPC could not say.
 */
export async function readAccount(address: string, rpcUrl: string, fetchImpl: FetchLike, timeoutMs = 4000): Promise<{ owner: string; data: Uint8Array } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64", commitment: "confirmed" }] }), signal: ctl.signal });
    if (!res.ok) throw new Error("the RPC did not answer");
    const result = (await res.json())?.result;
    if (!result || !("value" in result)) throw new Error("the RPC gave no answer");
    const data = result.value?.data?.[0];
    return result.value && typeof data === "string" ? { owner: String(result.value.owner), data: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) } : null;
  } finally { clearTimeout(timer); }
}
