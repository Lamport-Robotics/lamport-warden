/**
 * Paying for the plan in LAMPORT: the plan's price in dollars, turned into LAMPORT at the token's price
 * when the amount is shown, and sent to Lamport's treasury wallet, which is another wallet than the one USDC
 * and SOL go to. What is quoted, what the wallet is handed to sign, and what counts as paid.
 *
 * And what holds for every way of paying ahead, tried here on this one: nothing is credited twice however
 * many looks overlap, one profile's looks do not hold up another's, a payment is found by its signature
 * whatever else names its quote, and the service looks by itself for a payment whose page was closed.
 *
 * The chain is stood in for by a list of transactions with the balances they left.
 */
import "../../../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { LAMPORT_MINT, configFrom } from "../src/main.js";
import { Accounts } from "../src/accounts.js";
import { LAMPORT_TERMS, grouped, lamportTerms, prepaidTerms } from "../src/plans.js";
import { LamportPrice, hourAgo, lamportFor } from "../src/lamportprice.js";
import { Prepaid, SOL_QUOTE_GRACE_SECONDS, SOL_QUOTE_SECONDS, arrived, tokenAccountOf } from "../src/prepaid.js";
import type { PriceFetch } from "../src/solprice.js";
import { fromRpc } from "../src/observed.js";
import type { Rpc } from "../src/rpc.js";
import { api, type ApiRequest } from "../src/server.js";
import { NonceBook } from "../src/signin.js";
import { judge } from "../../../src/judge.js";
import { ARMING_ORIGIN } from "../../../src/defaults.js";
import { MemoryStore } from "../src/store.js";

const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
/** Where USDC and SOL go, and the treasury LAMPORT goes to: two wallets. */
const PAY_TO = key(40).toBase58(), TREASURY = key(41).toBase58();
const payer = key(60);
const T0 = 1_794_312_000;
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const MINT = new PublicKey(LAMPORT_MINT), USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKENS = (n: number) => BigInt(n) * 1_000_000n; // six decimals, as the token has
/** A price at which the plan's fifteen dollars are a round 25,000 LAMPORT. */
const PRICE = 0.0006;
const TREASURY_ACCOUNT = tokenAccountOf(new PublicKey(TREASURY), MINT, TOKEN_2022).toBase58();

class Chain implements Rpc {
  txs: { signature: string; names: string[]; failed: boolean; final: boolean; listed: boolean; result: any }[] = [];
  holds: Record<string, bigint> = {};
  /** Token accounts that exist. The treasury's own LAMPORT account does, unless a test takes it away. */
  exists = new Set<string>([TREASURY_ACCOUNT]);
  asked: string[] = [];
  mintAnswers: any = { value: { owner: TOKEN_2022.toBase58(), data: { parsed: { info: { decimals: 6 } } } } };
  /** The RPC is not answering about balances. */
  down = false;
  /** How long reading one transaction takes, so that looks made at once overlap. */
  slow = 0;
  /** Transactions the RPC fails to read, and ones in a form it says it does not support; and the list itself failing. */
  broken = new Set<string>();
  unsupported = new Set<string>();
  noList = false;
  private n = 0;

  /**
   * A transaction signed by `payer` that names `references` and leaves these balances of a token: [account's
   * owner, before, after] for each account it touched. `final: false`: on the chain, not yet final.
   * `listed: false`: the chain's list for an address does not show it (it is found by its signature only).
   */
  did(o: { references: string[]; balances: [string, bigint, bigint][]; mint?: string; failed?: boolean; final?: boolean; listed?: boolean }): string {
    const accounts = o.balances.map(() => Keypair.generate().publicKey);
    const keys = [{ pubkey: payer, isSigner: true, isWritable: true }, ...accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })), ...o.references.map((r) => ({ pubkey: new PublicKey(r), isSigner: false, isWritable: false }))];
    const tx = new Transaction({ feePayer: payer, recentBlockhash: "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x" }).add(new TransactionInstruction({ programId: MEMO, keys, data: Buffer.from("x") }));
    const names = tx.compileMessage().accountKeys.map((k) => k.toBase58());
    const lamports = names.map(() => 1_000_000_000);
    const side = (which: 1 | 2) => o.balances.map((b, i) => ({ accountIndex: names.indexOf(accounts[i]!.toBase58()), mint: o.mint ?? LAMPORT_MINT, owner: b[0], uiTokenAmount: { amount: (o.failed ? b[1] : b[which]).toString(), decimals: 6 } }));
    // a real signature is 64 bytes in base58: the service takes nothing else for one
    const signature = bs58(Buffer.concat([Buffer.alloc(60, 7), Buffer.from(new Uint32Array([++this.n]).buffer)]));
    this.txs.push({ signature, names, failed: !!o.failed, final: o.final !== false, listed: o.listed !== false, result: { slot: 1000 + this.n, blockTime: T0, transaction: [Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64"), "base64"], meta: { err: o.failed ? {} : null, fee: 5000, preBalances: lamports, postBalances: lamports, preTokenBalances: side(1), postTokenBalances: side(2) } } });
    return signature;
  }
  /** A payment of so many LAMPORT that arrives at the treasury, naming these quotes. */
  paid(references: string[], units: bigint, o: { final?: boolean; listed?: boolean } = {}): string {
    return this.did({ references, balances: [[payer.toBase58(), TOKENS(1_000_000), TOKENS(1_000_000) - units], [TREASURY, 0n, units]], ...o });
  }
  /** A transaction that merely names a quote and moves nothing. */
  dust(reference: string): string { return this.did({ references: [reference], balances: [] }); }
  /** The chain makes a transaction final. */
  finalize(signature: string): void { this.txs.find((t) => t.signature === signature)!.final = true; }

  async call(method: string, params: any[]): Promise<any> {
    this.asked.push(method);
    const seen = (t: { final: boolean }, commitment: unknown) => commitment !== "finalized" || t.final;
    if (method === "getSignaturesForAddress" && this.noList) throw new Error("timed out");
    if (method === "getTransaction" && this.broken.has(params[0])) throw new Error("timed out");
    if (method === "getTransaction" && this.unsupported.has(params[0]) && !(params[1]?.maxSupportedTransactionVersion >= 1)) throw new Error("Transaction version (1) is not supported by the requesting client. Please try the request again with the following configuration parameter: \"maxSupportedTransactionVersion\": 1");
    if (method === "getSignaturesForAddress") return this.txs.filter((t) => t.listed && t.names.includes(params[0]) && seen(t, params[1]?.commitment)).reverse().slice(0, params[1]?.limit ?? 1000).map((t) => ({ signature: t.signature, err: t.failed ? {} : null }));
    if (method === "getTransaction") { if (this.slow) await new Promise((r) => setTimeout(r, this.slow)); return this.txs.find((t) => t.signature === params[0] && seen(t, params[1]?.commitment))?.result ?? null; }
    if (method === "getAccountInfo") return params[0] === LAMPORT_MINT ? this.mintAnswers : { value: this.exists.has(params[0]) ? { owner: TOKEN_2022.toBase58(), data: ["", "base64"] } : null };
    if (method === "getTokenAccountBalance") { if (this.down) throw new Error("timed out"); if (!(params[0] in this.holds)) throw new Error("Invalid param: could not find account"); return { value: { amount: String(this.holds[params[0]]) } }; }
    if (method === "getLatestBlockhash") return { value: { blockhash: "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x" } };
    throw new Error(`unexpected ${method}`);
  }
}
const bs58 = (bytes: Uint8Array): string => new PublicKey(bytes.subarray(0, 32)).toBase58().padEnd(44, "1") + new PublicKey(bytes.subarray(32, 64)).toBase58().padEnd(44, "1");

function setup(o: { off?: true; holder?: () => Promise<boolean> } = {}) {
  const store = new MemoryStore();
  const accounts = new Accounts(store, Buffer.alloc(32, 9));
  const chain = new Chain();
  const said: string[] = [];
  let now = T0;
  const market = { price: PRICE as number | null };
  const selling = { sells: () => true, holder: o.holder ?? (async () => false), byCard: () => false, centsFull: 1500, centsHolder: 1000 };
  const made = (cfg: { lamport?: { mint: string; payTo: string } }, priced = true) => new Prepaid({ payTo: PAY_TO, ...cfg }, accounts, chain, selling,
    { now: () => now, notice: async (_p, sentence) => { said.push(sentence); }, ...(priced ? { lamportPrice: async () => { if (market.price === null) throw new Error("no two sources agree"); return market.price; } } : {}) });
  const prepaid = made(o.off ? {} : { lamport: { mint: LAMPORT_MINT, payTo: TREASURY } });
  const admit = (n: number) => { const r = accounts.admit(key(n).toBase58(), null, T0); if (!r.ok) throw new Error("setup"); return r.profile; };
  const profile = admit(1);
  const quoted = async (months = 1, of = profile, by = prepaid) => { const r = await by.quote(of, "LAMPORT", months); if (!r.ok) throw new Error(r.why); return r.quote; };
  const check = async (reference: string, signatures?: string[], of = profile) => { const r = await prepaid.check(of, reference, signatures); if (!r.ok) throw new Error(r.why); return r.result; };
  const months = (of = profile) => (accounts.profile(of)?.prepaid?.payments ?? []).reduce((sum, p) => sum + p.months, 0);
  const reads = () => chain.asked.filter((m) => m === "getTransaction").length;
  chain.holds[tokenAccountOf(payer, MINT, TOKEN_2022).toBase58()] = TOKENS(1_000_000);
  return { store, accounts, chain, prepaid, said, profile, quoted, check, admit, made, months, reads, market, later: (seconds: number) => { now += seconds; } };
}

describe("paying in LAMPORT, when it is not turned on", () => {
  it("is not offered and not quoted: with no treasury wallet named, or with nothing to price it by", async () => {
    const s = setup({ off: true });
    expect(s.prepaid.offer()).toEqual({ payTo: PAY_TO, assets: ["USDC"], months: [1, 3, 12] });
    expect(await s.prepaid.quote(s.profile, "LAMPORT", 1)).toEqual({ ok: false, status: 400, why: "it can be paid in USDC or SOL." });
    const unpriced = s.made({ lamport: { mint: LAMPORT_MINT, payTo: TREASURY } }, false);
    expect(unpriced.offer()).toEqual({ payTo: PAY_TO, assets: ["USDC"], months: [1, 3, 12] });
    expect(await unpriced.quote(s.profile, "LAMPORT", 1)).toEqual({ ok: false, status: 400, why: "it can be paid in USDC or SOL." });
  });

  it("is one setting, the treasury wallet, and it has no default. How many tokens is not a setting: it is the price in dollars", () => {
    const base = { SENTINEL_RPC_URL: "https://rpc.example", SENTINEL_DATA_KEY: Buffer.alloc(32, 1).toString("base64"), SENTINEL_STRIPE_SECRET_KEY: "sk_test_x", SENTINEL_STRIPE_WEBHOOK_SECRET: "whsec_x", SENTINEL_STRIPE_PRICE_FULL: "price_1", SENTINEL_STRIPE_PRICE_HOLDER: "price_2", SENTINEL_PAY_TO: PAY_TO };
    const on = configFrom({ ...base, SENTINEL_LAMPORT_PAY_TO: TREASURY });
    expect(on.ok && on.config.lamportPayTo).toBe(TREASURY);
    expect(on.ok && on.config.lamportMint).toBe(LAMPORT_MINT);
    const off = configFrom(base);
    expect(off.ok && off.config.lamportPayTo).toBeNull();
    expect(configFrom({ ...base, SENTINEL_LAMPORT_PAY_TO: "not an address" })).toEqual({ ok: false, why: "SENTINEL_LAMPORT_PAY_TO has to be a wallet address." });
    expect(configFrom({ ...base, SENTINEL_LAMPORT_PAY_TO: TREASURY, SENTINEL_LAMPORT_PER_MONTH: "25000" })).toEqual({ ok: false, why: "SENTINEL_LAMPORT_PER_MONTH is not a setting any more: the amount is the plan's price in dollars at LAMPORT's price. Take it out." });
    const { SENTINEL_PAY_TO: _gone, ...alone } = base;
    expect(configFrom({ ...alone, SENTINEL_LAMPORT_PAY_TO: TREASURY })).toEqual({ ok: false, why: "SENTINEL_LAMPORT_PAY_TO needs SENTINEL_PAY_TO beside it: paying in LAMPORT is one of the ways of paying ahead." });
  });
});

describe("an amount in LAMPORT", () => {
  it("is the plan's price in dollars at the token's price, in whole tokens, to the treasury wallet and not the one USDC goes to, and holds for ten minutes", async () => {
    const s = setup();
    expect(s.prepaid.offer()).toEqual({ payTo: PAY_TO, assets: ["USDC", "LAMPORT"], months: [1, 3, 12], lamport: { payTo: TREASURY } });
    const q = await s.quoted(3);
    // forty-five dollars at six hundredths of a cent a token
    expect(q).toMatchObject({ asset: "LAMPORT", units: TOKENS(75_000).toString(), decimals: 6, mint: LAMPORT_MINT, months: 3, cents: 4500, payTo: TREASURY, account: TREASURY_ACCOUNT, expiresAt: T0 + SOL_QUOTE_SECONDS });
    // a payment request any wallet can open: the treasury, the token, the amount in whole tokens, the reference
    const url = new URL(q.url.replace("solana:", "https://x/"));
    expect(q.url.startsWith(`solana:${TREASURY}?`)).toBe(true);
    expect([url.searchParams.get("amount"), url.searchParams.get("spl-token"), url.searchParams.get("reference")]).toEqual(["75000", LAMPORT_MINT, q.reference]);
    // the reference is an address nobody holds, and a new one each time, as for any other quote
    expect(() => new PublicKey(q.reference)).not.toThrow();
    expect((await s.quoted(3)).reference).not.toBe(q.reference);
    // the token's decimals and its program are read from the chain, once
    expect(s.chain.asked.filter((m) => m === "getAccountInfo")).toHaveLength(1);
  });

  it("follows the price: the same dollars are more tokens when the token is worth less, rounded up to a whole token", async () => {
    const s = setup();
    s.market.price = 0.000052272863069870546; // what it cost on the day this was written
    const q = await s.quoted(1);
    expect(q.cents).toBe(1500);
    expect(q.units).toBe(TOKENS(286_956).toString()); // 15 / 0.0000522728… = 286,955.7…
    expect(BigInt(q.units) % 1_000_000n).toBe(0n);
  });

  it("is at the holder's price for a holder, as in USDC; and is not made up when the wallet's balance cannot be read", async () => {
    const holder = setup({ holder: async () => true });
    expect(await holder.quoted(1)).toMatchObject({ cents: 1000, units: TOKENS(16_667).toString() }); // ten dollars: 16,666.67 tokens, rounded up
    const unread = setup({ holder: async () => { throw new Error("the RPC is down"); } });
    expect(await unread.prepaid.quote(unread.profile, "LAMPORT", 1)).toEqual({ ok: false, status: 502, why: "I could not read your wallet's balance just now, so I can't tell which price is yours. Try again in a minute." });
  });

  it("is not quoted when LAMPORT cannot be priced: USDC still is", async () => {
    const s = setup();
    s.market.price = null;
    expect(await s.prepaid.quote(s.profile, "LAMPORT", 1)).toEqual({ ok: false, status: 503, why: "LAMPORT cannot be priced right now. USDC can be used, or try again in a minute." });
    expect((await s.prepaid.quote(s.profile, "USDC", 1)).ok).toBe(true);
    // nor at a price that is not one
    for (const bad of [0, -1, NaN, 1e-15]) { s.market.price = bad; expect(await s.prepaid.quote(s.profile, "LAMPORT", 1), String(bad)).toMatchObject({ ok: false, status: 503 }); }
  });

  it("follows the price by itself: the page is given LAMPORT's price with what is offered each time it asks, and no price is not an error", async () => {
    const s = setup();
    expect(await s.prepaid.lamportNow()).toBe(PRICE);
    // what the page asks for every twenty seconds
    const quote = { enabled: true as const, checkoutOpen: true, tier: "watch" as const, subscribed: false, status: null, price: "full" as const, cents: 1500, centsFull: 1500, centsHolder: 1000, holder: false, holderMin: 250_000, renewsAt: null, endsAt: null, paidUntil: null };
    const handle = api({ accounts: s.accounts, store: s.store, watcher: { ownerSigned: async () => undefined, confirmOwn: async () => true }, nonces: new NonceBook(), origin: "https://warden.lamportrobotics.com", now: () => T0, billing: { api: { quote: async () => quote } as any, webhookSecret: "whsec_x" }, prepaid: s.prepaid });
    const session = s.accounts.startSession(s.profile, T0, key(1).toBase58());
    const offered = async () => ((await handle({ method: "GET", path: "/v1/billing", body: undefined, bearer: session, ip: "10.0.0.1" } satisfies ApiRequest)).body as any).crypto;
    expect(await offered()).toEqual({ payTo: PAY_TO, assets: ["USDC", "LAMPORT"], months: [1, 3, 12], lamport: { payTo: TREASURY, usd: PRICE } });
    // the price moves, and the next asking has it
    s.market.price = PRICE / 2;
    expect((await offered()).lamport.usd).toBe(PRICE / 2);
    // with no price just now LAMPORT is still offered, with nothing to estimate by; asking for an amount says why not
    s.market.price = null;
    expect(await offered()).toEqual({ payTo: PAY_TO, assets: ["USDC", "LAMPORT"], months: [1, 3, 12], lamport: { payTo: TREASURY, usd: null } });
    expect(await s.prepaid.lamportNow()).toBeNull();
    for (const bad of [0, -1, NaN]) { s.market.price = bad; expect(await s.prepaid.lamportNow(), String(bad)).toBeNull(); }
    // and where LAMPORT is not taken there is nothing to say about its price
    expect(await setup({ off: true }).prepaid.lamportNow()).toBeNull();
  });

  it("is not quoted when the token cannot be read from the chain, or is not a token", async () => {
    const s = setup();
    s.chain.mintAnswers = { value: null };
    expect(await s.prepaid.quote(s.profile, "LAMPORT", 1)).toEqual({ ok: false, status: 502, why: "the chain could not be read just now. Try again in a minute." });
    s.chain.mintAnswers = { value: { owner: "11111111111111111111111111111111", data: ["", "base64"] } };
    expect(await s.prepaid.quote(s.profile, "LAMPORT", 1)).toMatchObject({ ok: false, status: 502 });
  });

  it("is not quoted for a token with more to it than a name and a picture: one that keeps back part of a transfer would always arrive short", async () => {
    for (const extension of ["transferFeeConfig", "confidentialTransferMint", "transferHook", "somethingNew"]) {
      const s = setup();
      s.chain.mintAnswers = { value: { owner: TOKEN_2022.toBase58(), data: { parsed: { info: { decimals: 6, extensions: [{ extension: "tokenMetadata", state: {} }, { extension, state: {} }] } } } } };
      expect(await s.prepaid.quote(s.profile, "LAMPORT", 1), extension).toMatchObject({ ok: false, status: 502 });
    }
    // and the token as it is, with its name and picture and nothing else, is
    const s = setup();
    s.chain.mintAnswers = { value: { owner: TOKEN_2022.toBase58(), data: { parsed: { info: { decimals: 6, extensions: [{ extension: "metadataPointer", state: {} }, { extension: "tokenMetadata", state: {} }] } } } } };
    expect((await s.quoted(1)).units).toBe(TOKENS(25_000).toString());
  });
});

describe("the price of LAMPORT", () => {
  // the three sources' answers, in the shapes they gave on the day this was written
  const jupiter = (p: number | null) => (p === null ? {} : { [LAMPORT_MINT]: { usdPrice: p, liquidity: 9764.24, decimals: 6, priceChange24h: -20.6 } });
  const gecko = (p: number | null) => ({ data: { attributes: { symbol: "LAMPORT", price_usd: p === null ? null : String(p) } } });
  const dex = (p: number | null, change: unknown = { h1: -1.61, h6: -0.77, h24: -20.59 }, more: any[] = []) => (p === null ? [] : [{ dexId: "raydium", priceUsd: String(p), liquidity: { usd: 19441.28 }, priceChange: change }, ...more]);
  function priced(answers: { jupiter?: unknown; gecko?: unknown; dex?: unknown; down?: string[] }) {
    let now = T0, asked = 0;
    const fetchImpl: PriceFetch = async (url) => {
      asked += 1;
      const which = url.includes("jup.ag") ? "jupiter" : url.includes("geckoterminal") ? "gecko" : "dex";
      if (answers.down?.includes(which)) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => (answers as any)[which] };
    };
    return { price: new LamportPrice(LAMPORT_MINT, fetchImpl, { now: () => now }), asked: () => asked, later: (s: number) => { now += s; } };
  }

  it("is what two or more of three public sources agree on, to within five in a hundred, and is asked for once in half a minute", async () => {
    const p = priced({ jupiter: jupiter(0.0000522729), gecko: gecko(0.0000523546), dex: dex(0.00005297, {}) });
    expect(await p.price.usd()).toBeCloseTo((0.0000522729 + 0.0000523546 + 0.00005297) / 3, 12);
    expect(p.asked()).toBe(3);
    await p.price.usd();
    expect(p.asked()).toBe(3);
    p.later(31);
    await p.price.usd();
    expect(p.asked()).toBe(6);
    // one of three that is wrong does not set it: the other two stand
    expect(await priced({ jupiter: jupiter(0.9), gecko: gecko(0.00005), dex: dex(0.000051, {}) }).price.usd()).toBeCloseTo(0.0000505, 10);
  });

  it("is the lower of the price now and the price an hour ago: a price pushed up for a minute buys nothing", async () => {
    // doubled within the hour: what is used is what it cost before
    const pumped = await priced({ jupiter: jupiter(0.0001), gecko: gecko(0.0001), dex: dex(0.0001, { h1: 100 }) }).price.usd();
    expect(pumped).toBeCloseTo(0.00005, 12);
    // fallen within the hour: the price now is the lower, and is used
    const fallen = await priced({ jupiter: jupiter(0.00005), gecko: gecko(0.00005), dex: dex(0.00005, { h1: -50 }) }).price.usd();
    expect(fallen).toBeCloseTo(0.00005, 12);
    // no trade in the hour: nothing changed
    expect(await priced({ jupiter: jupiter(0.00005), gecko: gecko(0.00005), dex: dex(0.00005, {}) }).price.usd()).toBeCloseTo(0.00005, 12);
    expect(hourAgo(0.0001, dex(0.0001, { h1: 25 }))).toBeCloseTo(0.00008, 12);
    // the pool with the most in it is the one read, not the first listed
    expect(hourAgo(1, [{ priceUsd: "1", liquidity: { usd: 10 }, priceChange: { h1: 900 } }, { priceUsd: "1", liquidity: { usd: 5000 }, priceChange: { h1: 100 } }])).toBeCloseTo(0.5, 12);
  });

  it("is not given at all when it cannot be stood behind", async () => {
    const none = async (a: Parameters<typeof priced>[0]) => expect(priced(a).price.usd()).rejects.toThrow("could not be established");
    await none({ jupiter: jupiter(0.00005), gecko: gecko(0.00006), dex: dex(0.00007) });                 // no two agree
    await none({ jupiter: jupiter(0.00005), gecko: gecko(null), dex: dex(null) });                       // one answer
    await none({ jupiter: jupiter(0.00005), gecko: gecko(0.00005), dex: dex(0.00005), down: ["dex"] });   // the source that knows the hour before is down
    await none({ jupiter: jupiter(0.00005), gecko: gecko(0.00005), dex: dex(0.0001, { h1: 100 }) });      // or is not among those that agree
    await none({ jupiter: jupiter(0.00005), gecko: gecko(0.00005), dex: dex(0.00005, null) });            // or says nothing readable about the hour
    await none({ jupiter: jupiter(0.00005), gecko: gecko(0.00005), dex: dex(0.00005, { h1: "soon" }) });
    await none({ jupiter: jupiter(0.00005), gecko: gecko(0.00005), dex: dex(0.00005, { h1: -100 }) });
    await none({ jupiter: jupiter(0), gecko: gecko(0), dex: dex(0, {}) });                               // nothing is not a price
  });

  it("turns dollars into whole tokens, rounded up, in the token's smallest units", () => {
    expect(lamportFor(1500, 0.0006, 6)).toBe(TOKENS(25_000));
    expect(lamportFor(1500, 0.00060001, 6)).toBe(TOKENS(25_000));   // 24,999.58…
    expect(lamportFor(1500, 0.00059999, 6)).toBe(TOKENS(25_001));   // 25,000.41…
    expect(lamportFor(18_000, 0.000052272863069870546, 6)).toBe(TOKENS(3_443_470)); // twelve months: 3,443,469.05…
    expect(lamportFor(1, 1, 6)).toBe(TOKENS(1));                    // a cent of a one-dollar token is still a whole token
    for (const bad of [0, -1, NaN, 1e-15]) expect(() => lamportFor(1500, bad, 6), String(bad)).toThrow();
    // an amount that would not fit in what a token transfer can carry is not made
    expect(() => lamportFor(1_000_000_000, 1e-9, 9)).toThrow();
  });
});

describe("the payment handed to a wallet", () => {
  it("is one transfer of exactly the quoted amount from the payer's own account to the treasury's, naming the quote, and nothing else", async () => {
    const s = setup();
    const q = await s.quoted(1);
    const made = await s.prepaid.transaction(s.profile, q.reference, payer.toBase58());
    if (!made.ok) throw new Error(made.why);
    const tx = Transaction.from(Buffer.from(made.transaction, "base64"));
    expect(tx.feePayer!.toBase58()).toBe(payer.toBase58());
    expect(tx.instructions).toHaveLength(1);
    const ix = tx.instructions[0]!;
    // under the program the token is under, which for LAMPORT is Token-2022
    expect(ix.programId.toBase58()).toBe(TOKEN_2022.toBase58());
    // TransferChecked, 25,000 tokens, six decimals: from, the token, to, the owner, and the quote's reference
    expect([...ix.data]).toEqual([12, ...new Uint8Array(new BigUint64Array([TOKENS(25_000)]).buffer), 6]);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [tokenAccountOf(payer, MINT, TOKEN_2022).toBase58(), false, true], [LAMPORT_MINT, false, false], [TREASURY_ACCOUNT, false, true], [payer.toBase58(), true, true], [q.reference, false, false],
    ]);
    // the wallet USDC and SOL go to is nowhere in it
    expect(tx.compileMessage().accountKeys.map((k) => k.toBase58())).not.toContain(PAY_TO);
  });

  it("is read by Warden, in front of the wallet, as a payment in that token to the treasury's token account: the address the page names beside the wallet's", async () => {
    const s = setup();
    const q = await s.quoted(3);
    const made = await s.prepaid.transaction(s.profile, q.reference, payer.toBase58());
    if (!made.ok) throw new Error(made.why);
    const store = { load: async () => undefined, save: async () => undefined, ringSites: async () => [] };
    const { verdict } = await judge({ kind: "tx", bytes: Buffer.from(made.transaction, "base64"), owner: payer.toBase58() }, ARMING_ORIGIN, store);
    const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
    // nothing about Sentinel's own payment is waved through: it is asked about like any first payment to an address
    expect(verdict.level).toBe("explain");
    expect(verdict.sentence).toBe(`From warden.lamportrobotics.com: Sends ${q.units} units of token ${short(LAMPORT_MINT)} to ${short(q.account!)}. You've never paid ${short(q.account!)}.`);
  });

  it("is not made while the treasury has no account for the token to arrive in, for a wallet that does not hold the amount, or when the chain does not answer", async () => {
    const s = setup();
    const q = await s.quoted(1);
    s.chain.exists.delete(TREASURY_ACCOUNT);
    expect(await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).toEqual({ ok: false, status: 503, why: "LAMPORT cannot be taken just now. USDC or SOL can, or try again later." });
    s.chain.exists.add(TREASURY_ACCOUNT);
    delete s.chain.holds[tokenAccountOf(payer, MINT, TOKEN_2022).toBase58()];
    expect(await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).toEqual({ ok: false, status: 409, why: "that wallet holds 0 LAMPORT, and this needs 25,000." });
    s.chain.holds[tokenAccountOf(payer, MINT, TOKEN_2022).toBase58()] = TOKENS(24_999);
    expect(await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).toEqual({ ok: false, status: 409, why: "that wallet holds 24,999 LAMPORT, and this needs 25,000." });
    // a chain that does not answer is not taken for an empty wallet
    s.chain.down = true;
    expect(await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).toEqual({ ok: false, status: 502, why: "the chain could not be read just now. Try again in a minute." });
  });
});

describe("a payment in LAMPORT", () => {
  it("is counted when that much arrived at the treasury in a transaction that names the quote", async () => {
    const s = setup();
    const q = await s.quoted(1);
    expect(await s.check(q.reference)).toEqual({ status: "waiting" });
    const signature = s.chain.paid([q.reference], TOKENS(25_000));
    expect((await s.check(q.reference)).status).toBe("paid");
    expect(s.accounts.profile(s.profile)?.tier).toBe("pro");
    expect(s.accounts.profile(s.profile)?.prepaid?.payments).toEqual([{ signature, asset: "LAMPORT", units: TOKENS(25_000).toString(), months: 1, cents: 1500, at: T0 }]);
    expect(s.said).toHaveLength(1);
    // asked again, it is paid, and not counted twice
    expect((await s.check(q.reference)).status).toBe("paid");
    expect(s.accounts.profile(s.profile)?.prepaid?.payments).toHaveLength(1);
  });

  it("is what arrived at the treasury and nothing else: sent to somebody else, to the wallet USDC goes to, burned, failed, another token, or not naming the quote, it is nothing", async () => {
    const s = setup();
    const q = await s.quoted(1);
    const sent = (to: string, o: { mint?: string; failed?: boolean; references?: string[] } = {}) => s.chain.did({ references: o.references ?? [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)], [to, 0n, TOKENS(25_000)]], ...(o.mint ? { mint: o.mint } : {}), ...(o.failed ? { failed: true } : {}) });
    sent(key(77).toBase58());                                  // to somebody else
    sent(PAY_TO);                                              // to the wallet USDC and SOL go to
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]] }); // burned: it went to nobody
    sent(TREASURY, { failed: true });                          // failed
    sent(TREASURY, { mint: USDC });                            // another token, to the treasury
    sent(TREASURY, { references: [key(79).toBase58()] });      // the right payment, naming some other quote
    expect(await s.check(q.reference)).toEqual({ status: "waiting" });
    expect(s.accounts.profile(s.profile)?.tier).toBe("watch");
    // read from the balances: what the treasury's accounts of the token rose by
    const tx = fromRpc("x", s.chain.txs[0]!.result)!;
    expect(arrived(tx, TREASURY, "LAMPORT", LAMPORT_MINT)).toBe(0n);
    expect(arrived(tx, key(77).toBase58(), "LAMPORT", LAMPORT_MINT)).toBe(TOKENS(25_000));
  });

  it("that is short starts nothing and is said to be short; the full amount, sent after, is counted", async () => {
    const s = setup();
    const q = await s.quoted(1);
    s.chain.paid([q.reference], TOKENS(10_000));
    expect(await s.check(q.reference)).toEqual({ status: "short", arrived: TOKENS(10_000).toString(), wanted: TOKENS(25_000).toString() });
    expect(s.accounts.profile(s.profile)?.tier).toBe("watch");
    s.chain.paid([q.reference], TOKENS(25_000));
    expect((await s.check(q.reference)).status).toBe("paid");
    expect(s.months()).toBe(1);
  });

  it("made after the price has run out is not counted at that price: it is said to be late, and no payment is built for it by then", async () => {
    const s = setup();
    const q = await s.quoted(1);
    const other = await s.quoted(1);
    s.later(SOL_QUOTE_SECONDS + 1);
    expect(await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).toEqual({ ok: false, status: 410, why: "that price in LAMPORT has run out. Ask for the amount again." });
    // one that was on its way when it ran out is taken
    const justLate = s.chain.paid([q.reference], TOKENS(25_000));
    s.chain.txs.find((t) => t.signature === justLate)!.result.blockTime = T0 + SOL_QUOTE_SECONDS + SOL_QUOTE_GRACE_SECONDS;
    expect((await s.check(q.reference)).status).toBe("paid");
    // one made after that is not
    const late = s.chain.paid([other.reference], TOKENS(25_000));
    s.chain.txs.find((t) => t.signature === late)!.result.blockTime = T0 + SOL_QUOTE_SECONDS + SOL_QUOTE_GRACE_SECONDS + 1;
    expect(await s.check(other.reference)).toEqual({ status: "late" });
    expect(s.months()).toBe(1);
  });

  it("is counted against the wallet and the token its quote was made for, whatever the settings are by then", async () => {
    const s = setup();
    const q = await s.quoted(1);
    // the treasury is changed to another wallet, and the token's price halves: the same store, other settings
    const moved = s.made({ lamport: { mint: LAMPORT_MINT, payTo: key(42).toBase58() } });
    s.market.price = PRICE / 2;
    const next = await s.quoted(1, s.profile, moved);
    expect(next).toMatchObject({ payTo: key(42).toBase58(), units: TOKENS(50_000).toString() });
    // a payment made on the old quote, to the wallet it named, at the amount it named, counts
    s.chain.paid([q.reference], TOKENS(25_000));
    expect(await moved.check(s.profile, q.reference)).toMatchObject({ ok: true, result: { status: "paid" } });
    // and a payment to the old wallet does not pay the new quote
    s.chain.paid([next.reference], TOKENS(50_000));
    expect(await moved.check(s.profile, next.reference)).toEqual({ ok: true, result: { status: "waiting" } });
  });

  it("made before paying in LAMPORT was switched off is still counted; no new payment is built", async () => {
    const s = setup();
    const q = await s.quoted(1);
    s.chain.paid([q.reference], TOKENS(25_000));
    const off = s.made({});
    expect(await off.transaction(s.profile, q.reference, payer.toBase58())).toEqual({ ok: false, status: 409, why: "it cannot be paid in LAMPORT here just now. Ask for the amount again in USDC or SOL." });
    expect(await off.check(s.profile, q.reference)).toMatchObject({ ok: true, result: { status: "paid" } });
  });

  it("that was short for one quote and has since paid for another it also named is not said to be waiting to be sent back", async () => {
    const s = setup();
    const large = await s.quoted(3), small = await s.quoted(1);
    const both = s.chain.paid([large.reference, small.reference], TOKENS(25_000));
    expect(await s.check(large.reference, [both])).toEqual({ status: "short", arrived: TOKENS(25_000).toString(), wanted: TOKENS(75_000).toString() });
    expect((await s.check(small.reference)).status).toBe("paid");
    expect(await s.check(large.reference)).toEqual({ status: "waiting" });
  });

  it("that names two quotes pays one of them", async () => {
    const s = setup();
    const one = await s.quoted(1), two = await s.quoted(1);
    s.chain.paid([one.reference, two.reference], TOKENS(25_000));
    expect((await s.check(one.reference)).status).toBe("paid");
    expect(await s.check(two.reference)).toEqual({ status: "waiting" });
    expect(s.accounts.profile(s.profile)?.prepaid?.payments).toHaveLength(1);
  });
});

describe("looks that overlap", () => {
  it("pay one quote once, however many ask at once", async () => {
    const s = setup();
    const q = await s.quoted(12);
    s.chain.slow = 5;
    s.chain.paid([q.reference], TOKENS(300_000));
    for (let i = 0; i < 3; i++) s.chain.paid([q.reference], 1n);
    const answers = await Promise.all([1, 2, 3, 4].map(() => s.check(q.reference)));
    expect(answers.map((a) => a.status)).toEqual(["paid", "paid", "paid", "paid"]);
    expect(s.accounts.profile(s.profile)?.prepaid?.payments).toHaveLength(1);
    expect(s.months()).toBe(12);
  });

  it("pay one of two quotes that one payment names, though both are looked at at once", async () => {
    const s = setup();
    const a = await s.quoted(12), b = await s.quoted(12);
    s.chain.slow = 5;
    s.chain.paid([a.reference, b.reference], TOKENS(300_000));
    s.chain.paid([a.reference], 1n);
    s.chain.paid([b.reference], 1n);
    await Promise.all([s.check(b.reference), s.check(a.reference), s.check(b.reference), s.check(a.reference)]);
    expect(s.accounts.profile(s.profile)?.prepaid?.payments).toHaveLength(1);
    expect(s.months()).toBe(12);
  });

  it("pay one of five profiles whose quotes one payment names", async () => {
    const s = setup();
    const profiles = [s.profile, s.admit(2), s.admit(3), s.admit(4), s.admit(5)];
    const quotes = await Promise.all(profiles.map((p) => s.quoted(1, p)));
    s.chain.slow = 5;
    s.chain.paid(quotes.map((q) => q.reference), TOKENS(25_000));
    for (const q of quotes.slice(1)) s.chain.paid([q.reference], 1n);
    await Promise.all(quotes.map((q, i) => s.check(q.reference, undefined, profiles[i])));
    expect(profiles.filter((p) => s.accounts.profile(p)?.tier === "pro")).toHaveLength(1);
  });

  it("one profile's looks do not hold up another's, and what cannot be counted is read once and not at every look", async () => {
    const s = setup();
    const other = s.admit(2);
    // twenty-five payments of one unit toward a quote, and twenty looks at it
    const flooded = await s.quoted(1);
    for (let i = 0; i < 25; i++) s.chain.paid([flooded.reference], 1n);
    const theirs = await s.quoted(1, other);
    s.chain.paid([theirs.reference], TOKENS(25_000));
    s.chain.slow = 3;
    const order: string[] = [];
    const flood = Array.from({ length: 20 }, () => s.prepaid.check(s.profile, flooded.reference).then((r) => { order.push("flood"); return r; }));
    const answer = s.check(theirs.reference, undefined, other).then((r) => { order.push("theirs"); return r; });
    expect((await answer).status).toBe("paid");
    const answers = await Promise.all(flood);
    // the other profile's payment was answered while the flood was still being worked through
    expect(order.indexOf("theirs")).toBeLessThan(order.lastIndexOf("flood"));
    // and the twenty looks read each of the twenty-five once
    expect(answers.at(-1)).toEqual({ ok: true, result: { status: "short", arrived: "1", wanted: flooded.units } });
    expect(s.reads()).toBe(25 + 1);
  });
});

describe("a payment that is hard to find", () => {
  it("is not buried by what is sent to the quote's address after it: the list is read from its old end", async () => {
    const s = setup();
    const q = await s.quoted(1);
    s.chain.paid([q.reference], TOKENS(25_000));
    // sixty transactions by anybody that merely name it, each a few lamports' worth of trouble
    for (let i = 0; i < 60; i++) s.chain.dust(q.reference);
    expect((await s.check(q.reference)).status).toBe("paid");
  });

  it("that follows a short one and a pile of small ones is found: the list is read from its new end too, and none of them is read twice", async () => {
    const s = setup();
    const q = await s.quoted(1);
    s.chain.paid([q.reference], 1n);
    for (let i = 0; i < 40; i++) s.chain.paid([q.reference], 1n);
    expect(await s.check(q.reference)).toEqual({ status: "short", arrived: "1", wanted: q.units });
    s.chain.paid([q.reference], TOKENS(25_000));
    expect((await s.check(q.reference)).status).toBe("paid");
  });

  it("is found in the middle of them a few at a time, and at once by its signature; what was read and was nothing is not read again", async () => {
    const s = setup();
    const q = await s.quoted(1);
    for (let i = 0; i < 30; i++) s.chain.dust(q.reference);
    s.chain.paid([q.reference], TOKENS(25_000));
    for (let i = 0; i < 30; i++) s.chain.dust(q.reference);
    // twelve from each end at a look: 24, 24, and the 13 that are left
    expect(await s.check(q.reference)).toEqual({ status: "waiting" });
    expect(s.reads()).toBe(24);
    expect(await s.check(q.reference)).toEqual({ status: "waiting" });
    expect(s.reads()).toBe(48);
    expect((await s.check(q.reference)).status).toBe("paid");
    expect(s.reads()).toBeLessThanOrEqual(61);
    // another quote, buried the same way: named by its signature the payment is read first, whatever else is there
    const t = setup();
    const p = await t.quoted(1);
    for (let i = 0; i < 30; i++) t.chain.dust(p.reference);
    const named = t.chain.paid([p.reference], TOKENS(25_000));
    for (let i = 0; i < 30; i++) t.chain.dust(p.reference);
    expect((await t.check(p.reference, [named])).status).toBe("paid");
    expect(t.reads()).toBe(1);
  });

  it("is found by its signature when the chain's list does not show it at all; a signature for some other quote finds nothing and harms nothing", async () => {
    const s = setup();
    const q = await s.quoted(1), other = await s.quoted(3);
    const hidden = s.chain.paid([q.reference], TOKENS(25_000), { listed: false });
    expect(await s.check(q.reference)).toEqual({ status: "waiting" });
    // given to the wrong quote: nothing, and it is not marked as read for its own
    expect(await s.check(other.reference, [hidden])).toEqual({ status: "waiting" });
    expect(await s.check(q.reference, ["not a signature", hidden])).toMatchObject({ status: "paid" });
  });

  it("named once by its signature is looked for by that from then on: the page says it when the wallet returns, and the tab can close", async () => {
    const s = setup();
    const q = await s.quoted(1);
    const sent = s.chain.paid([q.reference], TOKENS(25_000), { final: false, listed: false });
    // the page's first look, a second after the wallet sent it: not final yet
    expect(await s.check(q.reference, [sent])).toEqual({ status: "waiting" });
    expect(s.accounts.intentOf(s.profile, q.reference)?.sent).toEqual([sent]);
    s.chain.finalize(sent);
    // the chain's list never shows it, and nobody names it again: the service's own look reads it by the signature it was given
    expect(await s.prepaid.sweep()).toEqual({ looked: 1, paid: 1 });
    expect(s.said).toHaveLength(1); // the owner's channels are told
  });

  it("is found by the service itself when nobody is left on the page to ask: for a quote a payment was built for, for three days", async () => {
    const s = setup();
    const q = await s.quoted(1);
    // the page built the payment, the wallet sent it, and the tab was closed before it was final
    expect((await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).ok).toBe(true);
    const sent = s.chain.paid([q.reference], TOKENS(25_000), { final: false });
    expect(await s.prepaid.sweep()).toEqual({ looked: 1, paid: 0 });
    s.chain.finalize(sent);
    expect(await s.prepaid.sweep()).toEqual({ looked: 1, paid: 1 });
    expect(s.accounts.profile(s.profile)?.tier).toBe("pro");
    // paid, it is not looked for again
    expect(await s.prepaid.sweep()).toEqual({ looked: 0, paid: 0 });
    // and an unpaid one is dropped from the service's own look three days after anybody last asked
    const idle = await s.quoted(1);
    await s.check(idle.reference);
    expect((await s.prepaid.sweep()).looked).toBe(1);
    s.later(3 * 86_400 + 1);
    expect(await s.prepaid.sweep()).toEqual({ looked: 0, paid: 0 });
  });

  it("made from a phone on a quote that was only shown, by someone who never came back to the page, is found too: for a day, while there is room", async () => {
    const s = setup();
    const q = await s.quoted(1);
    // nobody built a payment for it on the page or pressed anything: it was paid from a phone, off the payment request
    s.chain.paid([q.reference], TOKENS(25_000));
    expect(await s.prepaid.sweep()).toEqual({ looked: 1, paid: 1 });
    expect(s.accounts.profile(s.profile)?.tier).toBe("pro");
    // a quote that was only shown is looked for for a day and no longer
    const idle = await s.quoted(3);
    expect((await s.prepaid.sweep()).looked).toBe(1);
    s.later(86_400 + 1);
    expect(await s.prepaid.sweep()).toEqual({ looked: 0, paid: 0 });
    s.chain.paid([idle.reference], TOKENS(75_000));
    // (it is still found when somebody asks)
    expect((await s.check(idle.reference)).status).toBe("paid");
  });

  it("the quotes somebody asked about come before the ones that were only shown, when there is not room for all", async () => {
    const s = setup();
    // sixty-three quotes only shown, three each for twenty-one profiles
    for (let n = 2; n <= 22; n++) { const p = s.admit(n); for (const months of [1, 3, 12]) await s.quoted(months, p); }
    // and one that a payment was built for, made before any of them was looked for
    const q = await s.quoted(1);
    expect((await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).ok).toBe(true);
    s.chain.paid([q.reference], TOKENS(25_000));
    expect(await s.prepaid.sweep()).toEqual({ looked: 60, paid: 1 });
  });

  it("the service's own look gets to every quote: the ones looked for longest ago go first, and nobody's asking pushes another's out", async () => {
    const s = setup();
    const q = await s.quoted(1);
    // a payment was built and sent, and the tab closed
    expect((await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).ok).toBe(true);
    s.chain.paid([q.reference], TOKENS(25_000));
    // then twenty-five other profiles ask about three quotes each, later than that
    s.later(60);
    const others: [string, string][] = [];
    for (let n = 2; n <= 26; n++) { const p = s.admit(n); for (const months of [1, 3, 12]) { const o = await s.quoted(months, p); others.push([p, o.reference]); await s.check(o.reference, undefined, p); } }
    // sixty an hour: the first hour does not reach it, the second does, though the others keep asking
    expect(await s.prepaid.sweep()).toEqual({ looked: 60, paid: 0 });
    expect(s.accounts.profile(s.profile)?.tier).toBe("watch");
    for (const [p, reference] of others) await s.check(reference, undefined, p);
    expect((await s.prepaid.sweep()).paid).toBe(1);
    expect(s.accounts.profile(s.profile)?.tier).toBe("pro");
  });
});

describe("a chain that answers badly", () => {
  it("one transaction that cannot be read does not lose the others: the payment beside it is counted", async () => {
    const s = setup();
    const q = await s.quoted(1);
    const real = s.chain.paid([q.reference], TOKENS(25_000));
    s.chain.broken.add(s.chain.dust(q.reference));
    expect((await s.check(q.reference, [real])).status).toBe("paid");
  });

  it("a payment in a newer form of transaction than the RPC was asked for is asked for again in that form, and counted", async () => {
    const s = setup();
    const q = await s.quoted(1);
    s.chain.unsupported.add(s.chain.paid([q.reference], TOKENS(25_000)));
    expect((await s.check(q.reference)).status).toBe("paid");
  });

  it("an answer that cannot be made sense of is not remembered as nothing: it is asked for again, and is not called 'not there yet'", async () => {
    const s = setup();
    const q = await s.quoted(1);
    const sent = s.chain.paid([q.reference], TOKENS(25_000));
    // answered once without what the transaction did
    const whole = s.chain.txs.find((t) => t.signature === sent)!.result;
    s.chain.txs.find((t) => t.signature === sent)!.result = { ...whole, meta: null };
    expect(await s.prepaid.check(s.profile, q.reference)).toEqual({ ok: false, status: 502, why: "the chain could not be read just now. Try again in a minute." });
    s.chain.txs.find((t) => t.signature === sent)!.result = whole;
    expect((await s.check(q.reference)).status).toBe("paid");
  });

  it("the payment's own read failing, with the list answering, is a chain that could not be read and not 'nothing there yet'", async () => {
    const s = setup();
    const q = await s.quoted(1);
    const sent = s.chain.paid([q.reference], TOKENS(25_000));
    s.chain.broken.add(sent);
    expect(await s.prepaid.check(s.profile, q.reference)).toEqual({ ok: false, status: 502, why: "the chain could not be read just now. Try again in a minute." });
    s.chain.broken.clear();
    expect((await s.check(q.reference)).status).toBe("paid");
  });

  it("is said to be a chain that could not be read, and not that nothing is there; a payment named by its signature is found all the same", async () => {
    const s = setup();
    const q = await s.quoted(1);
    const sent = s.chain.paid([q.reference], TOKENS(25_000));
    s.chain.noList = true;
    expect(await s.prepaid.check(s.profile, q.reference)).toEqual({ ok: false, status: 502, why: "the chain could not be read just now. Try again in a minute." });
    expect((await s.check(q.reference, [sent])).status).toBe("paid");
  });

  it("a payment that was credited and then cut short before the plan was started, by a write that failed, starts the plan at the next look", async () => {
    const s = setup();
    const q = await s.quoted(1);
    s.chain.paid([q.reference], TOKENS(25_000));
    // the disk is full at the moment the payment is credited
    const flush = s.store.flush.bind(s.store);
    let fail = true;
    s.store.flush = () => { if (fail) { fail = false; throw new Error("no space left on device"); } flush(); };
    await expect(s.prepaid.check(s.profile, q.reference)).rejects.toThrow("no space");
    expect(s.accounts.profile(s.profile)?.tier).toBe("watch");
    expect((await s.check(q.reference)).status).toBe("paid");
    expect(s.accounts.profile(s.profile)?.tier).toBe("pro");
    expect(s.months()).toBe(1);
    expect(s.said).toHaveLength(1);
  });
});

describe("what somebody is told before they pay in LAMPORT", () => {
  it("says what the dollars pay for, how they became tokens, that the tokens go to Lamport's treasury wallet, how a refund is made, and what becomes of them", () => {
    const terms = lamportTerms(1500, 1);
    expect(terms).toHaveLength(5);
    expect(terms[0]).toBe(prepaidTerms(1500, 1)[0]);
    expect(terms[0]).toContain("$15 pays for one month, once.");
    expect(terms.slice(1)).toEqual([...LAMPORT_TERMS]);
    expect(terms[1]).toContain("the lower of its price now, on which two public sources have to agree, and its price an hour before");
    expect(terms[2]).toContain("to Lamport's treasury wallet");
    expect(terms[3]).toContain("the LAMPORT that was paid is sent back to the wallet that paid");
    expect(terms[4]).toBe("Lamport keeps a part of the LAMPORT it takes in its treasury, locked for the long term, and burns the rest. Lamport does that itself, after the payment; this page does not, and none of it is a promise about what the token is worth.");
    expect(lamportTerms(4500, 3)[0]).toContain("$45 pays for 3 months, once.");
    // a number of tokens is written with its thousands apart
    expect(grouped(286_956_000_000n, 6)).toBe("286,956");
    expect(grouped(1_234_567_000_001n, 6)).toBe("1,234,567.000001");
  });
});
