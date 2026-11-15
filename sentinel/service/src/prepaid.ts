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
 *
 * And in LAMPORT, where that is turned on: a fixed number of tokens for a month, the same for everybody,
 * sent to Lamport's treasury wallet, which is another wallet than the one USDC and SOL go to. It is a
 * transfer like the one in USDC and is counted the same way, by what arrived. A quote remembers the wallet
 * and the token it was made for, so a payment made on it counts whatever the settings are by then.
 *
 * Nothing is counted twice, however many looks overlap: a transaction is marked spent in the same step that
 * counts it (accounts.ts), with nothing awaited in between. Looks at one quote take turns (`inTurn`), so two
 * answers about it never disagree; looks at different quotes do not wait for each other, so one profile
 * cannot hold up another's. A final transaction is read once (`seen`). And the service looks by itself,
 * every hour, for the quotes somebody built a payment for or asked about (`sweep`), so a payment does not
 * depend on the page that made it staying open.
 */
import { randomBytes } from "node:crypto";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { Accounts } from "./accounts.js";
import { prepaidEndingNotice, prepaidExtendedNotice, prepaidStartedNotice, planEndedNotice } from "./notices.js";
import { accountKeys, fromRpc, type ObservedTx } from "./observed.js";
import { looksLikeSignature } from "./crypto.js";
import { PLANS, PREPAID_MONTHS, decimal, grouped } from "./plans.js";
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
  /** Paying in LAMPORT: the token, how many whole tokens pay for one month, and the treasury wallet they are sent to. Absent: not offered. */
  lamport?: { mint: string; perMonth: number; payTo: string };
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
  /** For a token: the token account of `payTo` that the payment lands in. A wallet's prompt, and Warden's, name this address and not `payTo`. */
  account: string | null;
}
export type CheckView = { status: "waiting" } | { status: "paid"; until: number } | { status: "short"; arrived: string; wanted: string } | { status: "late" };

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** What a Token-2022 token may have and still be taken in payment: where its name and picture are kept, and nothing that keeps part of a transfer back or hides a balance. */
const PLAIN_EXTENSIONS = new Set(["metadataPointer", "tokenMetadata"]);
/**
 * How many transactions naming a quote the chain is asked to list (the most it gives at once), and how many
 * of those not read yet are read in one look from each end. From the old end, because a payment is older
 * than what is sent after it to bury it; from the new end, because the latest payment may be what completes
 * an earlier one. Anyone can add to the list once a payment has shown the quote's address, so this is a
 * convenience and not the certain way: a payment is found for certain by its signature.
 */
const LISTED = 1000, EACH_END = 12;
/**
 * The hourly look: how many quotes it goes through, how many of one profile's, and for how long after a
 * payment for a quote was last built or asked about.
 */
const SWEEP_MOST = 60, SWEEP_EACH = 3, SWEEP_SECONDS = 3 * 86_400;
/** And for how long a quote that was only shown is looked for, when there is room: a payment from a phone is made within minutes or not at all. */
const SWEEP_SHOWN_SECONDS = 86_400;
type Commitment = "finalized" | "confirmed";
const CHAIN_DOWN: Refusal = { ok: false, status: 502, why: "the chain could not be read just now. Try again in a minute." };
/** The token account a wallet keeps a token in unless it says otherwise. `program`: the token program the token is under. */
export const tokenAccountOf = (owner: PublicKey, mint: PublicKey, program: PublicKey = TOKEN_PROGRAM): PublicKey => PublicKey.findProgramAddressSync([owner.toBytes(), program.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM)[0];

/**
 * The transaction that pays a quote from `payer`: one transfer of exactly the quoted amount to Lamport's
 * address, naming the quote's reference. Nothing else is in it. It is unsigned; the payer's wallet signs it.
 */
export function paymentInstruction(o: { payer: PublicKey; payTo: PublicKey; asset: PayAsset; units: bigint; mint: PublicKey; reference: PublicKey; /** The token program the token is under, and its decimals: USDC's unless given. */ program?: PublicKey; decimals?: number }): TransactionInstruction {
  const named = { pubkey: o.reference, isSigner: false, isWritable: false };
  if (o.asset === "SOL") {
    const ix = SystemProgram.transfer({ fromPubkey: o.payer, toPubkey: o.payTo, lamports: o.units });
    ix.keys.push(named);
    return ix;
  }
  // TransferChecked: the token and its decimals are part of what is signed, so the amount cannot mean another token's
  const program = o.program ?? TOKEN_PROGRAM;
  const data = Buffer.alloc(10);
  data[0] = 12; data.writeBigUInt64LE(o.units, 1); data[9] = o.decimals ?? 6;
  return new TransactionInstruction({ programId: program, data, keys: [
    { pubkey: tokenAccountOf(o.payer, o.mint, program), isSigner: false, isWritable: true }, { pubkey: o.mint, isSigner: false, isWritable: false },
    { pubkey: tokenAccountOf(o.payTo, o.mint, program), isSigner: false, isWritable: true }, { pubkey: o.payer, isSigner: true, isWritable: false }, named,
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
  private lamportFacts: { program: PublicKey; decimals: number } | null = null;
  /**
   * What a final transaction that names a quote was found to be toward it, where it could not be counted:
   * nothing, short, or late. A final transaction does not change, so it is read once. Keyed
   * `${reference}:${signature}`: a transaction is nothing toward one quote and may be the payment of another.
   * Lost on a restart, which costs the reads again.
   */
  private seen = new Map<string, { got: bigint; late: boolean }>();
  private note(intent: PayIntent, signature: string, got: bigint, late = false): void {
    if (this.seen.size >= 50_000) this.seen.clear();
    this.seen.set(`${intent.reference}:${signature}`, { got, late });
  }
  private lines = new Map<string, Promise<unknown>>();
  /** Looks at one quote take turns. Looks at different quotes do not wait for each other. */
  private inTurn<T>(reference: string, work: () => Promise<T>): Promise<T> {
    const run = (this.lines.get(reference) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => undefined);
    this.lines.set(reference, tail);
    void tail.then(() => { if (this.lines.get(reference) === tail) this.lines.delete(reference); });
    return run;
  }
  /** When the service last looked for a quote by itself, so that every quote gets its turn. */
  private swept = new Map<string, number>();
  /** Which token program LAMPORT is under, and its decimals: read from the chain once. Throws when that could not be read. */
  private async lamportToken(): Promise<{ program: PublicKey; decimals: number }> {
    if (this.lamportFacts) return this.lamportFacts;
    const info = await this.rpc.call("getAccountInfo", [this.cfg.lamport!.mint, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const owner = String(info?.value?.owner ?? ""), decimals = info?.value?.data?.parsed?.info?.decimals;
    const program = owner === TOKEN_PROGRAM.toBase58() ? TOKEN_PROGRAM : owner === TOKEN_2022_PROGRAM.toBase58() ? TOKEN_2022_PROGRAM : null;
    if (!program || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("the token could not be read");
    // A payment is counted by what arrived. A token that keeps back a fee on transfers would arrive short of
    // the amount the page asked a wallet for, every time. So it is taken only for a token with no more to it
    // than its name and picture.
    const extensions: unknown[] = Array.isArray(info?.value?.data?.parsed?.info?.extensions) ? info.value.data.parsed.info.extensions : [];
    if (!extensions.every((e: any) => PLAIN_EXTENSIONS.has(e?.extension))) throw new Error("the token has features under which a payment in it cannot be counted");
    return (this.lamportFacts = { program, decimals });
  }
  private tell(profile: string, sentence: string): void { void this.opts.notice?.(profile, sentence).catch(() => undefined); }

  /** What the page needs to offer it. SOL is offered only where there is a price to quote it at. */
  offer(): { payTo: string; assets: PayAsset[]; months: readonly number[]; lamport?: { perMonth: number; payTo: string } } {
    const assets: PayAsset[] = this.opts.price ? ["USDC", "SOL"] : ["USDC"];
    const l = this.cfg.lamport;
    return l ? { payTo: this.cfg.payTo, assets: [...assets, "LAMPORT"], months: PREPAID_MONTHS, lamport: { perMonth: l.perMonth, payTo: l.payTo } } : { payTo: this.cfg.payTo, assets, months: PREPAID_MONTHS };
  }

  /** An amount to pay, and the reference that will mark the payment as this profile's. */
  async quote(profile: string, asset: unknown, months: unknown): Promise<{ ok: true; quote: QuoteView } | Refusal> {
    if (!this.accounts.profile(profile)) return { ok: false, status: 401, why: "sign in again." };
    if (!this.selling.sells(profile)) return { ok: false, status: 403, why: "the paid plan is not on sale yet." };
    if (this.selling.byCard(profile)) return { ok: false, status: 409, why: "this profile has the plan by card, which renews by itself. Cancel that first if you would rather pay ahead." };
    if (asset !== "USDC" && asset !== "SOL" && !(asset === "LAMPORT" && this.cfg.lamport)) return { ok: false, status: 400, why: this.cfg.lamport ? "it can be paid in USDC, SOL or LAMPORT." : "it can be paid in USDC or SOL." };
    if (asset === "SOL" && !this.opts.price) return { ok: false, status: 400, why: "it cannot be paid in SOL here. USDC can." };
    if (typeof months !== "number" || !PREPAID_MONTHS.includes(months)) return { ok: false, status: 400, why: `it is paid for ${PREPAID_MONTHS.slice(0, -1).join(", ")} or ${PREPAID_MONTHS.at(-1)} months at a time.` };
    if (asset === "LAMPORT") {
      // a number of tokens for a month, the same for everybody: there is no price in dollars to it, and so no lower price to work out
      let token: { decimals: number };
      try { token = await this.lamportToken(); } catch { return CHAIN_DOWN; }
      const l = this.cfg.lamport!;
      const units = BigInt(l.perMonth) * BigInt(months) * 10n ** BigInt(token.decimals);
      const at = this.now();
      // the quote keeps the wallet, the token and its decimals it was made for: a payment made on it counts whatever the settings are by then
      const intent: PayIntent = { reference: new PublicKey(randomBytes(32)).toBase58(), profile, asset, units: units.toString(), months, cents: 0, createdAt: at, expiresAt: at + USDC_QUOTE_SECONDS, mint: l.mint, payTo: l.payTo, decimals: token.decimals };
      this.accounts.addIntent(intent, at);
      return { ok: true, quote: this.view(intent, this.lamportFacts?.program) };
    }
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

  private view(i: PayIntent, program: PublicKey = TOKEN_PROGRAM): QuoteView {
    const decimals = i.asset === "SOL" ? 9 : i.decimals ?? 6;
    const payTo = i.payTo ?? this.cfg.payTo, mint = i.asset === "SOL" ? null : i.mint ?? this.mint;
    const account = mint ? tokenAccountOf(new PublicKey(payTo), new PublicKey(mint), program).toBase58() : null;
    const query = new URLSearchParams({ amount: decimal(BigInt(i.units), decimals), ...(mint ? { "spl-token": mint } : {}), reference: i.reference, label: "Warden Sentinel", message: `Pro, ${i.months} month${i.months === 1 ? "" : "s"}` });
    return { reference: i.reference, payTo, asset: i.asset, units: i.units, decimals, mint, months: i.months, cents: i.cents, expiresAt: i.expiresAt, url: `solana:${payTo}?${query.toString()}`, account };
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
      if (intent.asset === "LAMPORT") {
        if (!this.cfg.lamport || this.cfg.lamport.mint !== intent.mint) return { ok: false, status: 409, why: "it cannot be paid in LAMPORT here just now. Ask for the amount again in USDC or SOL." };
        const token = await this.lamportToken(), lamport = new PublicKey(intent.mint!), treasury = new PublicKey(intent.payTo!);
        // the treasury's own token account has to be there to be paid into; and the payer's has to hold the amount
        const ours = await this.rpc.call("getAccountInfo", [tokenAccountOf(treasury, lamport, token.program).toBase58(), { encoding: "base64", commitment: "confirmed" }]);
        if (!ours?.value) return { ok: false, status: 503, why: "LAMPORT cannot be taken just now. USDC or SOL can, or try again later." };
        let have: bigint;
        try {
          const theirs = await this.rpc.call("getTokenAccountBalance", [tokenAccountOf(from, lamport, token.program).toBase58(), { commitment: "confirmed" }]);
          if (!/^\d+$/.test(String(theirs?.value?.amount ?? ""))) throw new Error("no amount");
          have = BigInt(theirs.value.amount);
        } catch (e) {
          // no such account is an answer: the wallet has none. Anything else is the chain not answering.
          if (!/could not find account/i.test(String((e as Error)?.message ?? ""))) throw e;
          have = 0n;
        }
        if (have < units) return { ok: false, status: 409, why: `that wallet holds ${grouped(have, token.decimals)} LAMPORT, and this needs ${grouped(units, token.decimals)}.` };
        this.accounts.asked(intent, this.now());
        const recent = await this.rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]);
        const tx = new Transaction({ feePayer: from, recentBlockhash: String(recent?.value?.blockhash) }).add(paymentInstruction({ payer: from, payTo: treasury, asset: "LAMPORT", units, mint: lamport, reference: new PublicKey(intent.reference), program: token.program, decimals: token.decimals }));
        return { ok: true, transaction: Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64") };
      }
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
      // (a quote a payment was built for is looked for by the service itself from here on: sweep)
      this.accounts.asked(intent, this.now());
      const recent = await this.rpc.call("getLatestBlockhash", [{ commitment: "confirmed" }]);
      const tx = new Transaction({ feePayer: from, recentBlockhash: String(recent?.value?.blockhash) }).add(paymentInstruction({ payer: from, payTo, asset: intent.asset, units, mint, reference: new PublicKey(intent.reference) }));
      return { ok: true, transaction: Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64") };
    } catch {
      return { ok: false, status: 502, why: "the chain could not be read just now. Try again in a minute." };
    }
  }

  /**
   * The transactions the chain lists for a quote's address that did not fail and are not spent, oldest
   * first. Null when the chain did not answer.
   */
  private async listed(intent: PayIntent, commitment: Commitment): Promise<string[] | null> {
    try {
      const list: any[] = (await this.rpc.call("getSignaturesForAddress", [intent.reference, { limit: LISTED, commitment }])) ?? [];
      return [...list].reverse().filter((e) => !e?.err && typeof e?.signature === "string" && !this.accounts.credited(e.signature)).map((e) => e.signature as string);
    } catch { return null; }
  }

  /** Which to read in one look: the ones named by signature, then the oldest and the newest of the listed ones not read yet. */
  private toRead(intent: PayIntent, named: readonly string[], list: readonly string[]): string[] {
    const unread = (sig: string) => !this.accounts.credited(sig) && !this.seen.has(`${intent.reference}:${sig}`);
    const rest = list.filter(unread);
    const ends = rest.length <= 2 * EACH_END ? rest : [...rest.slice(0, EACH_END), ...rest.slice(-EACH_END)];
    return [...new Set([...named.filter(unread), ...ends])];
  }

  /**
   * One transaction, when it is on the chain at `commitment`, did not fail and names the quote. "nothing":
   * it was read, and failed or does not name the quote (remembered, once final). "unread": it could not be
   * read this time, or the answer could not be made sense of; it is asked for again at the next look. Null:
   * it is not there. One that cannot be read does not keep the others from being read.
   */
  private async readOne(intent: PayIntent, signature: string, commitment: Commitment): Promise<ObservedTx | "nothing" | "unread" | null> {
    const ask = (version: number) => this.rpc.call("getTransaction", [signature, { encoding: "base64", maxSupportedTransactionVersion: version, commitment }]);
    let result: any;
    try { result = await ask(0); }
    catch (e) {
      // a transaction in a newer form than was asked for: asked for again in that form, and read like any other
      const why = String((e as Error)?.message ?? "");
      if (!(/version/i.test(why) && /not supported/i.test(why))) return "unread";
      try { result = await ask(1); } catch { return "unread"; }
    }
    if (result === null || result === undefined) return null;
    const tx = fromRpc(signature, result);
    if (!tx) return "unread";
    // the list is the RPC's word; that the transaction names the reference is read from the transaction itself
    if (tx.failed || !accountKeys(tx).includes(intent.reference)) { if (commitment === "finalized") this.note(intent, signature, 0n); return "nothing"; }
    return tx;
  }

  /**
   * Looks on the chain for the payment of a quote, and credits it when it is there. Safe to ask as often as
   * the caller is allowed to: a payment is credited once, and asking again says "paid". `signatures`: the
   * transactions the caller says paid it. They are kept with the quote and read at every look, whatever
   * else names the quote.
   */
  check(profile: string, reference: unknown, signatures?: unknown): Promise<{ ok: true; result: CheckView } | Refusal> {
    const intent = typeof reference === "string" && ADDRESS.test(reference) ? this.accounts.intentOf(profile, reference) : undefined;
    if (!intent) return Promise.resolve({ ok: false, status: 404, why: "there is no such quote. Ask for the amount again." });
    const named = (Array.isArray(signatures) ? signatures : []).filter(looksLikeSignature).slice(0, 5);
    if (named.length) this.accounts.reported(intent, named);
    return this.inTurn(intent.reference, () => this.look(intent, true));
  }

  /** `asking`: somebody asked, which keeps the quote in the service's own hourly look for three days more. */
  private async look(intent: PayIntent, asking: boolean): Promise<{ ok: true; result: CheckView } | Refusal> {
    const profile = intent.profile;
    const paid = () => ({ ok: true as const, result: { status: "paid" as const, until: this.accounts.prepaidUntil(profile) } });
    if (intent.paidBy) {
      // credited, and the look was cut short before the plan was started (a write that failed): it is started now
      const until = this.accounts.prepaidUntil(profile);
      if (until > this.now() && this.accounts.profile(profile)?.tier !== "pro") this.started(profile, until);
      return paid();
    }
    if (asking) this.accounts.asked(intent, this.now());
    // finalized: a payment that could still be undone is not one yet
    const list = await this.listed(intent, "finalized");
    let unread = 0;
    for (const signature of this.toRead(intent, intent.sent ?? [], list ?? [])) {
      const tx = await this.readOne(intent, signature, "finalized");
      if (tx === "unread") { unread += 1; continue; }
      if (tx === null || tx === "nothing") continue;
      // (at the wallet and in the token the quote was made for: for LAMPORT, the treasury's, as they were then)
      const got = arrived(tx, intent.payTo ?? this.cfg.payTo, intent.asset, intent.mint ?? this.mint);
      // nothing, short, or late: read once and remembered, so that what cannot be counted is not read at every look
      if (got < BigInt(intent.units)) { this.note(intent, signature, got > 0n ? got : 0n); continue; }
      // a price in SOL holds for ten minutes: a payment made after that was made at another price
      if (intent.asset === "SOL" && (tx.blockTime ?? this.now()) > intent.expiresAt + SOL_QUOTE_GRACE_SECONDS) { this.note(intent, signature, got, true); continue; }
      const now = this.now();
      const until = addMonths(Math.max(now, this.accounts.prepaidUntil(profile)), intent.months);
      if (!this.accounts.credit(intent, { signature, asset: intent.asset, units: got.toString(), months: intent.months, cents: intent.cents, at: now }, until)) continue;
      this.started(profile, until);
      return paid();
    }
    if (intent.paidBy) return paid();
    // what was read, now or before, and could not be counted: one that came late, or the largest that was short
    // (not one that has since paid for another quote it also named: that is spent, and there is nothing of it to send back)
    let best: CheckView = { status: "waiting" };
    for (const signature of new Set([...(intent.sent ?? []), ...(list ?? [])])) {
      const was = this.seen.get(`${intent.reference}:${signature}`);
      if (!was || was.got <= 0n || this.accounts.credited(signature)) continue;
      if (was.late) best = { status: "late" };
      else if (best.status === "waiting" || (best.status === "short" && BigInt(best.arrived) < was.got)) best = { status: "short", arrived: was.got.toString(), wanted: intent.units };
    }
    // "nothing is there yet" is not said of a chain that did not answer, or of a transaction that could not be read
    if (best.status === "waiting" && (list === null || unread > 0)) return CHAIN_DOWN;
    return { ok: true, result: best };
  }

  /** A payment was credited: the profile has the plan, and its owner is told. */
  private started(profile: string, until: number): void {
    const first = this.accounts.profile(profile)?.tier !== "pro";
    this.accounts.setTier(profile, "pro");
    this.tell(profile, first ? prepaidStartedNotice(until, PLANS.pro.wallets, PLANS.pro.pollSeconds, PLANS.pro.push) : prepaidExtendedNotice(until));
  }

  /**
   * The hourly look for payments nobody is waiting on a page for. First the unpaid quotes a payment was
   * built for or asked about in the last three days: a tab that was closed before the chain made a payment
   * final does not lose it. Then, while there is room, the quotes of the last day that were only shown: a
   * payment made from a phone, by someone who never came back to press the button, is found too.
   *
   * So many an hour and no more, and every quote gets its turn: within each of the two, the ones looked for
   * longest ago go first, and no profile has more than a few of its quotes looked for in one hour. A profile
   * that keeps asking about its own quotes does not push anybody else's out.
   */
  async sweep(): Promise<{ looked: number; paid: number }> {
    const now = this.now();
    const open = this.accounts.intents().filter((i) => !i.paidBy);
    const turn = (a: PayIntent, b: PayIntent) => (this.swept.get(a.reference) ?? 0) - (this.swept.get(b.reference) ?? 0) || (b.askedAt ?? b.createdAt) - (a.askedAt ?? a.createdAt);
    const asked = open.filter((i) => i.askedAt !== undefined && now - i.askedAt <= SWEEP_SECONDS).sort(turn);
    const shown = open.filter((i) => i.askedAt === undefined && now - i.createdAt <= SWEEP_SHOWN_SECONDS).sort(turn);
    const live = new Set([...asked, ...shown].map((i) => i.reference));
    for (const reference of this.swept.keys()) if (!live.has(reference)) this.swept.delete(reference);
    const each = new Map<string, number>();
    let looked = 0, paid = 0;
    for (const intent of [...asked, ...shown]) {
      if (looked >= SWEEP_MOST) break;
      const mine = each.get(intent.profile) ?? 0;
      if (mine >= SWEEP_EACH) continue;
      each.set(intent.profile, mine + 1);
      looked += 1;
      this.swept.set(intent.reference, now);
      await this.inTurn(intent.reference, () => this.look(intent, false)).catch(() => undefined);
      if (intent.paidBy) paid += 1;
    }
    return { looked, paid };
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
