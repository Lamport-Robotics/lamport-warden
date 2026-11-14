/**
 * A confirmed transaction as the watcher has it: the message that was signed, and what the chain says it did.
 *
 * The decoder reads the message. The balances before and after say what moved even when a program the decoder
 * does not read moved it. Both are needed: an instruction list shows an approval or a change of authority that
 * moves nothing yet, and the balances show a drain that no instruction names.
 */
import { VersionedMessage } from "@solana/web3.js";
import { parseMessage, splitTransaction, type ParsedTx } from "../../../pincer1/daemon/src/tx/parse.js";

export interface TokenBalance {
  /** Position of the token account in the transaction's account list. */
  accountIndex: number;
  mint: string;
  /** The wallet the token account belongs to. */
  owner: string;
  /** Raw units, as a decimal string. */
  amount: string;
  decimals: number;
}

export interface ObservedTx {
  signature: string;
  slot: number;
  /** Unix seconds, when the cluster reported one. */
  blockTime: number | null;
  /** The serialized message. */
  message: Uint8Array;
  /** For a version 0 message: the addresses its lookup tables resolved to, as the cluster reports them. */
  loaded?: { writable: string[]; readonly: string[] };
  failed: boolean;
  fee: number;
  /** Lamports of every account, in the order of `accountKeys`. */
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
}

const b64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** From the answer of `getTransaction(signature, { encoding: "base64", maxSupportedTransactionVersion: 0 })`. */
export function fromRpc(signature: string, result: any): ObservedTx | null {
  const raw = result?.transaction?.[0];
  const meta = result?.meta;
  if (typeof raw !== "string" || !meta) return null;
  let message: Uint8Array;
  try { message = splitTransaction(b64(raw)).messageBytes; } catch { return null; }
  const balances = (list: any): TokenBalance[] =>
    (Array.isArray(list) ? list : [])
      .filter((b) => typeof b?.accountIndex === "number" && typeof b?.mint === "string" && typeof b?.owner === "string" && typeof b?.uiTokenAmount?.amount === "string")
      .map((b) => ({ accountIndex: b.accountIndex, mint: b.mint, owner: b.owner, amount: b.uiTokenAmount.amount, decimals: Number(b.uiTokenAmount.decimals ?? 0) }));
  const loaded = meta.loadedAddresses;
  return {
    signature,
    slot: Number(result.slot ?? 0),
    blockTime: typeof result.blockTime === "number" ? result.blockTime : null,
    message,
    loaded: loaded && Array.isArray(loaded.writable) && Array.isArray(loaded.readonly) ? { writable: loaded.writable, readonly: loaded.readonly } : undefined,
    failed: meta.err != null,
    fee: Number(meta.fee ?? 0),
    preBalances: meta.preBalances ?? [],
    postBalances: meta.postBalances ?? [],
    preTokenBalances: balances(meta.preTokenBalances),
    postTokenBalances: balances(meta.postTokenBalances),
  };
}

/**
 * The lookup tables of a version 0 message, rebuilt from what the cluster says they resolved to: enough of
 * each table for the decoder to read every account the message uses.
 */
function tablesOf(tx: ObservedTx): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!tx.loaded || tx.message[0] !== 0x80) return out;
  let w = 0, r = 0;
  const m = VersionedMessage.deserialize(tx.message);
  for (const l of m.addressTableLookups ?? []) {
    const table: string[] = (out[l.accountKey.toBase58()] ??= []);
    for (const i of l.writableIndexes) table[i] = tx.loaded.writable[w++]!;
    for (const i of l.readonlyIndexes) table[i] = tx.loaded.readonly[r++]!;
  }
  return out;
}

/** The transaction's instructions, read from `wallet`'s point of view. Null for a message the decoder cannot read. */
export function decode(tx: ObservedTx, wallet: string): ParsedTx | null {
  try { return parseMessage(tx.message, { owner: wallet, lookupTables: tablesOf(tx) }); } catch { return null; }
}

/** Who signed it, the one who paid its fee first. Empty when the message cannot be read. */
export function signersOf(tx: ObservedTx): string[] {
  return decode(tx, "")?.signers ?? [];
}

/** Every account of the transaction, in the order the balances are listed in. */
export function accountKeys(tx: ObservedTx): string[] {
  if (tx.message[0] === 0x81) return decodeKeys(tx);
  const m = VersionedMessage.deserialize(tx.message);
  return [...m.staticAccountKeys.map((k) => k.toBase58()), ...(tx.loaded?.writable ?? []), ...(tx.loaded?.readonly ?? [])];
}

function decodeKeys(tx: ObservedTx): string[] {
  const p = decode(tx, "");
  return p ? p.accounts : [];
}

export interface TokenChange { mint: string; decimals: number; delta: bigint }
export interface Movement {
  /** Change in the wallet's SOL, fee included. Negative: it left. */
  lamports: bigint;
  /** Change in the wallet's holding of each token. */
  tokens: TokenChange[];
  /** Token accounts that were the wallet's before and someone else's after. */
  handedOver: { account: string; mint: string; to: string }[];
  /** Wallets whose holding of a token grew by what this wallet's shrank: where the tokens went. */
  tokenReceivers: string[];
}

/** What the transaction did to `wallet`, from the balances before and after. */
export function movementOf(tx: ObservedTx, wallet: string): Movement {
  const keys = accountKeys(tx);
  const at = keys.indexOf(wallet);
  const lamports = at >= 0 ? BigInt(tx.postBalances[at] ?? 0) - BigInt(tx.preBalances[at] ?? 0) : 0n;
  const pre = new Map(tx.preTokenBalances.map((b) => [b.accountIndex, b]));
  const post = new Map(tx.postTokenBalances.map((b) => [b.accountIndex, b]));
  const mine = new Map<string, TokenChange>();
  const others = new Map<string, Map<string, bigint>>(); // mint -> owner -> delta
  const handedOver: Movement["handedOver"] = [];
  for (const index of new Set([...pre.keys(), ...post.keys()])) {
    const a = pre.get(index), b = post.get(index);
    const ref = (b ?? a)!;
    for (const owner of new Set([a?.owner, b?.owner].filter((o): o is string => !!o))) {
      const delta = (b?.owner === owner ? BigInt(b.amount) : 0n) - (a?.owner === owner ? BigInt(a.amount) : 0n);
      if (delta === 0n) continue;
      if (owner === wallet) {
        const c = mine.get(ref.mint) ?? { mint: ref.mint, decimals: ref.decimals, delta: 0n };
        c.delta += delta;
        mine.set(ref.mint, c);
      } else {
        const byOwner = others.get(ref.mint) ?? new Map<string, bigint>();
        byOwner.set(owner, (byOwner.get(owner) ?? 0n) + delta);
        others.set(ref.mint, byOwner);
      }
    }
    if (a?.owner === wallet && b && b.owner !== wallet) handedOver.push({ account: keys[index] ?? "", mint: ref.mint, to: b.owner });
  }
  const tokens = [...mine.values()].filter((c) => c.delta !== 0n);
  const tokenReceivers = new Set<string>();
  for (const c of tokens) if (c.delta < 0n) for (const [owner, delta] of others.get(c.mint) ?? []) if (delta > 0n) tokenReceivers.add(owner);
  return { lamports, tokens, handedOver, tokenReceivers: [...tokenReceivers] };
}

export interface TokenLoss { account: string; mint: string; decimals: number; lost: bigint }

/**
 * `wallet`'s token accounts that held less after the transaction than before it, and by how much. An account
 * that went to someone else in the transaction is not here: that is a handing over, and is reported as one.
 */
export function tokenLossesOf(tx: ObservedTx, wallet: string): TokenLoss[] {
  const keys = accountKeys(tx);
  const out: TokenLoss[] = [];
  for (const a of tx.preTokenBalances) {
    if (a.owner !== wallet) continue;
    const b = tx.postTokenBalances.find((p) => p.accountIndex === a.accountIndex);
    if (b && b.owner !== wallet) continue;
    const lost = BigInt(a.amount) - BigInt(b?.amount ?? "0");
    if (lost > 0n) out.push({ account: keys[a.accountIndex] ?? "", mint: a.mint, decimals: a.decimals, lost });
  }
  return out;
}

/** The mints of which accounts belonging to `owner` held more after the transaction than before. */
export function tokenGainsOf(tx: ObservedTx, owner: string): Set<string> {
  const out = new Set<string>();
  for (const b of tx.postTokenBalances) {
    if (b.owner !== owner) continue;
    const a = tx.preTokenBalances.find((p) => p.accountIndex === b.accountIndex);
    if (BigInt(b.amount) > (a && a.owner === owner ? BigInt(a.amount) : 0n)) out.add(b.mint);
  }
  return out;
}

/** Every token account whose holding the transaction changed, and by how much. */
export function tokenDeltasOf(tx: ObservedTx): Map<string, bigint> {
  const keys = accountKeys(tx);
  const out = new Map<string, bigint>();
  for (const index of new Set([...tx.preTokenBalances, ...tx.postTokenBalances].map((b) => b.accountIndex))) {
    const account = keys[index];
    if (!account) continue;
    const amount = (list: TokenBalance[]) => BigInt(list.find((b) => b.accountIndex === index)?.amount ?? "0");
    const delta = amount(tx.postTokenBalances) - amount(tx.preTokenBalances);
    if (delta !== 0n) out.set(account, delta);
  }
  return out;
}
