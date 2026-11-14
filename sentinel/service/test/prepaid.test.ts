/**
 * Paying for the plan ahead in USDC or SOL: what is quoted, how a payment is known to be this profile's, what
 * counts as paid, and what happens when the paid time runs out. The chain is stood in for by a list of
 * transactions with the balances they left; everything the code under test learns, it learns from those.
 */
import "../../../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { configFrom } from "../src/main.js";
import { api, type ApiRequest } from "../src/server.js";
import { NonceBook } from "../src/signin.js";
import { tokenAccountOf } from "../src/prepaid.js";
import { Accounts } from "../src/accounts.js";
import { dayOf, planEndedNotice, prepaidEndingNotice, prepaidExtendedNotice, prepaidStartedNotice } from "../src/notices.js";
import { PREPAID_MONTHS, Prepaid, REMIND_BEFORE_SECONDS, SOL_QUOTE_GRACE_SECONDS, SOL_QUOTE_SECONDS, USDC_MINT, USDC_QUOTE_SECONDS, addMonths, decimal, lamportsFor, usdcUnits, type Selling } from "../src/prepaid.js";
import type { Rpc } from "../src/rpc.js";
import { SolPrice, agreed, type PriceFetch } from "../src/solprice.js";
import { MemoryStore } from "../src/store.js";

const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const PAY_TO = key(40).toBase58(), A = key(1).toBase58(), B = key(2).toBase58();
const payer = key(60), other = key(61);
/** 2026-11-10 12:00 UTC. */
const T0 = 1_794_312_000;
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** A chain of payments: each a transaction that names some addresses and left some balances. */
class Chain implements Rpc {
  txs: { signature: string; names: string[]; failed: boolean; result: any }[] = [];
  asked: { method: string; commitment: unknown }[] = [];
  /** Signatures the RPC lists under an address though the transaction does not name it. */
  lies = new Map<string, string[]>();
  /** Token accounts that are not there; what token accounts hold; what wallets hold in lamports. */
  missing = new Set<string>();
  holds: Record<string, bigint> = {};
  sol: Record<string, number> = {};
  private n = 0;

  /** `from` pays `units` of `asset` to `to`, in a transaction that names `references`. `mint`: for a token other than USDC. */
  pay(o: { references: string[]; to?: string; asset: "USDC" | "SOL"; units: bigint; mint?: string; failed?: boolean; at?: number }): string {
    const to = new PublicKey(o.to ?? PAY_TO), tokenAccount = Keypair.generate().publicKey;
    const keys = [{ pubkey: payer, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: tokenAccount, isSigner: false, isWritable: true }, ...o.references.map((r) => ({ pubkey: new PublicKey(r), isSigner: false, isWritable: false }))];
    const tx = new Transaction({ feePayer: payer, recentBlockhash: "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x" }).add(new TransactionInstruction({ programId: MEMO, keys, data: Buffer.from("pay") }));
    const names = tx.compileMessage().accountKeys.map((k) => k.toBase58());
    const lamports = names.map(() => 1_000_000_000);
    const landed = !o.failed;
    const post = lamports.map((l, i) => l - (i === 0 ? 5000 : 0) + (landed && o.asset === "SOL" && names[i] === to.toBase58() ? Number(o.units) : 0));
    const token = (amount: bigint) => [{ accountIndex: names.indexOf(tokenAccount.toBase58()), mint: o.mint ?? USDC_MINT, owner: to.toBase58(), uiTokenAmount: { amount: amount.toString(), decimals: 6 } }];
    const signature = `pay${String(++this.n).padStart(4, "0")}`;
    this.txs.push({ signature, names, failed: !!o.failed, result: { slot: 1000 + this.n, blockTime: o.at ?? T0, transaction: [Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64"), "base64"], meta: { err: o.failed ? { InstructionError: [0, "Custom"] } : null, fee: 5000, preBalances: lamports, postBalances: post, preTokenBalances: o.asset === "USDC" ? token(1_000_000n) : [], postTokenBalances: o.asset === "USDC" ? token(1_000_000n + (landed ? o.units : 0n)) : [] } } });
    return signature;
  }

  async call(method: string, params: any[]): Promise<any> {
    this.asked.push({ method, commitment: params[1]?.commitment });
    if (method === "getSignaturesForAddress") {
      const listed = this.txs.filter((t) => t.names.includes(params[0]) || (this.lies.get(params[0]) ?? []).includes(t.signature)).reverse();
      return listed.slice(0, params[1]?.limit ?? 1000).map((t) => ({ signature: t.signature, err: t.failed ? {} : null }));
    }
    if (method === "getTransaction") return this.txs.find((t) => t.signature === params[0])?.result ?? null;
    // what building a payment asks: is Lamport's token account there, what does the payer hold, and a recent blockhash
    if (method === "getAccountInfo") return { value: this.missing.has(params[0]) ? null : { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" } };
    if (method === "getTokenAccountBalance") { if (!(params[0] in this.holds)) throw new Error("could not find account"); return { value: { amount: String(this.holds[params[0]]) } }; }
    if (method === "getBalance") return { value: this.sol[params[0]] ?? 0 };
    if (method === "getLatestBlockhash") return { value: { blockhash: "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x" } };
    throw new Error(`unexpected ${method}`);
  }
}

function setup(over: Partial<Selling> & { price?: (() => Promise<number>) | null } = {}) {
  const store = new MemoryStore();
  const accounts = new Accounts(store, Buffer.alloc(32, 9));
  const chain = new Chain();
  const said: { profile: string; sentence: string }[] = [];
  let now = T0;
  const { price, ...selling } = over;
  const prepaid = new Prepaid({ payTo: PAY_TO }, accounts, chain,
    { sells: () => true, holder: async () => false, byCard: () => false, centsFull: 1500, centsHolder: 1000, ...selling },
    { now: () => now, notice: async (profile, sentence) => { said.push({ profile, sentence }); }, ...(price === null ? {} : { price: price ?? (async () => 75) }) });
  const admit = (wallet: string) => { const r = accounts.admit(wallet, null, T0); if (!r.ok) throw new Error("setup"); return r.profile; };
  const profile = admit(A);
  const quoted = async (asset: "USDC" | "SOL" = "USDC", months = 1, who = profile) => { const r = await prepaid.quote(who, asset, months); if (!r.ok) throw new Error(r.why); return r.quote; };
  const check = async (reference: string, who = profile) => { const r = await prepaid.check(who, reference); if (!r.ok) throw new Error(r.why); return r.result; };
  return { store, accounts, chain, prepaid, said, profile, admit, quoted, check, tick: (s: number) => { now += s; }, now: () => now };
}

describe("an amount to pay", () => {
  it("is the monthly price times the months, in USDC to the cent, and names an address that marks the payment", async () => {
    const s = setup();
    const q = await s.quoted("USDC", 1);
    expect(q).toMatchObject({ payTo: PAY_TO, asset: "USDC", units: "15000000", decimals: 6, mint: USDC_MINT, months: 1, cents: 1500, expiresAt: T0 + USDC_QUOTE_SECONDS });
    expect(q.reference).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect((await s.quoted("USDC", 3)).units).toBe("45000000");
    expect((await s.quoted("USDC", 12)).units).toBe("180000000");
    // every quote has its own
    expect(new Set([q.reference, (await s.quoted()).reference, (await s.quoted()).reference]).size).toBe(3);
    // and can be opened by a wallet as a payment request
    const url = new URL(q.url);
    expect(url.protocol).toBe("solana:");
    expect(url.pathname).toBe(PAY_TO);
    expect(Object.fromEntries(url.searchParams)).toEqual({ amount: "15", "spl-token": USDC_MINT, reference: q.reference, label: "Warden Sentinel", message: "Pro, 1 month" });
    expect(PREPAID_MONTHS).toEqual([1, 3, 12]);
  });

  it("is the holder's price for a profile whose wallets hold the token, and nobody's on a guess", async () => {
    expect((await setup({ holder: async () => true }).quoted("USDC", 3))).toMatchObject({ units: "30000000", cents: 3000 });
    const unread = setup({ holder: async () => { throw new Error("rpc down"); } });
    expect(await unread.prepaid.quote(unread.profile, "USDC", 1)).toEqual({ ok: false, status: 502, why: "I could not read your wallet's balance just now, so I can't tell which price is yours. Try again in a minute." });
  });

  it("in SOL is priced when it is asked for, rounded up to the lamport, and holds for ten minutes", async () => {
    const s = setup({ price: async () => 77.33 });
    const q = await s.quoted("SOL", 1);
    expect(q).toMatchObject({ asset: "SOL", decimals: 9, mint: null, cents: 1500, expiresAt: T0 + SOL_QUOTE_SECONDS });
    expect(q.units).toBe(lamportsFor(1500, 77.33).toString());
    expect(BigInt(q.units)).toBe(193_973_879n); // 15 / 77.33 SOL, and the fraction of a lamport goes up
    expect(new URL(q.url).searchParams.get("amount")).toBe("0.193973879");
    expect(new URL(q.url).searchParams.has("spl-token")).toBe(false);
    // no price, no quote in SOL; USDC needs none
    const down = setup({ price: async () => { throw new Error("no two sources agree"); } });
    expect(await down.prepaid.quote(down.profile, "SOL", 1)).toEqual({ ok: false, status: 503, why: "SOL cannot be priced right now. USDC can be used, or try again in a minute." });
    expect((await down.prepaid.quote(down.profile, "USDC", 1)).ok).toBe(true);
    // a service told to take USDC only does not offer SOL
    const only = setup({ price: null });
    expect(only.prepaid.offer()).toEqual({ payTo: PAY_TO, assets: ["USDC"], months: [1, 3, 12] });
    expect(await only.prepaid.quote(only.profile, "SOL", 1)).toMatchObject({ ok: false, status: 400 });
    expect(s.prepaid.offer().assets).toEqual(["USDC", "SOL"]);
  });

  it("is refused to a profile that is not sold to, to one a card already pays for, and for anything that is not on the list", async () => {
    const closed = setup({ sells: () => false });
    expect(await closed.prepaid.quote(closed.profile, "USDC", 1)).toEqual({ ok: false, status: 403, why: "the paid plan is not on sale yet." });
    const card = setup({ byCard: () => true });
    expect(await card.prepaid.quote(card.profile, "USDC", 1)).toMatchObject({ ok: false, status: 409 });
    const s = setup();
    for (const [asset, months] of [["BTC", 1], ["USDC", 2], ["USDC", 0], ["USDC", "1"], ["USDC", 1.5], [undefined, 1], ["USDC", undefined]] as [unknown, unknown][]) expect((await s.prepaid.quote(s.profile, asset, months)).ok, `${asset} ${months}`).toBe(false);
    expect(await s.prepaid.quote("nobody", "USDC", 1)).toMatchObject({ ok: false, status: 401 });
    expect(s.store.accounts.intents ?? []).toEqual([]); // nothing refused left a quote behind
  });
});

describe("a payment", () => {
  it("is counted when the chain shows the amount arrived at Lamport's address in a transaction that names the quote", async () => {
    const s = setup();
    const q = await s.quoted("USDC", 1);
    expect(await s.check(q.reference)).toEqual({ status: "waiting" });
    expect(s.accounts.profile(s.profile)!.tier).toBe("watch");
    const signature = s.chain.pay({ references: [q.reference], asset: "USDC", units: 15_000_000n });
    const until = addMonths(T0, 1);
    expect(await s.check(q.reference)).toEqual({ status: "paid", until });
    expect(s.accounts.profile(s.profile)).toMatchObject({ tier: "pro", prepaid: { until, payments: [{ signature, asset: "USDC", units: "15000000", months: 1, cents: 1500, at: T0 }] } });
    // the owner hears the plan has started, until when, and that it does not renew
    expect(s.said).toEqual([{ profile: s.profile, sentence: prepaidStartedNotice(until, 10, 20, true) }]);
    expect(s.said[0]!.sentence).toContain(`It is paid until ${dayOf(until)} and does not renew by itself.`);
    // asked again, it is still paid and nothing more happens
    expect(await s.check(q.reference)).toEqual({ status: "paid", until });
    expect(s.said).toHaveLength(1);
    // both the list and the transaction are read at finalized: a payment that could still be undone is not one
    expect(s.chain.asked.every((a) => a.commitment === "finalized")).toBe(true);
    expect(s.chain.asked.map((a) => a.method)).toContain("getTransaction");
  });

  it("pays for one thing, once: a transaction that names two quotes is credited to one of them", async () => {
    const s = setup();
    const other = s.admit(B);
    const mine = await s.quoted("USDC", 1), theirs = await s.quoted("USDC", 1, other);
    s.chain.pay({ references: [mine.reference, theirs.reference], asset: "USDC", units: 15_000_000n });
    expect((await s.check(mine.reference)).status).toBe("paid");
    expect(await s.check(theirs.reference, other)).toEqual({ status: "waiting" });
    expect(s.accounts.profile(other)!.tier).toBe("watch");
    // nor twice to the same profile under a second quote
    const again = await s.quoted("USDC", 1);
    s.chain.lies.set(again.reference, [s.chain.txs[0]!.signature]);
    expect(await s.check(again.reference)).toEqual({ status: "waiting" });
  });

  it("is not taken on the RPC's word: a transaction that does not name the quote, failed, or paid someone else is nothing", async () => {
    const s = setup();
    const q = await s.quoted("USDC", 1);
    // listed under the quote by a lying RPC, though it names another
    const stranger = s.chain.pay({ references: [key(99).toBase58()], asset: "USDC", units: 15_000_000n });
    s.chain.lies.set(q.reference, [stranger]);
    expect(await s.check(q.reference)).toEqual({ status: "waiting" });
    // names the quote and failed; names the quote and paid another address; names the quote and paid another token
    s.chain.pay({ references: [q.reference], asset: "USDC", units: 15_000_000n, failed: true });
    s.chain.pay({ references: [q.reference], asset: "USDC", units: 15_000_000n, to: other.toBase58() });
    s.chain.pay({ references: [q.reference], asset: "USDC", units: 15_000_000n, mint: key(77).toBase58() });
    s.chain.pay({ references: [q.reference], asset: "SOL", units: 15_000_000_000n }); // SOL, for a quote in USDC
    expect(await s.check(q.reference)).toEqual({ status: "waiting" });
    expect(s.accounts.profile(s.profile)!.tier).toBe("watch");
    expect(s.said).toEqual([]);
  });

  it("that is short is said to be short, with what arrived, and one that makes it good is then counted", async () => {
    const s = setup();
    const q = await s.quoted("USDC", 3);
    s.chain.pay({ references: [q.reference], asset: "USDC", units: 44_999_999n });
    expect(await s.check(q.reference)).toEqual({ status: "short", arrived: "44999999", wanted: "45000000" });
    expect(s.accounts.profile(s.profile)!.tier).toBe("watch");
    s.chain.pay({ references: [q.reference], asset: "USDC", units: 45_000_000n });
    expect(await s.check(q.reference)).toEqual({ status: "paid", until: addMonths(T0, 3) });
    // more than was asked is a payment too, and is recorded as what arrived
    const over = setup();
    const big = await over.quoted("USDC", 1);
    over.chain.pay({ references: [big.reference], asset: "USDC", units: 20_000_000n });
    expect((await over.check(big.reference)).status).toBe("paid");
    expect(over.accounts.profile(over.profile)!.prepaid!.payments[0]!.units).toBe("20000000");
  });

  it("in SOL counts at the price it was quoted, for as long as that price held and a little after", async () => {
    const s = setup({ price: async () => 75 });
    const q = await s.quoted("SOL", 1);
    expect(q.units).toBe("200000000"); // 15 dollars at 75 is a fifth of a SOL
    s.chain.pay({ references: [q.reference], asset: "SOL", units: 200_000_000n, at: T0 + SOL_QUOTE_SECONDS + SOL_QUOTE_GRACE_SECONDS + 1 });
    expect(await s.check(q.reference)).toEqual({ status: "late" });
    expect(s.accounts.profile(s.profile)!.tier).toBe("watch");
    const fresh = await s.quoted("SOL", 1);
    s.chain.pay({ references: [fresh.reference], asset: "SOL", units: 200_000_000n, at: T0 + SOL_QUOTE_SECONDS + SOL_QUOTE_GRACE_SECONDS });
    expect((await s.check(fresh.reference)).status).toBe("paid");
    // USDC is a dollar for a dollar and has no such clock
    const u = setup();
    const uq = await u.quoted("USDC", 1);
    u.chain.pay({ references: [uq.reference], asset: "USDC", units: 15_000_000n, at: T0 + 6 * 86_400 });
    expect((await u.check(uq.reference)).status).toBe("paid");
  });

  it("belongs to the profile it was quoted to: another profile cannot look for it or claim it", async () => {
    const s = setup();
    const thief = s.admit(B);
    const q = await s.quoted("USDC", 1);
    s.chain.pay({ references: [q.reference], asset: "USDC", units: 15_000_000n });
    expect(await s.prepaid.check(thief, q.reference)).toEqual({ ok: false, status: 404, why: "there is no such quote. Ask for the amount again." });
    expect(s.accounts.profile(thief)!.tier).toBe("watch");
    for (const bad of ["", "not an address", null, 5, PAY_TO]) expect((await s.prepaid.check(s.profile, bad)).ok).toBe(false);
    expect((await s.check(q.reference)).status).toBe("paid");
  });
});

describe("the time that was paid for", () => {
  it("is added to what is left when the owner pays again before it is up, and they are told the new day", async () => {
    const s = setup();
    const first = await s.quoted("USDC", 1);
    s.chain.pay({ references: [first.reference], asset: "USDC", units: 15_000_000n });
    await s.check(first.reference);
    s.tick(10 * 86_400);
    const second = await s.quoted("USDC", 3);
    s.chain.pay({ references: [second.reference], asset: "USDC", units: 45_000_000n });
    const until = addMonths(addMonths(T0, 1), 3);
    expect(await s.check(second.reference)).toEqual({ status: "paid", until });
    expect(s.said.at(-1)!.sentence).toBe(prepaidExtendedNotice(until));
    expect(s.accounts.profile(s.profile)!.prepaid!.payments).toHaveLength(2);
    // paid again after it ran out: it starts from now, not from the day it ended
    s.tick(400 * 86_400);
    const third = await s.quoted("USDC", 1);
    s.chain.pay({ references: [third.reference], asset: "USDC", units: 15_000_000n });
    expect(await s.check(third.reference)).toEqual({ status: "paid", until: addMonths(s.now(), 1) });
  });

  it("is said to be ending three days before, once, and when it is over the profile is on the free plan again", async () => {
    const s = setup();
    const q = await s.quoted("USDC", 1);
    s.chain.pay({ references: [q.reference], asset: "USDC", units: 15_000_000n });
    await s.check(q.reference);
    const until = addMonths(T0, 1);
    s.said.length = 0;
    expect(s.prepaid.expire()).toEqual({ ended: 0, reminded: 0 });
    s.tick(until - T0 - REMIND_BEFORE_SECONDS - 60);
    expect(s.prepaid.expire()).toEqual({ ended: 0, reminded: 0 }); // a minute too soon
    s.tick(120);
    expect(s.prepaid.expire()).toEqual({ ended: 0, reminded: 1 });
    expect(s.said).toEqual([{ profile: s.profile, sentence: prepaidEndingNotice(until) }]);
    expect(s.said[0]!.sentence).toContain("does not renew by itself. To keep it, pay again on the Sentinel page before then.");
    expect(s.prepaid.expire()).toEqual({ ended: 0, reminded: 0 }); // said once
    s.tick(REMIND_BEFORE_SECONDS);
    expect(s.prepaid.expire()).toEqual({ ended: 1, reminded: 0 });
    expect(s.accounts.profile(s.profile)!.tier).toBe("watch");
    expect(s.said.at(-1)!.sentence).toBe(planEndedNotice(3, 0));
    expect(s.prepaid.expire()).toEqual({ ended: 0, reminded: 0 });
    // paying again after that is a new start, and the next ending is its own reminder
    const again = await s.quoted("USDC", 1);
    s.chain.pay({ references: [again.reference], asset: "USDC", units: 15_000_000n });
    await s.check(again.reference);
    s.tick(addMonths(s.now(), 1) - s.now() - 86_400);
    expect(s.prepaid.expire()).toEqual({ ended: 0, reminded: 1 });
  });

  it("running out does not end a plan that a card has since started paying for", async () => {
    let card = false;
    const s = setup({ byCard: () => card });
    const q = await s.quoted("USDC", 1);
    s.chain.pay({ references: [q.reference], asset: "USDC", units: 15_000_000n });
    await s.check(q.reference);
    card = true;
    s.tick(40 * 86_400);
    expect(s.prepaid.expire()).toEqual({ ended: 0, reminded: 0 });
    expect(s.accounts.profile(s.profile)!.tier).toBe("pro");
  });

  it("keeps a profile's quotes for a week and the newest twenty, and never drops one that was paid", async () => {
    const s = setup();
    const paid = await s.quoted("USDC", 1);
    s.chain.pay({ references: [paid.reference], asset: "USDC", units: 15_000_000n });
    await s.check(paid.reference);
    for (let i = 0; i < 30; i++) await s.quoted("USDC", 1);
    const mine = (s.store.accounts.intents ?? []).filter((i) => i.profile === s.profile);
    expect(mine.length).toBeLessThanOrEqual(21);
    expect(mine.some((i) => i.reference === paid.reference && i.paidBy)).toBe(true);
    s.tick(8 * 86_400);
    await s.quoted("USDC", 1);
    expect((s.store.accounts.intents ?? []).length).toBe(1);
    // the transaction stays spent after its quote is forgotten
    expect(s.accounts.credited(s.chain.txs[0]!.signature)).toBe(true);
  });
});

describe("the arithmetic", () => {
  it("counts months on the calendar", () => {
    const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    expect(addMonths(at("2026-11-10T12:00:00Z"), 1)).toBe(at("2026-12-10T12:00:00Z"));
    expect(addMonths(at("2026-11-10T12:00:00Z"), 3)).toBe(at("2027-02-10T12:00:00Z"));
    expect(addMonths(at("2027-01-31T08:00:00Z"), 1)).toBe(at("2027-02-28T08:00:00Z")); // there is no 31st of February
    expect(addMonths(at("2028-01-31T08:00:00Z"), 1)).toBe(at("2028-02-29T08:00:00Z"));
    expect(addMonths(at("2026-11-30T00:00:00Z"), 12)).toBe(at("2027-11-30T00:00:00Z"));
  });

  it("turns dollars into each asset's smallest units without losing a cent, and rounds SOL up", () => {
    expect(usdcUnits(1500)).toBe(15_000_000n);
    expect(usdcUnits(1)).toBe(10_000n);
    expect(lamportsFor(1500, 150)).toBe(100_000_000n);
    expect(lamportsFor(1000, 3)).toBe(3_333_333_334n);
    expect(() => lamportsFor(1500, 0)).toThrow();
    expect(decimal(15_000_000n, 6)).toBe("15");
    expect(decimal(193_973_879n, 9)).toBe("0.193973879");
    expect(decimal(1_500_000_000n, 9)).toBe("1.5");
    expect(decimal(1n, 6)).toBe("0.000001");
  });
});

describe("the price of SOL", () => {
  it("is what two or more sources agree on, and nothing when they do not", () => {
    expect(agreed([77.31, 77.33, 77.33])).toBeCloseTo(77.3233, 3);
    expect(agreed([77.3, 77.4, 150])).toBeCloseTo(77.35, 5); // one of three is wrong: the other two stand
    expect(agreed([77.3, NaN, 77.9])).toBeCloseTo(77.6, 5);
    expect(agreed([77, 80])).toBeNull(); // more than two in a hundred apart
    expect(agreed([77])).toBeNull();
    expect(agreed([NaN, NaN, 0, -5])).toBeNull();
    expect(agreed([])).toBeNull();
  });

  it("asks three, survives one being down or wrong, and keeps the answer for half a minute", async () => {
    let now = T0, asked = 0;
    const answers: Record<string, unknown> = { coinbase: { data: { amount: "77.33" } }, kraken: { result: { SOLUSD: { c: ["77.30000", "1"] } } }, "jup.ag": { So11111111111111111111111111111111111111112: { usdPrice: 9999 } } };
    const fetchImpl: PriceFetch = async (url) => { asked += 1; const hit = Object.keys(answers).find((k) => url.includes(k)); if (!hit || answers[hit] === "down") throw new Error("down"); return { ok: true, json: async () => answers[hit] }; };
    const price = new SolPrice(fetchImpl, { now: () => now });
    expect(await price.usd()).toBeCloseTo(77.315, 3);
    expect(asked).toBe(3);
    await price.usd();
    expect(asked).toBe(3); // kept
    now += 31;
    answers.kraken = "down";
    await expect(price.usd()).rejects.toThrow("fewer than two sources agree"); // one honest source and one wrong one
    answers["jup.ag"] = { So11111111111111111111111111111111111111112: { usdPrice: 77.4 } };
    expect(await price.usd()).toBeCloseTo(77.365, 3);
  });
});

describe("the payment handed to a wallet", () => {
  const usdc = new PublicKey(USDC_MINT);
  it("is one transfer of exactly the quoted amount to Lamport's address, naming the quote, and nothing else", async () => {
    const s = setup();
    const q = await s.quoted("USDC", 3);
    s.chain.holds[tokenAccountOf(payer, usdc).toBase58()] = 50_000_000n;
    const made = await s.prepaid.transaction(s.profile, q.reference, payer.toBase58());
    if (!made.ok) throw new Error(made.why);
    const tx = Transaction.from(Buffer.from(made.transaction, "base64"));
    expect(tx.feePayer!.toBase58()).toBe(payer.toBase58());
    expect(tx.instructions).toHaveLength(1);
    const ix = tx.instructions[0]!;
    expect(ix.programId.toBase58()).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    // TransferChecked, 45 USDC, six decimals: source, mint, destination, owner, and the quote's reference
    expect([...ix.data]).toEqual([12, ...new Uint8Array(new BigUint64Array([45_000_000n]).buffer), 6]);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [tokenAccountOf(payer, usdc).toBase58(), false, true], [USDC_MINT, false, false], [tokenAccountOf(new PublicKey(PAY_TO), usdc).toBase58(), false, true], [payer.toBase58(), true, true] /* writable because it also pays the fee */, [q.reference, false, false],
    ]);
    // in SOL: a plain transfer of the lamports, naming the quote
    const sq = await s.quoted("SOL", 1);
    s.chain.sol[payer.toBase58()] = 5_000_000_000;
    const sol = await s.prepaid.transaction(s.profile, sq.reference, payer.toBase58());
    if (!sol.ok) throw new Error(sol.why);
    const stx = Transaction.from(Buffer.from(sol.transaction, "base64"));
    expect(stx.instructions).toHaveLength(1);
    expect(stx.instructions[0]!.programId.toBase58()).toBe(SystemProgram.programId.toBase58());
    expect(stx.instructions[0]!.keys.map((k) => k.pubkey.toBase58())).toEqual([payer.toBase58(), PAY_TO, sq.reference]);
    expect(stx.instructions[0]!.data.readBigUInt64LE(4)).toBe(200_000_000n);
  });

  it("is not made for a wallet that does not hold the amount, a quote that is gone, paid or out of time, or when Lamport's own account is not there", async () => {
    const s = setup();
    const q = await s.quoted("USDC", 1);
    expect(await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).toEqual({ ok: false, status: 409, why: "that wallet holds 0 USDC, and this needs 15." });
    s.chain.holds[tokenAccountOf(payer, usdc).toBase58()] = 14_990_000n;
    expect(await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).toEqual({ ok: false, status: 409, why: "that wallet holds 14.99 USDC, and this needs 15." });
    s.chain.holds[tokenAccountOf(payer, usdc).toBase58()] = 15_000_000n;
    expect((await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).ok).toBe(true);
    expect(await s.prepaid.transaction(s.profile, q.reference, "not a wallet")).toMatchObject({ ok: false, status: 400 });
    expect(await s.prepaid.transaction(s.profile, key(98).toBase58(), payer.toBase58())).toMatchObject({ ok: false, status: 404 });
    expect(await s.prepaid.transaction(s.admit(B), q.reference, payer.toBase58())).toMatchObject({ ok: false, status: 404 }); // another profile's quote
    // Lamport's token account missing: nothing is built that could only fail
    s.chain.missing.add(tokenAccountOf(new PublicKey(PAY_TO), usdc).toBase58());
    expect(await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).toMatchObject({ ok: false, status: 503 });
    s.chain.missing.clear();
    // paid: not built again
    s.chain.pay({ references: [q.reference], asset: "USDC", units: 15_000_000n });
    await s.check(q.reference);
    expect(await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).toEqual({ ok: false, status: 409, why: "that amount has been paid." });
    // a price in SOL that has run out
    const sq = await s.quoted("SOL", 1);
    s.chain.sol[payer.toBase58()] = 5_000_000_000;
    s.tick(SOL_QUOTE_SECONDS + 1);
    expect(await s.prepaid.transaction(s.profile, sq.reference, payer.toBase58())).toEqual({ ok: false, status: 410, why: "that price in SOL has run out. Ask for the amount again." });
  });
});

describe("over the API", () => {
  function served(opts: { open?: boolean; subscribed?: boolean; prepaid?: boolean } = {}) {
    const s = setup();
    const quote = { enabled: true as const, checkoutOpen: opts.open ?? true, tier: "watch" as const, subscribed: opts.subscribed ?? false, status: null, price: "full" as const, cents: 1500, centsFull: 1500, centsHolder: 1000, holder: false, holderMin: 250_000, renewsAt: null, endsAt: null, paidUntil: null };
    const handle = api({ accounts: s.accounts, store: s.store, watcher: { ownerSigned: async () => undefined, confirmOwn: async () => true }, nonces: new NonceBook(), origin: "https://warden.lamportrobotics.com", now: () => s.now(), billing: { api: { quote: async () => quote } as any, webhookSecret: "whsec_x" }, ...(opts.prepaid === false ? {} : { prepaid: s.prepaid }) });
    const session = s.accounts.startSession(s.profile, T0, A);
    const call = (method: string, path: string, body?: unknown, bearer: string | null = session) => handle({ method, path, body, bearer, ip: "10.0.0.1" } satisfies ApiRequest);
    return { ...s, call };
  }

  it("is offered to whoever the card plan is offered to, and not beside a card plan", async () => {
    expect(((await served().call("GET", "/v1/billing")).body as any).crypto).toEqual({ payTo: PAY_TO, assets: ["USDC", "SOL"], months: [1, 3, 12] });
    expect(((await served({ open: false }).call("GET", "/v1/billing")).body as any).crypto).toBeNull();
    expect(((await served({ subscribed: true }).call("GET", "/v1/billing")).body as any).crypto).toBeNull();
    const without = served({ prepaid: false });
    expect(((await without.call("GET", "/v1/billing")).body as any).crypto).toBeNull();
    expect(await without.call("POST", "/v1/billing/crypto/quote", { asset: "USDC", months: 1 })).toEqual({ status: 404, body: { error: "the plan cannot be paid in USDC or SOL here." } });
  });

  it("quotes, looks for the payment, and says when it is paid; a few quotes an hour, and only to someone signed in", async () => {
    const s = served();
    expect((await s.call("POST", "/v1/billing/crypto/quote", { asset: "USDC", months: 1 }, null)).status).toBe(401);
    const q = await s.call("POST", "/v1/billing/crypto/quote", { asset: "USDC", months: 1 });
    expect(q.status).toBe(201);
    const reference = (q.body as any).reference as string;
    expect((await s.call("POST", "/v1/billing/crypto/check", { reference })).body).toEqual({ status: "waiting" });
    s.chain.pay({ references: [reference], asset: "USDC", units: 15_000_000n });
    expect((await s.call("POST", "/v1/billing/crypto/check", { reference })).body).toEqual({ status: "paid", until: addMonths(T0, 1) });
    expect((await s.call("POST", "/v1/billing/crypto/check", { reference: key(97).toBase58() })).status).toBe(404);
    expect((await s.call("POST", "/v1/billing/crypto/quote", { asset: "DOGE", months: 1 })).status).toBe(400);
    for (let i = 0; i < 4; i++) expect((await s.call("POST", "/v1/billing/crypto/quote", { asset: "USDC", months: 1 })).status).toBe(201);
    expect((await s.call("POST", "/v1/billing/crypto/quote", { asset: "USDC", months: 1 })).status).toBe(429); // six in the hour, the refused one among them
  });
});

describe("where payments go", () => {
  const base = { SENTINEL_RPC_URL: "https://rpc.example", SENTINEL_DATA_KEY: Buffer.alloc(32, 1).toString("base64") };
  const stripe = { SENTINEL_STRIPE_SECRET_KEY: "sk_test_x", SENTINEL_STRIPE_WEBHOOK_SECRET: "whsec_x", SENTINEL_STRIPE_PRICE_FULL: "price_1", SENTINEL_STRIPE_PRICE_HOLDER: "price_2" };
  it("is one address, set beside the rest of the paid plan, or not at all", () => {
    expect(configFrom({ ...base, ...stripe })).toMatchObject({ ok: true, config: { payTo: null, paySol: true } });
    expect(configFrom({ ...base, ...stripe, SENTINEL_PAY_TO: ` ${PAY_TO} `, SENTINEL_PAY_SOL: "off" })).toMatchObject({ ok: true, config: { payTo: PAY_TO, paySol: false } });
    expect(configFrom({ ...base, ...stripe, SENTINEL_PAY_TO: "not-an-address" })).toEqual({ ok: false, why: "SENTINEL_PAY_TO has to be a wallet address." });
    expect(configFrom({ ...base, SENTINEL_PAY_TO: PAY_TO })).toMatchObject({ ok: false, why: expect.stringContaining("needs the paid plan's settings") });
  });
});
