/**
 * Simulation: asking an RPC what a transaction would do, for the part the decoder cannot read.
 *
 * The decoder reads System and Token instructions exactly. A call to any other program is a black box to it,
 * and that is where a swap happens and where a drain hides. A simulation runs the whole transaction against
 * the chain as it is now and reports the accounts afterwards, so Warden can say what leaves the wallet and
 * what arrives, and can see three things no instruction list shows: a token account handed to someone else,
 * a delegate given the right to spend, and the wallet's own account reassigned.
 *
 * It is off unless the owner turns it on, because it is the one call that shows the RPC the transaction, and
 * the transaction names the wallet. It is also only a reading of this moment: a program can behave differently
 * a block later, so everything from here is worded as what a simulation showed, never as what will happen,
 * and it can only make a verdict stricter.
 */
import { VersionedMessage } from "@solana/web3.js";
import { decodeV1Message } from "../pincer1/daemon/src/tx/parse.js";
import { fmtSol, fmtToken } from "../pincer1/daemon/src/tx/explain.js";
import { KNOWN_MINTS } from "../pincer1/daemon/src/tx/known.js";
import type { FetchLike, Tables } from "./rpc.js";

const SYSTEM = "11111111111111111111111111111111";
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
/** Programs the decoder reads in full: a transaction that calls nothing else has nothing left to simulate. */
export const READ_IN_FULL = new Set([SYSTEM, ...TOKEN_PROGRAMS, "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "ComputeBudget111111111111111111111111111111", "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"]);
const MAX_ACCOUNTS = 60;

/** An account as the RPC returns it with jsonParsed encoding, or null when it does not exist. */
export interface RpcAccount { lamports: number; owner: string; data: unknown }

interface TokenAccount { mint: string; owner: string; amount: bigint; decimals: number; delegate: string | null; delegated: bigint }

function tokenAccount(a: RpcAccount | null): TokenAccount | null {
  if (!a || !TOKEN_PROGRAMS.has(a.owner)) return null;
  const d = a.data as { parsed?: { type?: string; info?: any } } | null;
  const info = d && typeof d === "object" && !Array.isArray(d) && d.parsed?.type === "account" ? d.parsed.info : null;
  if (!info || typeof info.mint !== "string" || typeof info.owner !== "string") return null;
  try {
    return {
      mint: info.mint, owner: info.owner, amount: BigInt(info.tokenAmount?.amount ?? "0"), decimals: Number(info.tokenAmount?.decimals ?? 0),
      delegate: typeof info.delegate === "string" ? info.delegate : null, delegated: BigInt(info.delegatedAmount?.amount ?? "0"),
    };
  } catch { return null; }
}

export interface TokenChange { mint: string; decimals: number; delta: bigint }
export interface Reading {
  /** Change in the wallet's SOL, fee included. Negative: it leaves. */
  lamports: bigint;
  /** Change in the wallet's holding of each token, across all of its accounts the transaction writes. */
  tokens: TokenChange[];
  /** Token accounts of the wallet that would belong to someone else afterwards. */
  handedOver: { account: string; to: string; mint: string }[];
  /** Delegates that would gain, or gain more of, the right to spend from the wallet's token accounts. */
  delegated: { account: string; to: string; mint: string; amount: bigint; decimals: number; all: boolean }[];
  /** The program the wallet's own account would be assigned to, when not the System program. */
  reassignedTo: string | null;
}

/** What changed for `owner` between the accounts before and after. The two lists are in the order of `addresses`. */
export function readChanges(owner: string, addresses: string[], pre: (RpcAccount | null)[], post: (RpcAccount | null)[]): Reading {
  const out: Reading = { lamports: 0n, tokens: [], handedOver: [], delegated: [], reassignedTo: null };
  const byMint = new Map<string, TokenChange>();
  addresses.forEach((address, i) => {
    const a = pre[i] ?? null, b = post[i] ?? null;
    if (address === owner) {
      out.lamports = BigInt(b?.lamports ?? 0) - BigInt(a?.lamports ?? 0);
      if (b && b.owner !== SYSTEM && (a?.owner ?? SYSTEM) === SYSTEM) out.reassignedTo = b.owner;
      return;
    }
    const ta = tokenAccount(a), tb = tokenAccount(b);
    const mine = ta?.owner === owner, stillMine = tb?.owner === owner;
    if (!mine && !stillMine) return;
    const mint = (tb ?? ta)!.mint, decimals = (tb ?? ta)!.decimals;
    const delta = (stillMine ? tb!.amount : 0n) - (mine ? ta!.amount : 0n);
    if (delta !== 0n) { const c = byMint.get(mint) ?? { mint, decimals, delta: 0n }; c.delta += delta; byMint.set(mint, c); }
    if (mine && tb && !stillMine) out.handedOver.push({ account: address, to: tb.owner, mint });
    if (stillMine && tb!.delegate && tb!.delegated > 0n && (tb!.delegate !== ta?.delegate || tb!.delegated > (ta?.delegated ?? 0n))) {
      out.delegated.push({ account: address, to: tb!.delegate, mint, amount: tb!.delegated, decimals, all: tb!.delegated >= tb!.amount });
    }
  });
  out.tokens = [...byMint.values()].filter((c) => c.delta !== 0n);
  return out;
}

/** Every account the message may write, the wallet among them: static keys by the header, then the tables' writable entries. */
export function writableAccounts(messageBytes: Uint8Array, tables: Tables): string[] {
  const out: string[] = [];
  if (messageBytes[0] === 0x81) {
    // version 1: the header's three counts follow the version byte, and there are no tables
    const keys = decodeV1Message(messageBytes).staticKeys;
    const signed = messageBytes[1]!, readonlySigned = messageBytes[2]!, readonlyUnsigned = messageBytes[3]!;
    keys.forEach((k, i) => { if (i < signed ? i < signed - readonlySigned : i < keys.length - readonlyUnsigned) out.push(k); });
    return out;
  }
  const m = VersionedMessage.deserialize(messageBytes);
  m.staticAccountKeys.forEach((k, i) => { if (m.isAccountWritable(i)) out.push(k.toBase58()); });
  for (const l of m.addressTableLookups ?? []) {
    const table = tables[l.accountKey.toBase58()];
    for (const i of l.writableIndexes) if (table?.[i]) out.push(table[i]!);
  }
  return [...new Set(out)];
}

export type Simulated =
  | { ok: true; reading: Reading }
  /** The transaction ran and failed: as it stands it would change nothing but cost the fee. */
  | { ok: false; why: "failed" }
  /** No answer could be had (offline, refused, a form the RPC does not simulate). */
  | { ok: false; why: "unavailable" };

export class Simulator {
  constructor(private fetchImpl: FetchLike, private timeoutMs = 6000) {}

  private async call(rpcUrl: string, method: string, params: unknown[], signal: AbortSignal): Promise<any> {
    const res = await this.fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal });
    if (!res.ok) throw new Error("rpc refused");
    const j = await res.json();
    if (j?.error) throw new Error(String(j.error.message ?? "rpc error"));
    return j?.result;
  }

  /**
   * The accounts before, and the accounts after a simulated run, read in one go so they describe the same
   * moment as nearly as two calls can. Signatures are not checked (there are none yet) and the blockhash is
   * replaced, so a transaction built a minute ago still runs.
   */
  async run(txBytes: Uint8Array, messageBytes: Uint8Array, owner: string, tables: Tables, rpcUrl: string): Promise<Simulated> {
    if (!rpcUrl) return { ok: false, why: "unavailable" };
    let addresses: string[];
    try { addresses = writableAccounts(messageBytes, tables); } catch { return { ok: false, why: "unavailable" }; }
    if (!addresses.includes(owner)) addresses.unshift(owner);
    // the wallet first, so it is never the one cut off
    addresses = [owner, ...addresses.filter((a) => a !== owner)].slice(0, MAX_ACCOUNTS);
    let b64 = ""; for (const x of txBytes) b64 += String.fromCharCode(x);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const [before, after] = await Promise.all([
        this.call(rpcUrl, "getMultipleAccounts", [addresses, { encoding: "jsonParsed", commitment: "confirmed" }], ctl.signal),
        this.call(rpcUrl, "simulateTransaction", [btoa(b64), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "jsonParsed", addresses } }], ctl.signal),
      ]);
      const value = after?.value;
      if (!value || !Array.isArray(before?.value)) return { ok: false, why: "unavailable" };
      if (value.err) return { ok: false, why: "failed" };
      if (!Array.isArray(value.accounts) || value.accounts.length !== addresses.length) return { ok: false, why: "unavailable" };
      return { ok: true, reading: readChanges(owner, addresses, before.value, value.accounts) };
    } catch {
      return { ok: false, why: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }
}

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const list = (parts: string[]) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);
const abs = (n: bigint) => (n < 0n ? -n : n);
const tokenName = (mint: string) => KNOWN_MINTS[mint]?.symbol ?? `token ${short(mint)}`;

export interface SimulationWords {
  /** Added to the verdict's sentence. */
  sentence: string;
  /** Added to the reasons, most serious first. */
  reasons: string[];
  /** The least the verdict may be after this. */
  atLeast: "allow" | "explain" | "confirm" | "block";
}

/** What to tell the owner. `feeLamports` and `decodedOut` are what the decoder already accounted for. */
export function wordsFor(sim: Simulated, known: { feeLamports: bigint; decodedLamportsOut: bigint }): SimulationWords {
  if (!sim.ok) {
    return sim.why === "failed"
      ? { sentence: "In a simulation just now it failed, so as it stands it would do nothing but cost the fee.", reasons: [], atLeast: "allow" }
      : { sentence: "I could not simulate it, so I can't tell you what the programs I don't read would do.", reasons: ["the simulation could not be run."], atLeast: "explain" };
  }
  const r = sim.reading;
  const lost: string[] = [], gained: string[] = [];
  const beyondFee = r.lamports + known.feeLamports; // what moved besides the fee
  if (beyondFee < 0n) lost.push(fmtSol(-r.lamports)); else if (beyondFee > 0n) gained.push(fmtSol(beyondFee));
  for (const t of r.tokens) (t.delta < 0n ? lost : gained).push(fmtToken(abs(t.delta), t.mint, { decimals: t.decimals }));
  let sentence: string;
  if (lost.length && gained.length) sentence = `In a simulation just now, your wallet lost ${list(lost)} and gained ${list(gained)}.`;
  else if (lost.length) sentence = `In a simulation just now, your wallet lost ${list(lost)} and gained nothing.`;
  else if (gained.length) sentence = `In a simulation just now, your wallet gained ${list(gained)} and lost only the fee.`;
  else sentence = "In a simulation just now, nothing left your wallet but the fee.";
  if (beyondFee < 0n) sentence = sentence.replace(fmtSol(-r.lamports), `${fmtSol(-r.lamports)} (fee included)`);

  const reasons: string[] = [];
  let atLeast: SimulationWords["atLeast"] = "allow";
  const raise = (to: SimulationWords["atLeast"]) => { const order = { allow: 0, explain: 1, confirm: 2, block: 3 }; if (order[to] > order[atLeast]) atLeast = to; };
  if (r.reassignedTo) { reasons.push(`in the simulation your wallet's own account ended up owned by the program ${short(r.reassignedTo)}. Whoever controls that program controls the account.`); raise("block"); }
  for (const h of r.handedOver) { reasons.push(`in the simulation your account for ${tokenName(h.mint)} ended up belonging to ${short(h.to)}, not to you.`); raise("confirm"); }
  for (const d of r.delegated) { reasons.push(`in the simulation ${short(d.to)} was given the right to spend ${d.all ? "all" : fmtToken(d.amount, d.mint, { decimals: d.decimals })} of your ${tokenName(d.mint)}, now or later.`); raise("confirm"); }
  // more SOL gone than the instructions I can read send, and nothing back for it (a swap gets something back),
  // with room for the rent of a new account or two
  const hidden = -r.lamports - known.feeLamports - known.decodedLamportsOut;
  if (hidden > 10_000_000n && gained.length === 0) { reasons.push(`the simulation shows ${fmtSol(hidden)} leaving your wallet that no instruction I can read accounts for.`); raise("explain"); }
  if (lost.length && !gained.length && r.tokens.some((t) => t.delta < 0n)) raise("explain");
  return { sentence, reasons, atLeast };
}
