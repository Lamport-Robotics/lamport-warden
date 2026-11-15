/**
 * Paying for the plan by burning LAMPORT: what is quoted, what the wallet is handed to sign, and what counts
 * as paid. Nothing is sent to anybody, so nothing can be counted by what arrived; it is counted by how much
 * less of the token there is after the transaction than before. The chain is stood in for by a list of
 * transactions with the balances they left.
 */
import "../../../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { LAMPORT_MINT, configFrom } from "../src/main.js";
import { Accounts } from "../src/accounts.js";
import { burnTerms, grouped } from "../src/plans.js";
import { wholeTokens } from "../../../src/sentinel.js";
import { Prepaid, USDC_QUOTE_SECONDS, burned, tokenAccountOf } from "../src/prepaid.js";
import { fromRpc } from "../src/observed.js";
import type { Rpc } from "../src/rpc.js";
import { judge } from "../../../src/judge.js";
import { ARMING_ORIGIN } from "../../../src/defaults.js";
import { MemoryStore } from "../src/store.js";

const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const PAY_TO = key(40).toBase58(), A = key(1).toBase58();
const payer = key(60);
const T0 = 1_794_312_000;
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"), MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const MINT = new PublicKey(LAMPORT_MINT);
const TOKENS = (n: number) => BigInt(n) * 1_000_000n; // six decimals, as the token has

class Chain implements Rpc {
  txs: { signature: string; names: string[]; failed: boolean; result: any }[] = [];
  holds: Record<string, bigint> = {};
  asked: string[] = [];
  mintAnswers: any = { value: { owner: TOKEN_2022.toBase58(), data: { parsed: { info: { decimals: 6 } } } } };
  private n = 0;

  /** A transaction that names `references` and leaves these balances of a token: [account's owner, before, after] for each account it touched. */
  did(o: { references: string[]; balances: [string, bigint, bigint][]; mint?: string; failed?: boolean }): string {
    const accounts = o.balances.map(() => Keypair.generate().publicKey);
    const keys = [{ pubkey: payer, isSigner: true, isWritable: true }, ...accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })), ...o.references.map((r) => ({ pubkey: new PublicKey(r), isSigner: false, isWritable: false }))];
    const tx = new Transaction({ feePayer: payer, recentBlockhash: "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x" }).add(new TransactionInstruction({ programId: MEMO, keys, data: Buffer.from("x") }));
    const names = tx.compileMessage().accountKeys.map((k) => k.toBase58());
    const lamports = names.map(() => 1_000_000_000);
    const side = (which: 1 | 2) => o.balances.map((b, i) => ({ accountIndex: names.indexOf(accounts[i]!.toBase58()), mint: o.mint ?? LAMPORT_MINT, owner: b[0], uiTokenAmount: { amount: (o.failed ? b[1] : b[which]).toString(), decimals: 6 } }));
    const signature = `burn${String(++this.n).padStart(4, "0")}`;
    this.txs.push({ signature, names, failed: !!o.failed, result: { slot: 1000 + this.n, blockTime: T0, transaction: [Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64"), "base64"], meta: { err: o.failed ? { InstructionError: [0, "Custom"] } : null, fee: 5000, preBalances: lamports, postBalances: lamports, preTokenBalances: side(1), postTokenBalances: side(2) } } });
    return signature;
  }

  async call(method: string, params: any[]): Promise<any> {
    this.asked.push(method);
    if (method === "getSignaturesForAddress") return this.txs.filter((t) => t.names.includes(params[0])).reverse().map((t) => ({ signature: t.signature, err: t.failed ? {} : null }));
    if (method === "getTransaction") return this.txs.find((t) => t.signature === params[0])?.result ?? null;
    if (method === "getAccountInfo") return this.mintAnswers;
    if (method === "getTokenAccountBalance") { if (!(params[0] in this.holds)) throw new Error("could not find account"); return { value: { amount: String(this.holds[params[0]]) } }; }
    if (method === "getLatestBlockhash") return { value: { blockhash: "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x" } };
    throw new Error(`unexpected ${method}`);
  }
}

function setup(o: { perMonth?: number | null; holder?: () => Promise<boolean> } = {}) {
  const accounts = new Accounts(new MemoryStore(), Buffer.alloc(32, 9));
  const chain = new Chain();
  const said: string[] = [];
  const now = T0;
  const prepaid = new Prepaid({ payTo: PAY_TO, ...(o.perMonth === null ? {} : { burn: { mint: LAMPORT_MINT, perMonth: o.perMonth ?? 25_000 } }) }, accounts, chain,
    { sells: () => true, holder: o.holder ?? (async () => false), byCard: () => false, centsFull: 1500, centsHolder: 1000 },
    { now: () => now, notice: async (_p, sentence) => { said.push(sentence); } });
  const admitted = accounts.admit(A, null, T0);
  if (!admitted.ok) throw new Error("setup");
  const profile = admitted.profile;
  const quoted = async (months = 1) => { const r = await prepaid.quote(profile, "LAMPORT", months); if (!r.ok) throw new Error(r.why); return r.quote; };
  const check = async (reference: string) => { const r = await prepaid.check(profile, reference); if (!r.ok) throw new Error(r.why); return r.result; };
  return { accounts, chain, prepaid, said, profile, quoted, check };
}

describe("paying by burning, when it is not turned on", () => {
  it("is not offered and not quoted", async () => {
    const s = setup({ perMonth: null });
    expect(s.prepaid.offer()).toEqual({ payTo: PAY_TO, assets: ["USDC"], months: [1, 3, 12] });
    expect(await s.prepaid.quote(s.profile, "LAMPORT", 1)).toEqual({ ok: false, status: 400, why: "it can be paid in USDC or SOL." });
  });

  it("is a setting: a whole number of tokens for a month, beside the address the other payments go to", () => {
    const base = { SENTINEL_RPC_URL: "https://rpc.example", SENTINEL_DATA_KEY: Buffer.alloc(32, 1).toString("base64"), SENTINEL_STRIPE_SECRET_KEY: "sk_test_x", SENTINEL_STRIPE_WEBHOOK_SECRET: "whsec_x", SENTINEL_STRIPE_PRICE_FULL: "price_1", SENTINEL_STRIPE_PRICE_HOLDER: "price_2", SENTINEL_PAY_TO: PAY_TO };
    const on = configFrom({ ...base, SENTINEL_BURN_PER_MONTH: "25000" });
    expect(on.ok && on.config.burnPerMonth).toBe(25_000);
    expect(on.ok && on.config.burnMint).toBe(LAMPORT_MINT);
    const off = configFrom(base);
    expect(off.ok && off.config.burnPerMonth).toBeNull();
    for (const bad of ["0", "-5", "2.5", "many"]) expect(configFrom({ ...base, SENTINEL_BURN_PER_MONTH: bad })).toEqual({ ok: false, why: "SENTINEL_BURN_PER_MONTH has to be a whole number of tokens, more than none." });
    const { SENTINEL_PAY_TO: _gone, ...alone } = base;
    expect(configFrom({ ...alone, SENTINEL_BURN_PER_MONTH: "25000" })).toEqual({ ok: false, why: "SENTINEL_BURN_PER_MONTH needs SENTINEL_PAY_TO beside it: paying by burning is one of the ways of paying ahead." });
  });
});

describe("an amount to burn", () => {
  it("is the tokens for a month times the months, in the token's own units, with nobody to send it to", async () => {
    const s = setup();
    expect(s.prepaid.offer()).toEqual({ payTo: PAY_TO, assets: ["USDC", "LAMPORT"], months: [1, 3, 12], burn: { perMonth: 25_000 } });
    const q = await s.quoted(3);
    expect(q).toMatchObject({ asset: "LAMPORT", units: TOKENS(75_000).toString(), decimals: 6, mint: LAMPORT_MINT, months: 3, cents: 0, payTo: "", url: "", burned: true, expiresAt: T0 + USDC_QUOTE_SECONDS });
    // the reference is an address nobody holds, as for any other quote
    expect(() => new PublicKey(q.reference)).not.toThrow();
    // the token's decimals and its program are read from the chain, once
    await s.quoted(1);
    expect(s.chain.asked.filter((m) => m === "getAccountInfo")).toHaveLength(1);
  });

  it("is the same for everybody: it is not a price in dollars, so no wallet's balance is read to find a lower one", async () => {
    const s = setup({ holder: async () => { throw new Error("the RPC is down"); } });
    expect((await s.quoted(1)).units).toBe(TOKENS(25_000).toString());
  });

  it("is not quoted when the token cannot be read from the chain, or is not a token", async () => {
    const s = setup();
    s.chain.mintAnswers = { value: null };
    expect(await s.prepaid.quote(s.profile, "LAMPORT", 1)).toEqual({ ok: false, status: 502, why: "the chain could not be read just now. Try again in a minute." });
    s.chain.mintAnswers = { value: { owner: "11111111111111111111111111111111", data: ["", "base64"] } };
    expect(await s.prepaid.quote(s.profile, "LAMPORT", 1)).toMatchObject({ ok: false, status: 502 });
  });

  it("is not quoted for a token that keeps a fee on transfers: a transfer of one would look like a small burn", async () => {
    const s = setup();
    s.chain.mintAnswers = { value: { owner: TOKEN_2022.toBase58(), data: { parsed: { info: { decimals: 6, extensions: [{ extension: "transferFeeConfig", state: {} }] } } } } };
    expect(await s.prepaid.quote(s.profile, "LAMPORT", 1)).toMatchObject({ ok: false, status: 502 });
    // and the token as it is, with its name and picture and nothing else, is
    s.chain.mintAnswers = { value: { owner: TOKEN_2022.toBase58(), data: { parsed: { info: { decimals: 6, extensions: [{ extension: "metadataPointer", state: {} }, { extension: "tokenMetadata", state: {} }] } } } } };
    expect((await s.quoted(1)).units).toBe(TOKENS(25_000).toString());
  });
});

describe("the burn handed to a wallet", () => {
  it("is one instruction that burns exactly the quoted amount from the payer's own account, naming the quote, and nothing else", async () => {
    const s = setup();
    const q = await s.quoted(1);
    const theirs = tokenAccountOf(payer, MINT, TOKEN_2022);
    s.chain.holds[theirs.toBase58()] = TOKENS(300_000);
    const made = await s.prepaid.transaction(s.profile, q.reference, payer.toBase58());
    if (!made.ok) throw new Error(made.why);
    const tx = Transaction.from(Buffer.from(made.transaction, "base64"));
    expect(tx.feePayer!.toBase58()).toBe(payer.toBase58());
    expect(tx.instructions).toHaveLength(1);
    const ix = tx.instructions[0]!;
    // under the program the token is under, which for LAMPORT is Token-2022
    expect(ix.programId.toBase58()).toBe(TOKEN_2022.toBase58());
    // BurnChecked, 25,000 tokens, six decimals: the account, the token, its owner, and the quote's reference. No destination: there is none.
    expect([...ix.data]).toEqual([15, ...new Uint8Array(new BigUint64Array([TOKENS(25_000)]).buffer), 6]);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([[theirs.toBase58(), false, true], [LAMPORT_MINT, false, true], [payer.toBase58(), true, true], [q.reference, false, false]]);
    // Lamport's address is nowhere in it
    expect(tx.compileMessage().accountKeys.map((k) => k.toBase58())).not.toContain(PAY_TO);
  });

  it("is read by Warden, in front of the wallet, as a burn of that many whole tokens", async () => {
    const s = setup();
    const q = await s.quoted(3);
    s.chain.holds[tokenAccountOf(payer, MINT, TOKEN_2022).toBase58()] = TOKENS(300_000);
    const made = await s.prepaid.transaction(s.profile, q.reference, payer.toBase58());
    if (!made.ok) throw new Error(made.why);
    const store = { load: async () => undefined, save: async () => undefined, ringSites: async () => [] };
    const { verdict } = await judge({ kind: "tx", bytes: Buffer.from(made.transaction, "base64"), owner: payer.toBase58() }, ARMING_ORIGIN, store);
    expect(verdict.level).toBe("explain");
    expect(verdict.sentence).toBe("Burns 75,000 LAMPORT from this wallet. That is how the Sentinel page takes payment in LAMPORT. The tokens are destroyed: nobody receives them, and nobody can bring them back.");
  });

  it("is not made for a wallet that does not hold the amount", async () => {
    const s = setup();
    const q = await s.quoted(1);
    expect(await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).toEqual({ ok: false, status: 409, why: "that wallet holds 0 LAMPORT, and this burns 25,000." });
    s.chain.holds[tokenAccountOf(payer, MINT, TOKEN_2022).toBase58()] = TOKENS(24_999);
    expect(await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).toEqual({ ok: false, status: 409, why: "that wallet holds 24,999 LAMPORT, and this burns 25,000." });
  });
});

describe("a burn", () => {
  it("is counted when the chain shows that much less of the token after a transaction that names the quote", async () => {
    const s = setup();
    const q = await s.quoted(1);
    expect(await s.check(q.reference)).toEqual({ status: "waiting" });
    const signature = s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]] });
    const paid = await s.check(q.reference);
    expect(paid.status).toBe("paid");
    expect(s.accounts.profile(s.profile)?.tier).toBe("pro");
    expect(s.accounts.profile(s.profile)?.prepaid?.payments).toEqual([{ signature, asset: "LAMPORT", units: TOKENS(25_000).toString(), months: 1, cents: 0, at: T0 }]);
    expect(s.said).toHaveLength(1);
    // asked again, it is paid, and not counted twice
    expect((await s.check(q.reference)).status).toBe("paid");
    expect(s.accounts.profile(s.profile)?.prepaid?.payments).toHaveLength(1);
  });

  it("is a burn and nothing else: tokens sent to somebody, a failed transaction, another token, or a transaction that does not name the quote are nothing", async () => {
    const s = setup();
    const q = await s.quoted(1);
    // sent to somebody else: there is exactly as much of the token after as before
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)], [key(77).toBase58(), 0n, TOKENS(25_000)]] });
    // failed
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]], failed: true });
    // another token burned
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]], mint: key(78).toBase58() });
    // the right burn, naming some other quote
    s.chain.did({ references: [key(79).toBase58()], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]] });
    expect(await s.check(q.reference)).toEqual({ status: "waiting" });
    expect(s.accounts.profile(s.profile)?.tier).toBe("watch");
  });

  it("that is short is said to be short, and is not lost: burns that name the same quote add up, since none of it can be sent back", async () => {
    const s = setup();
    const q = await s.quoted(1);
    const first = s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(290_000)]] });
    expect(await s.check(q.reference)).toEqual({ status: "short", arrived: TOKENS(10_000).toString(), wanted: TOKENS(25_000).toString() });
    expect(s.accounts.profile(s.profile)?.tier).toBe("watch");
    const second = s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(290_000), TOKENS(280_000)]] });
    expect(await s.check(q.reference)).toEqual({ status: "short", arrived: TOKENS(20_000).toString(), wanted: TOKENS(25_000).toString() });
    const third = s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(280_000), TOKENS(275_000)]] });
    expect((await s.check(q.reference)).status).toBe("paid");
    expect(s.accounts.profile(s.profile)?.prepaid?.payments).toEqual([{ signature: third, asset: "LAMPORT", units: TOKENS(25_000).toString(), months: 1, cents: 0, at: T0 }]);
    // every one of them is spent: none can pay for anything else
    for (const sig of [first, second, third]) expect(s.accounts.credited(sig)).toBe(true);
  });

  it("that names two quotes is counted toward one of them", async () => {
    const s = setup();
    const one = await s.quoted(1), two = await s.quoted(1);
    s.chain.did({ references: [one.reference, two.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]] });
    expect((await s.check(one.reference)).status).toBe("paid");
    expect(await s.check(two.reference)).toEqual({ status: "waiting" });
    expect(s.accounts.profile(s.profile)?.prepaid?.payments).toHaveLength(1);
  });

  it("is read from what the balances did", () => {
    const s = setup();
    const sig = s.chain.did({ references: [key(5).toBase58()], balances: [[payer.toBase58(), 100n, 40n], [key(6).toBase58(), 7n, 17n]] });
    const tx = fromRpc(sig, s.chain.txs[0]!.result)!;
    expect(burned(tx, LAMPORT_MINT)).toBe(50n); // sixty left one account, ten arrived in another
    expect(burned(tx, key(9).toBase58())).toBe(0n);
  });
});

describe("what somebody is told before they burn", () => {
  it("says the tokens are destroyed, go to nobody, and cannot be given back", () => {
    const terms = burnTerms("25,000", 1);
    expect(terms).toHaveLength(3);
    expect(terms[0]).toBe("25,000 LAMPORT pays for one month, once. Nothing is charged again and nothing renews: when the time is up your profile goes back to Watch, and nothing is deleted. Your alert channels are told three days before.");
    expect(terms[1]).toContain("The tokens are destroyed: they go to nobody, Lamport included");
    expect(terms[2]).toContain("Burned tokens cannot be brought back by anybody, so they are not refunded.");
    expect(burnTerms("75,000", 3)[0]).toContain("75,000 LAMPORT pays for 3 months, once.");
    // a number of tokens is written the way Warden writes it in front of the wallet
    expect(grouped(25_000_000_000n, 6)).toBe(wholeTokens(25_000_000_000n, 6));
    expect(grouped(1_234_567_000_001n, 6)).toBe("1,234,567.000001");
    expect(grouped(999n, 6)).toBe("0.000999");
  });
});
