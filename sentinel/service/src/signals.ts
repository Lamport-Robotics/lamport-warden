/**
 * The watcher's rules: a confirmed transaction, or a changed account, in; signals with a level and a sentence
 * out. The table is the spec's ("Detection signals"). No model decides anything, and every sentence is a
 * template filled with decoded facts. Text from the chain (names, memos) is never used.
 *
 * Three levels. Info is shown on the Sentinel page only. Alert sends a push. Urgent pushes on every channel
 * and offers a rescue.
 *
 * Some signals are hard: they say something was done to the wallet that only a thief or a mistake does.
 * Others are soft: they say this is unlike the wallet's past. A transaction the owner's own browser reported
 * as theirs keeps its hard signals and loses its soft ones. Only a hard Urgent signal may ever trigger a
 * rescue on its own; a soft one raised by the hour it happened at may not.
 */
import { looksAlike } from "../../../pincer1/daemon/src/warden/index.js";
import { fmtSol, fmtToken } from "../../../pincer1/daemon/src/tx/explain.js";
import { KNOWN_MINTS, U64_MAX } from "../../../pincer1/daemon/src/tx/known.js";
import type { Baseline } from "./baseline.js";
import { accountKeys, decode, movementOf, signersOf, tokenLossesOf, type ObservedTx } from "./observed.js";

export type Level = "info" | "alert" | "urgent";
export type SignalKind =
  | "delegate_replaced" | "authority_changed" | "wallet_reassigned" | "known_drainer" | "lookalike"
  | "unlimited_approval" | "foreign_nonce" | "new_large_payment" | "burst" | "new_program" | "odd_hour"
  | "taken_by_permission" | "unexplained_loss"
  | "inbound_from_drainer" | "inbound_from_lookalike"
  // not about the wallet but about the watching of it (blindness.ts)
  | "watch_stopped" | "watch_resumed";

export interface Signal {
  kind: SignalKind;
  level: Level;
  /** True when the level is the table's own, false when the hour raised it: only the first may trigger a rescue unasked. */
  byTable: boolean;
  /** Unlike the wallet's past, as opposed to something done to it. Dropped for a transaction the owner reported. */
  soft: boolean;
  sentence: string;
}

const SYSTEM = "11111111111111111111111111111111";
const CORE = new Set([SYSTEM, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "ComputeBudget111111111111111111111111111111", "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"]);
const RANK: Record<Level, number> = { info: 0, alert: 1, urgent: 2 };
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const tokenName = (mint: string) => KNOWN_MINTS[mint]?.symbol ?? `token ${short(mint)}`;
const abs = (n: bigint) => (n < 0n ? -n : n);

/** A token account as an account subscription reports it. */
export interface TokenAccountState {
  address: string;
  mint: string;
  /** The wallet it belongs to. */
  owner: string;
  delegate: string | null;
  closeAuthority: string | null;
  /** What it held when last read, in the token's smallest units, and how many decimals the token has. Absent on a record from before these were kept. */
  amount?: string;
  decimals?: number;
  /** The slot that amount was read at: what happened to the account after it is what a later amount is explained by. */
  slot?: number;
  /** Set while it holds less than the transactions found so far account for: when that was first seen, unix seconds. */
  fellAt?: number;
}

/** Outbound transfers of the recent past, for the burst rule. The watcher keeps one per wallet. */
export class BurstWindow {
  private sends: { at: number; lamports: bigint; emptied: number }[] = [];
  constructor(readonly seconds = 600) {}
  add(at: number, lamports: bigint, emptied: number): void {
    this.sends.push({ at, lamports, emptied });
    this.sends = this.sends.filter((s) => at - s.at <= this.seconds);
  }
  get count(): number { return this.sends.length; }
  get lamports(): bigint { return this.sends.reduce((n, s) => n + s.lamports, 0n); }
  get emptied(): number { return this.sends.reduce((n, s) => n + s.emptied, 0); }
}

export interface WatchContext {
  wallet: string;
  baseline: Baseline;
  /** The address the wallet approved for Sentinel (the delegate of the owner and their vault), if it is armed. */
  sentinelDelegate?: string;
  /** Addresses known to drain wallets: Sentinel's own list. */
  drainers: ReadonlySet<string>;
  /** Programs on the short reviewed list: a delegate moved to one of these is an Alert, not Urgent. */
  reviewedPrograms?: ReadonlySet<string>;
  /** The owner's own browser reported this signature as one they signed. */
  ownerSigned?: boolean;
  /** The wallet's recent sends. Updated by `assessTransaction`. */
  window?: BurstWindow;
  /** The wallet's token accounts as on record, by address: who holds a permission to spend from each. */
  tokenAccounts?: Readonly<Record<string, TokenAccountState>>;

}

export interface Assessment {
  /** The highest level among the signals, or null when there is nothing to say. */
  level: Level | null;
  signals: Signal[];
  /** The first signal's sentence: what the alert says. */
  sentence: string;
  /** True when a hard signal is Urgent by the table itself: the only case automatic rescue may act on. */
  rescueWorthy: boolean;
}

const signal = (kind: SignalKind, level: Level, soft: boolean, sentence: string): Signal => ({ kind, level, byTable: true, soft, sentence });

function finish(signals: Signal[], oddHour: boolean, ownerSigned: boolean): Assessment {
  let out = ownerSigned ? signals.filter((s) => !s.soft) : signals;
  // an hour the wallet never transacts in raises everything else one level, and is itself only worth a note
  if (oddHour && !ownerSigned && out.length > 0) {
    out = out.map((s) => (s.level === "alert" ? { ...s, level: "urgent" as Level, byTable: false } : s.level === "info" && s.kind !== "odd_hour" ? { ...s, level: "alert" as Level, byTable: false } : s));
  }
  out.sort((a, b) => RANK[b.level] - RANK[a.level]);
  return {
    level: out.length ? out[0]!.level : null,
    signals: out,
    sentence: out[0]?.sentence ?? "",
    rescueWorthy: out.some((s) => s.level === "urgent" && s.byTable && !s.soft),
  };
}

/** Every signal one confirmed transaction raises for the wallet. A failed transaction raises none: it did nothing. */
export function assessTransaction(tx: ObservedTx, ctx: WatchContext): Assessment {
  const { wallet, baseline } = ctx;
  if (tx.failed) return finish([], false, false);
  const parsed = decode(tx, wallet);
  const moved = movementOf(tx, wallet);
  const signed = !!parsed && parsed.signers.includes(wallet);
  const out: Signal[] = [];

  // ── something arrived: never a reason to trust, sometimes a sign of being targeted ──
  if (!signed) {
    const sender = parsed?.feePayer ?? "";
    const gained = moved.lamports > 0n || moved.tokens.some((t) => t.delta > 0n);
    if (gained && sender) {
      if (ctx.drainers.has(sender)) out.push(signal("inbound_from_drainer", "info", false, `${short(sender)}, an address known for draining wallets, sent your wallet something. It is a sign of being targeted. Do not reply to it or copy its address.`));
      else {
        const alike = baseline.memory.lookalikeOf(sender);
        if (alike) out.push(signal("inbound_from_lookalike", "info", false, `${short(sender)} sent your wallet something. It looks like ${short(alike.address)}, an address you pay, but it is a different address. It is there for you to copy by mistake.`));
      }
    }
    // a token account or the wallet itself can still be taken over by a transaction someone else signed
    for (const h of moved.handedOver) out.push(signal("authority_changed", "urgent", false, `Your ${tokenName(h.mint)} account now belongs to ${short(h.to)}, not to you.`));
    // and its tokens can be taken by one: a transaction that could not be read is not said to be unsigned
    const taken = parsed ? takenSignal(tx, parsed.signers, ctx) : null;
    if (taken) out.push(taken);
    return finish(out, false, false);
  }

  const hour = tx.blockTime !== null ? new Date(tx.blockTime * 1000).getUTCHours() : null;
  const oddHour = hour !== null && baseline.neverAt(hour);

  // ── done to the wallet ──
  for (const d of parsed.dangers) {
    if (d.kind === "assign") out.push(signal("wallet_reassigned", "urgent", false, `Your wallet account was handed to the program ${d.to ? short(d.to) : "of someone else"}. Whoever controls that program controls the wallet.`));
    if (d.kind === "set_authority" && d.program !== SYSTEM) out.push(signal("authority_changed", "urgent", false, `Control of one of your token accounts was handed to ${d.to ? short(d.to) : "someone else"}.`));
    if (d.kind === "set_authority" && d.program === SYSTEM && d.to && d.to !== wallet) out.push(signal("foreign_nonce", "alert", false, `A durable-nonce account of yours is now controlled by ${short(d.to)}. Transactions signed on it can be sent by them at any time.`));
    if (d.kind === "approve" && d.to && d.to !== ctx.sentinelDelegate && d.amount === U64_MAX) {
      out.push(signal("unlimited_approval", "alert", false, `${short(d.to)} was given unlimited permission to spend one of your tokens. Only you can revoke it.`));
    }
  }
  for (const h of moved.handedOver) {
    if (!out.some((s) => s.kind === "authority_changed")) out.push(signal("authority_changed", "urgent", false, `Your ${tokenName(h.mint)} account now belongs to ${short(h.to)}, not to you.`));
  }
  // a nonce account created with someone else as its authority: InitializeNonceAccount carries the authority
  for (const ix of parsed.instructions) {
    if (ix.program !== SYSTEM || ix.data.length !== 36) continue;
    if (new DataView(ix.data.buffer, ix.data.byteOffset, 4).getUint32(0, true) !== 6) continue;
    const authority = b58(ix.data.subarray(4, 36));
    if (authority !== wallet && !out.some((s) => s.kind === "foreign_nonce")) out.push(signal("foreign_nonce", "alert", false, `A durable-nonce account was created from your wallet with ${short(authority)} in control of it. Transactions signed on it can be sent by them at any time.`));
  }

  // ── where value went ──
  const destinations = new Set<string>([...(parsed.lamportsOut > 0n && parsed.dest ? [parsed.dest] : []), ...moved.tokenReceivers]);
  const lost = moved.lamports < -BigInt(tx.fee) || moved.tokens.some((t) => t.delta < 0n);
  const what = (): string => {
    const parts: string[] = [];
    const sol = -moved.lamports - BigInt(tx.fee);
    if (sol > 0n) parts.push(fmtSol(sol));
    for (const t of moved.tokens) if (t.delta < 0n) parts.push(fmtToken(abs(t.delta), t.mint, { decimals: t.decimals }));
    return parts.length ? parts.join(" and ") : "value";
  };
  if (lost) {
    for (const dest of destinations) {
      if (ctx.drainers.has(dest)) { out.push(signal("known_drainer", "urgent", false, `${what()} left your wallet for ${short(dest)}, an address known for draining wallets.`)); continue; }
      const alike = baseline.memory.lookalikeOf(dest);
      if (alike) { out.push(signal("lookalike", "urgent", false, `${what()} left your wallet for ${short(dest)}. It looks like ${short(alike.address)}, which you have paid ${alike.timesPaid} time${alike.timesPaid === 1 ? "" : "s"}, but it is a different address.`)); continue; }
      // unlike the wallet's past: a first payment, larger than anything it has sent
      const typical = baseline.memory.typicalLamports();
      const sol = -moved.lamports - BigInt(tx.fee);
      if (!baseline.memory.lookup(dest) && typical.n >= 3 && sol > typical.max) {
        out.push(signal("new_large_payment", "alert", true, `${fmtSol(sol)} left your wallet for ${short(dest)}, an address it has never paid. That is more than it has ever sent at once (${fmtSol(typical.max)}).`));
      }
    }
    // a program the wallet never used, and value left through it
    const fresh = parsed.programs.filter((p) => !CORE.has(p) && baseline.memory.programUses(p) === 0);
    if (fresh.length && baseline.transactions >= 5) out.push(signal("new_program", "alert", true, `${what()} left your wallet through ${short(fresh[0]!)}, a program it has never used.`));

    // several sends close together, or most of what the wallet held
    if (ctx.window && tx.blockTime !== null) {
      const sol = -moved.lamports - BigInt(tx.fee);
      const emptied = tx.preTokenBalances.filter((b) => b.owner === wallet && BigInt(b.amount) > 0n && !tx.postTokenBalances.some((a) => a.accountIndex === b.accountIndex && a.owner === wallet && BigInt(a.amount) > 0n)).length;
      ctx.window.add(tx.blockTime, sol > 0n ? sol : 0n, emptied);
      // what the wallet held when the window opened: its balance before this transaction, plus what the window's earlier sends took
      const at = accountKeys(tx).indexOf(wallet);
      const before = at >= 0 ? BigInt(tx.preBalances[at] ?? 0) : 0n;
      const earlier = ctx.window.lamports - (sol > 0n ? sol : 0n);
      const most = (before > 0n && ctx.window.lamports * 2n > before + earlier) || ctx.window.emptied >= 3;
      if (most) out.push(signal("burst", "urgent", true, `Most of what your wallet held has left it in the last ${Math.round(ctx.window.seconds / 60)} minutes, in ${ctx.window.count} transaction${ctx.window.count === 1 ? "" : "s"}.`));
      else if (ctx.window.count >= 4) out.push(signal("burst", "alert", true, `${ctx.window.count} payments have left your wallet in the last ${Math.round(ctx.window.seconds / 60)} minutes.`));
    }
  }

  if (oddHour && out.length > 0) out.push(signal("odd_hour", "info", true, `It happened at ${String(hour).padStart(2, "0")}:00 UTC, an hour at which your wallet has never transacted.`));
  return finish(out, oddHour, ctx.ownerSigned === true);
}

/**
 * A token account changed. The two things an instruction list can hide and the account itself cannot: it
 * belongs to someone else now, or Sentinel's permission on it was replaced or removed.
 */
export function assessTokenAccount(before: TokenAccountState | null, after: TokenAccountState | null, ctx: WatchContext): Assessment {
  const out: Signal[] = [];
  if (before && after && before.owner === ctx.wallet) {
    if (after.owner !== ctx.wallet) out.push(signal("authority_changed", "urgent", false, `Your ${tokenName(after.mint)} account now belongs to ${short(after.owner)}, not to you.`));
    else if (after.closeAuthority && after.closeAuthority !== ctx.wallet && after.closeAuthority !== before.closeAuthority) out.push(signal("authority_changed", "urgent", false, `${short(after.closeAuthority)} can now close your ${tokenName(after.mint)} account.`));
    if (ctx.sentinelDelegate && before.delegate === ctx.sentinelDelegate && after.delegate !== ctx.sentinelDelegate && after.owner === ctx.wallet) {
      const to = after.delegate;
      const reviewed = !!to && !!ctx.reviewedPrograms?.has(to);
      out.push(signal(
        "delegate_replaced",
        reviewed ? "alert" : "urgent",
        false,
        to
          ? `Your ${tokenName(after.mint)} account's spending permission moved from Sentinel to ${short(to)}. Only you can revoke it. Revoke it, or move your other tokens to your vault.`
          : `Sentinel's permission on your ${tokenName(after.mint)} account was removed. That account can no longer be rescued until you arm it again.`,
      ));
    }
  }
  return finish(out, false, false);
}

/** "A", "A and B", "A, B and C", and past three: "A, B, C and 2 other tokens". */
function listed(parts: string[], more: number): string {
  if (more > 0) return `${parts.join(", ")} and ${more} other token${more === 1 ? "" : "s"}`;
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * Tokens left the wallet's accounts in a transaction the wallet did not sign.
 *
 * A transfer the owner makes is a transaction of the wallet's own, and is judged as one. A transfer the wallet
 * did not sign is somebody using a permission: a delegate the wallet approved at some time, perhaps months
 * ago, which is how these thefts work (the approval looks harmless, and the taking comes later, in a
 * transaction that need not even name the wallet); or a power the token gives its issuer. Either way the
 * owner did not do it, and whatever the permission still covers can go the same way.
 */
function takenSignal(tx: ObservedTx, signers: string[], ctx: Pick<WatchContext, "wallet" | "sentinelDelegate" | "tokenAccounts">): Signal | null {
  const permitted = (account: string) => ctx.tokenAccounts?.[account]?.delegate ?? null;
  // what Sentinel's own delegate moves is a rescue, into the owner's vault, and is reported as one
  const losses = tokenLossesOf(tx, ctx.wallet).filter((l) => !(ctx.sentinelDelegate && permitted(l.account) === ctx.sentinelDelegate));
  if (losses.length === 0) return null;
  const what = listed(losses.slice(0, 3).map((l) => fmtToken(l.lost, l.mint, { decimals: l.decimals })), Math.max(0, losses.length - 3));
  const start = `${what} left your wallet in a transaction your wallet did not sign.`;
  const delegates = [...new Set(losses.map((l) => permitted(l.account)).filter((d): d is string => !!d))];
  const signer = signers[0] ?? null;
  let rest: string;
  if (delegates.length === 1 && signers.includes(delegates[0]!)) rest = ` ${short(delegates[0]!)} did it, using a permission to spend that your wallet gave it at some earlier time. Whatever that permission still covers can go the same way until your wallet revokes it.`;
  else if (delegates.length === 1) rest = ` It went under a permission to spend that your wallet gave ${short(delegates[0]!)} at some earlier time${signer ? `; ${short(signer)} signed the transaction` : ""}. Whatever that permission still covers can go the same way until your wallet revokes it.`;
  else if (delegates.length > 1) rest = ` It went under permissions to spend that your wallet gave at some earlier time. Whatever those still cover can go the same way until your wallet revokes them.`;
  else rest = signer ? ` ${short(signer)} signed it.` : "";
  return signal("taken_by_permission", "urgent", false, start + rest);
}

/**
 * A transaction that does not name the wallet at all, found on one of its token accounts: what it took, if it
 * took anything. (One that names the wallet is read with the wallet's own, by `assessTransaction`.)
 */
export function assessTaken(tx: ObservedTx, ctx: Pick<WatchContext, "wallet" | "sentinelDelegate" | "tokenAccounts">): Assessment {
  if (tx.failed || accountKeys(tx).includes(ctx.wallet)) return finish([], false, false);
  const taken = takenSignal(tx, signersOf(tx), ctx);
  return finish(taken ? [taken] : [], false, false);
}

/** A token account holds less than the transactions Sentinel could find account for, and it has stopped looking. */
export function assessUnexplainedLoss(before: TokenAccountState, missing: bigint): Assessment {
  const what = fmtToken(missing, before.mint, before.decimals !== undefined ? { decimals: before.decimals } : undefined);
  return finish([signal("unexplained_loss", "alert", false, `${what} left your wallet and Sentinel could not find the transaction that moved it. Your wallet's own transactions do not account for it. Look at the account's recent activity.`)], false, false);
}

/** The wallet's own account changed hands: the program that owns it is no longer the System Program. */
export function assessWalletAccount(ownerProgramBefore: string, ownerProgramAfter: string): Assessment {
  const out: Signal[] = [];
  if (ownerProgramBefore === SYSTEM && ownerProgramAfter !== SYSTEM) out.push(signal("wallet_reassigned", "urgent", false, `Your wallet account was handed to the program ${short(ownerProgramAfter)}. Whoever controls that program controls the wallet.`));
  return finish(out, false, false);
}

/** Two addresses a person would take for each other: Warden's look-alike test, re-exported for the watcher's callers. */
export { looksAlike };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes: Uint8Array): string {
  let n = 0n;
  for (const x of bytes) n = n * 256n + BigInt(x);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const x of bytes) { if (x !== 0) break; out = "1" + out; }
  return out;
}
