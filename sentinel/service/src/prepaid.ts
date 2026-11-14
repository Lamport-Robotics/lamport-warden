/**
 * Paying for the plan in USDC or SOL.
 *
 * A card can be charged every month. A wallet cannot, except by giving somebody a standing permission to
 * spend from it, which is the very thing Sentinel warns its owners about. So this is paid ahead: one, three
 * or twelve months at a time. The plan runs to the end of what was paid for and stops; nothing renews, and
 * the owner is told a few days before.
 *
 * How a payment is known to be this profile's: the quote names an address nobody holds, a "reference"
 * (as in Solana Pay), and the paying transaction names it too. Any wallet can pay, from a phone or from the
 * page; the reference is what ties the payment to the profile, so nothing has to be signed in to. A
 * transaction is read from the chain, at finalized, and counted by what actually arrived at Lamport's
 * address in it: not by what the page says, and not by what an instruction says.
 *
 * A transaction pays for one thing, once. USDC is a dollar for a dollar and a quote in it is good for a
 * week. A quote in SOL is priced when it is made and is good for ten minutes.
 */
import { randomBytes } from "node:crypto";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { Accounts } from "./accounts.js";
import { prepaidEndingNotice, prepaidExtendedNotice, prepaidStartedNotice, planEndedNotice } from "./notices.js";
import { accountKeys, fromRpc, type ObservedTx } from "./observed.js";
import { PLANS, PREPAID_MONTHS, decimal } from "./plans.js";
import type { Rpc } from "./rpc.js";
import type { PayAsset, PayIntent } from "./store.js";

/** USDC on mainnet. */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** How long a quote in SOL holds its price, and how long after that a payment that was already on its way is still taken. */
export const SOL_QUOTE_SECONDS = 600;
export const SOL_QUOTE_GRACE_SECONDS = 300;
/** How long a quote in USDC can be paid. */
export const USDC_QUOTE_SECONDS = 7 * 86_400;
/** How long before the paid time ends its owner is told. */
export const REMIND_BEFORE_SECONDS = 3 * 86_400;

export interface PrepaidConfig {
  /** Lamport's wallet: where payments go. */
  payTo: string;
  usdcMint?: string;
}

/** What the plan's card side says about a profile, so that both ways of paying sell to the same people at the same prices. */
export interface Selling {
  /** Whether this profile may buy now (checkout is open, or one of its wallets is a tester's). */
  sells(profile: string): boolean;
  /** Whether its wallets hold enough of the token for the lower price. Throws when that could not be read. */
  holder(profile: string): Promise<boolean>;
  /** True while a card subscription is paying for the plan. */
  byCard(profile: string): boolean;
  centsFull: number;
  centsHolder: number;
}

export type Refusal = { ok: false; status: number; why: string };
export interface QuoteView {
  reference: string; payTo: string; asset: PayAsset; units: string; decimals: number; mint: string | null;
  months: number; cents: number; expiresAt: number;
  /** The same as a payment request a wallet can open (Solana Pay). */
  url: string;
}
export type CheckView = { status: "waiting" } | { status: "paid"; until: number } | { status: "short"; arrived: string; wanted: string } | { status: "late" };

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** The token account a wallet keeps a token in unless it says otherwise. */
export const tokenAccountOf = (owner: PublicKey, mint: PublicKey): PublicKey => PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM)[0];

/**
 * The transaction that pays a quote from `payer`: one transfer of exactly the quoted amount to Lamport's
 * address, naming the quote's reference. Nothing else is in it. It is unsigned; the payer's wallet signs it.
 */
export function paymentInstruction(o: { payer: PublicKey; payTo: PublicKey; asset: PayAsset; units: bigint; mint: PublicKey; reference: PublicKey }): TransactionInstruction {
  const named = { pubkey: o.reference, isSigner: false, isWritable: false };
  if (o.asset === "SOL") {
    const ix = SystemProgram.transfer({ fromPubkey: o.payer, toPubkey: o.payTo, lamports: o.units });
    ix.keys.push(named);
    return ix;
  }
  // TransferChecked: the token and its decimals are part of what is signed, so the amount cannot mean another token's
  const data = Buffer.alloc(10);
  data[0] = 12; data.writeBigUInt64LE(o.units, 1); data[9] = 6;
  return new TransactionInstruction({ programId: TOKEN_PROGRAM, data, keys: [
    { pubkey: tokenAccountOf(o.payer, o.mint), isSigner: false, isWritable: true }, { pubkey: o.mint, isSigner: false, isWritable: false },
    { pubkey: tokenAccountOf(o.payTo, o.mint), isSigner: false, isWritable: true }, { pubkey: o.payer, isSigner: true, isWritable: false }, named,
  ] });
}

/** `months` later, on the same day of the month where there is one (the 31st plus a month is the last day of the next). */
export function addMonths(unix: number, months: number): number {
  const d = new Date(unix * 1000);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  return Math.floor(d.getTime() / 1000);
}

/** Dollars in cents as USDC's smallest units: six decimals. */
export const usdcUnits = (cents: number): bigint => BigInt(cents) * 10_000n;
/** Dollars in cents as lamports at a price, rounded up to the lamport. */
export function lamportsFor(cents: number, usdPerSol: number): bigint {
  const micro = BigInt(Math.round(usdPerSol * 1_000_000));
  if (micro <= 0n) throw new Error("no price");
  const top = BigInt(cents) * 10_000_000_000_000n;
  return (top + micro - 1n) / micro;
}

/**
 * What arrived at `payTo` in a transaction: lamports, or units of the one token. Read from the balances
 * before and after, so it is what the chain did, whatever the instructions were.
 */
export function arrived(tx: ObservedTx, payTo: string, asset: PayAsset, usdcMint: string): bigint {
  if (tx.failed) return 0n;
  if (asset === "SOL") {
    const at = accountKeys(tx).indexOf(payTo);
    return at < 0 ? 0n : BigInt(tx.postBalances[at] ?? 0) - BigInt(tx.preBalances[at] ?? 0);
  }
  const before = new Map(tx.preTokenBalances.filter((b) => b.owner === payTo && b.mint === usdcMint).map((b) => [b.accountIndex, BigInt(b.amount)]));
  let sum = 0n;
  for (const b of tx.postTokenBalances) if (b.owner === payTo && b.mint === usdcMint) sum += BigInt(b.amount) - (before.get(b.accountIndex) ?? 0n);
  return sum;
}

export class Prepaid {
  constructor(
    private cfg: PrepaidConfig, private accounts: Accounts, private rpc: Rpc, private selling: Selling,
    private opts: { now?: () => number; price?: () => Promise<number>; notice?: (profile: string, sentence: string) => Promise<void> } = {},
  ) {
    if (!ADDRESS.test(cfg.payTo)) throw new Error("the address payments go to is not an address");
  }

  private now(): number { return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000); }
  private get mint(): string { return this.cfg.usdcMint ?? USDC_MINT; }
  private tell(profile: string, sentence: string): void { void this.opts.notice?.(profile, sentence).catch(() => undefined); }

  /** What the page needs to offer it. SOL is offered only where there is a price to quote it at. */
  offer(): { payTo: string; assets: PayAsset[]; months: readonly number[] } {
    return { payTo: this.cfg.payTo, assets: this.opts.price ? ["USDC", "SOL"] : ["USDC"], months: PREPAID_MONTHS };
  }

  /** An amount to pay, and the reference that will mark the payment as this profile's. */
  async quote(profile: string, asset: unknown, months: unknown): Promise<{ ok: true; quote: QuoteView } | Refusal> {
    if (!this.accounts.profile(profile)) return { ok: false, status: 401, why: "sign in again." };
    if (!this.selling.sells(profile)) return { ok: false, status: 403, why: "the paid plan is not on sale yet." };
    if (this.selling.byCard(profile)) return { ok: false, status: 409, why: "this profile has the plan by card, which renews by itself. Cancel that first if you would rather pay ahead." };
    if (asset !== "USDC" && asset !== "SOL") return { ok: false, status: 400, why: "it can be paid in USDC or SOL." };
    if (asset === "SOL" && !this.opts.price) return { ok: false, status: 400, why: "it cannot be paid in SOL here. USDC can." };
    if (typeof months !== "number" || !PREPAID_MONTHS.includes(months)) return { ok: false, status: 400, why: `it is paid for ${PREPAID_MONTHS.slice(0, -1).join(", ")} or ${PREPAID_MONTHS.at(-1)} months at a time.` };
    let holder: boolean;
    try { holder = await this.selling.holder(profile); } catch { return { ok: false, status: 502, why: "I could not read your wallet's balance just now, so I can't tell which price is yours. Try again in a minute." }; }
    const cents = (holder ? this.selling.centsHolder : this.selling.centsFull) * months;
    let units: bigint;
    if (asset === "USDC") units = usdcUnits(cents);
    else {
      try { units = lamportsFor(cents, await this.opts.price!()); } catch { return { ok: false, status: 503, why: "SOL cannot be priced right now. USDC can be used, or try again in a minute." }; }
    }
    const now = this.now();
    const intent: PayIntent = { reference: new PublicKey(randomBytes(32)).toBase58(), profile, asset, units: units.toString(), months, cents, createdAt: now, expiresAt: now + (asset === "SOL" ? SOL_QUOTE_SECONDS : USDC_QUOTE_SECONDS) };
    this.accounts.addIntent(intent, now);
    return { ok: true, quote: this.view(intent) };
  }

  private view(i: PayIntent): QuoteView {
    const decimals = i.asset === "SOL" ? 9 : 6;
    const query = new URLSearchParams({ amount: decimal(BigInt(i.units), decimals), ...(i.asset === "USDC" ? { "spl-token": this.mint } : {}), reference: i.reference, label: "Warden Sentinel", message: `Pro, ${i.months} month${i.months === 1 ? "" : "s"}` });
    return { reference: i.reference, payTo: this.cfg.payTo, asset: i.asset, units: i.units, decimals, mint: i.asset === "USDC" ? this.mint : null, months: i.months, cents: i.cents, expiresAt: i.expiresAt, url: `solana:${this.cfg.payTo}?${query.toString()}` };
  }

  /**
   * The unsigned transaction that pays a quote from one wallet, for the page to hand to that wallet. Refused
   * when the quote is gone, paid or out of time, and when the wallet plainly does not hold the amount: a
   * wallet is not asked to sign something that can only fail.
   */
  async transaction(profile: string, reference: unknown, payer: unknown): Promise<{ ok: true; transaction: string } | Refusal> {
    const intent = typeof reference === "string" && ADDRESS.test(reference) ? this.accounts.intentOf(profile, reference) : undefined;
    if (!intent) return { ok: false, status: 404, why: "there is no such quote. Ask for the amount again." };
    if (intent.paidBy) return { ok: false, status: 409, why: "that amount has been paid." };
    if (this.now() > intent.expiresAt) return { ok: false, status: 410, why: intent.asset === "SOL" ? "that price in SOL has run out. Ask for the amount again." : "that quote is over a week old. Ask for the amount again." };
    let from: PublicKey;
    try { if (typeof payer !== "string" || !ADDRESS.test(payer)) throw new Error(); from = new PublicKey(payer); } catch { return { ok: false, status: 400, why: "that is not a wallet address." }; }
    const units = BigInt(intent.units), mint = new PublicKey(this.mint), payTo = new PublicKey(this.cfg.payTo);
    try {
      if (intent.asset === "USDC") {
        // Lamport's own token account has to be there to be paid into; and the payer's has to hold the amount
        const ours = await this.rpc.call("getAccountInfo", [tokenAccountOf(payTo, mint).toBase58(), { encoding: "base64", commitment: "confirmed" }]);
        if (!ours?.value) return { ok: false, status: 503, why: "USDC cannot be taken just now. SOL can, or try again later." };
        const theirs = await this.rpc.call("getTokenAccountBalance", [tokenAccountOf(from, mint).toBase58(), { commitment: "confirmed" }]).catch(() => null);
        const have = /^\d+$/.test(String(theirs?.value?.amount ?? "")) ? BigInt(theirs.value.amount) : 0n;
        if (have < units) return { ok: false, status: 409, why: `that wallet holds ${decimal(have, 6)} USDC, and this needs ${decimal(units, 6)}.` };
      } else {
        const have = BigInt((await this.rpc.call("getBalance", [from.toBase58(), { commitment: "confirmed" }]))?.value ?? 0);
        if (have < units + 10_000n) return { ok: false, status: 409, why: `that wallet holds ${decimal(have, 9)} SOL, and this needs ${decimal(units, 9)} and the fee.` };
      }
      const recent = await this.rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]);
      const tx = new Transaction({ feePayer: from, recentBlockhash: String(recent?.value?.blockhash) }).add(paymentInstruction({ payer: from, payTo, asset: intent.asset, units, mint, reference: new PublicKey(intent.reference) }));
      return { ok: true, transaction: Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64") };
    } catch {
      return { ok: false, status: 502, why: "the chain could not be read just now. Try again in a minute." };
    }
  }

  /**
   * Looks on the chain for the payment of a quote, and credits it when it is there. Safe to ask as often as
   * the caller is allowed to: a payment is credited once, and asking again says "paid".
   */
  async check(profile: string, reference: unknown): Promise<{ ok: true; result: CheckView } | Refusal> {
    const intent = typeof reference === "string" && ADDRESS.test(reference) ? this.accounts.intentOf(profile, reference) : undefined;
    if (!intent) return { ok: false, status: 404, why: "there is no such quote. Ask for the amount again." };
    if (intent.paidBy) return { ok: true, result: { status: "paid", until: this.accounts.prepaidUntil(profile) } };
    // finalized: a payment that could still be undone is not one yet
    const listed: any[] = (await this.rpc.call("getSignaturesForAddress", [intent.reference, { limit: 10, commitment: "finalized" }])) ?? [];
    let best: CheckView = { status: "waiting" };
    for (const entry of [...listed].reverse()) {
      if (entry?.err || typeof entry?.signature !== "string" || this.accounts.credited(entry.signature)) continue;
      const tx = fromRpc(entry.signature, await this.rpc.call("getTransaction", [entry.signature, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "finalized" }]));
      // the list is the RPC's word; that the transaction names the reference is read from the transaction itself
      if (!tx || tx.failed || !accountKeys(tx).includes(intent.reference)) continue;
      const got = arrived(tx, this.cfg.payTo, intent.asset, this.mint);
      if (got <= 0n) continue;
      if (got < BigInt(intent.units)) { best = { status: "short", arrived: got.toString(), wanted: intent.units }; continue; }
      // a price in SOL holds for ten minutes: a payment made after that was made at another price
      if (intent.asset === "SOL" && (tx.blockTime ?? this.now()) > intent.expiresAt + SOL_QUOTE_GRACE_SECONDS) { best = { status: "late" }; continue; }
      const now = this.now();
      const was = this.accounts.prepaidUntil(profile);
      const until = addMonths(Math.max(now, was), intent.months);
      if (!this.accounts.credit(intent, { signature: entry.signature, asset: intent.asset, units: got.toString(), months: intent.months, cents: intent.cents, at: now }, until)) continue;
      const first = this.accounts.profile(profile)?.tier !== "pro";
      this.accounts.setTier(profile, "pro");
      this.tell(profile, first ? prepaidStartedNotice(until, PLANS.pro.wallets, PLANS.pro.pollSeconds, PLANS.pro.push) : prepaidExtendedNotice(until));
      return { ok: true, result: { status: "paid", until } };
    }
    return { ok: true, result: best };
  }

  /**
   * The hourly look at what has run out. A profile whose paid time is over, and that no card is paying for,
   * goes back to the free plan, told first on the channels the plan paid for. One whose time ends within
   * three days is told so, once for each end date.
   */
  expire(): { ended: number; reminded: number } {
    const now = this.now();
    let ended = 0, reminded = 0;
    for (const p of this.accounts.profiles()) {
      const until = p.prepaid?.until ?? 0;
      if (!until) continue;
      if (until <= now) {
        if (p.tier === "pro" && !this.selling.byCard(p.id)) {
          this.tell(p.id, planEndedNotice(PLANS.watch.wallets, Math.max(0, this.accounts.walletsOf(p.id).length - PLANS.watch.wallets)));
          this.accounts.setTier(p.id, "watch");
          ended += 1;
        }
      } else if (until - now <= REMIND_BEFORE_SECONDS && p.prepaid!.remindedFor !== until && !this.selling.byCard(p.id)) {
        this.tell(p.id, prepaidEndingNotice(until));
        this.accounts.reminded(p.id);
        reminded += 1;
      }
    }
    return { ended, reminded };
  }
}

export { PREPAID_MONTHS, decimal };
