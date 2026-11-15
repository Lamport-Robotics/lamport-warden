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
import { Prepaid, USDC_QUOTE_SECONDS, burned, signersOf, tokenAccountOf } from "../src/prepaid.js";
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
  txs: { signature: string; names: string[]; failed: boolean; final: boolean; listed: boolean; result: any }[] = [];
  holds: Record<string, bigint> = {};
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
  /** The chain makes a transaction final. */
  finalize(signature: string): void { this.txs.find((t) => t.signature === signature)!.final = true; }

  async call(method: string, params: any[]): Promise<any> {
    this.asked.push(method);
    const seen = (t: { final: boolean }, commitment: unknown) => commitment !== "finalized" || t.final;
    if (method === "getSignaturesForAddress" && this.noList) throw new Error("timed out");
    if (method === "getTransaction" && this.broken.has(params[0])) throw new Error("timed out");
    if (method === "getTransaction" && this.unsupported.has(params[0])) throw new Error("Transaction version (1) is not supported by the requesting client. Please try the request again with the following configuration parameter: \"maxSupportedTransactionVersion\": 1");
    if (method === "getSignaturesForAddress") return this.txs.filter((t) => t.listed && t.names.includes(params[0]) && seen(t, params[1]?.commitment)).reverse().slice(0, params[1]?.limit ?? 1000).map((t) => ({ signature: t.signature, err: t.failed ? {} : null }));
    if (method === "getTransaction") { if (this.slow) await new Promise((r) => setTimeout(r, this.slow)); return this.txs.find((t) => t.signature === params[0] && seen(t, params[1]?.commitment))?.result ?? null; }
    if (method === "getAccountInfo") return this.mintAnswers;
    if (method === "getTokenAccountBalance") { if (this.down) throw new Error("timed out"); if (!(params[0] in this.holds)) throw new Error("Invalid param: could not find account"); return { value: { amount: String(this.holds[params[0]]) } }; }
    if (method === "getLatestBlockhash") return { value: { blockhash: "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x" } };
    throw new Error(`unexpected ${method}`);
  }
}
const bs58 = (bytes: Uint8Array): string => new PublicKey(bytes.subarray(0, 32)).toBase58().padEnd(44, "1") + new PublicKey(bytes.subarray(32, 64)).toBase58().padEnd(44, "1");

function setup(o: { perMonth?: number | null; holder?: () => Promise<boolean> } = {}) {
  const store = new MemoryStore();
  const accounts = new Accounts(store, Buffer.alloc(32, 9));
  const chain = new Chain();
  const said: string[] = [];
  let now = T0;
  const selling = { sells: () => true, holder: o.holder ?? (async () => false), byCard: () => false, centsFull: 1500, centsHolder: 1000 };
  const made = (cfg: { burn?: { mint: string; perMonth: number } }) => new Prepaid({ payTo: PAY_TO, ...cfg }, accounts, chain, selling, { now: () => now, notice: async (_p, sentence) => { said.push(sentence); } });
  const prepaid = made(o.perMonth === null ? {} : { burn: { mint: LAMPORT_MINT, perMonth: o.perMonth ?? 25_000 } });
  const admit = (n: number) => { const r = accounts.admit(key(n).toBase58(), null, T0); if (!r.ok) throw new Error("setup"); return r.profile; };
  const profile = admit(1);
  const quoted = async (months = 1, of = profile) => { const r = await prepaid.quote(of, "LAMPORT", months); if (!r.ok) throw new Error(r.why); return r.quote; };
  const check = async (reference: string, signatures?: string[], of = profile) => { const r = await prepaid.check(of, reference, signatures); if (!r.ok) throw new Error(r.why); return r.result; };
  const months = (of = profile) => (accounts.profile(of)?.prepaid?.payments ?? []).reduce((sum, p) => sum + p.months, 0);
  const reads = () => chain.asked.filter((m) => m === "getTransaction").length;
  return { store, accounts, chain, prepaid, said, profile, quoted, check, admit, made, months, reads, later: (seconds: number) => { now += seconds; } };
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

  it("is the same quote again while it stands and is not paid, so a page opened again has the reference it had", async () => {
    const s = setup();
    const first = await s.quoted(1);
    expect((await s.quoted(1)).reference).toBe(first.reference);
    // another number of months is another quote
    expect((await s.quoted(3)).reference).not.toBe(first.reference);
    // paid, it is finished: the next one is new
    s.chain.did({ references: [first.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]] });
    expect((await s.check(first.reference)).status).toBe("paid");
    expect((await s.quoted(1)).reference).not.toBe(first.reference);
  });

  it("is not forgotten for being one of many: twenty-five quotes later it is still there to be looked for", async () => {
    const s = setup();
    const q = await s.quoted(1);
    for (let i = 0; i < 25; i++) { const r = await s.prepaid.quote(s.profile, "USDC", 1); if (!r.ok) throw new Error(r.why); }
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]] });
    expect((await s.check(q.reference)).status).toBe("paid");
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

  it("is not quoted for a token with more to it than a name and a picture: a fee kept on transfers, or balances kept out of sight, would look like a burn", async () => {
    for (const extension of ["transferFeeConfig", "confidentialTransferMint", "transferHook", "somethingNew"]) {
      const s = setup();
      s.chain.mintAnswers = { value: { owner: TOKEN_2022.toBase58(), data: { parsed: { info: { decimals: 6, extensions: [{ extension: "tokenMetadata", state: {} }, { extension, state: {} }] } } } } };
      expect(await s.prepaid.quote(s.profile, "LAMPORT", 1), extension).toMatchObject({ ok: false, status: 502 });
    }
    const s = setup();
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

  it("is not made for a wallet that does not hold the amount, and a chain that does not answer is not taken for an empty wallet", async () => {
    const s = setup();
    const q = await s.quoted(1);
    expect(await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).toEqual({ ok: false, status: 409, why: "that wallet's own LAMPORT account holds 0, and this burns 25,000." });
    s.chain.holds[tokenAccountOf(payer, MINT, TOKEN_2022).toBase58()] = TOKENS(24_999);
    expect(await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).toEqual({ ok: false, status: 409, why: "that wallet's own LAMPORT account holds 24,999, and this burns 25,000." });
    s.chain.down = true;
    expect(await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).toEqual({ ok: false, status: 502, why: "the chain could not be read just now. Try again in a minute." });
  });

  const amountOf = (transaction: string) => Transaction.from(Buffer.from(transaction, "base64")).instructions[0]!.data.readBigUInt64LE(1);

  it("is only for what is still owed: what was counted toward the quote is not burned again", async () => {
    const s = setup();
    const q = await s.quoted(1);
    s.chain.holds[tokenAccountOf(payer, MINT, TOKEN_2022).toBase58()] = TOKENS(300_000);
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(290_000)]] });
    expect(await s.check(q.reference)).toEqual({ status: "short", arrived: TOKENS(10_000).toString(), wanted: TOKENS(25_000).toString() });
    const rest = await s.prepaid.transaction(s.profile, q.reference, payer.toBase58());
    if (!rest.ok) throw new Error(rest.why);
    expect(amountOf(rest.transaction)).toBe(TOKENS(15_000));
    // and the quote, asked for again, says how much of it is burned already
    expect((await s.quoted(1)).counted).toBe(TOKENS(10_000).toString());
  });

  it("is not made a second time while the first is on the chain and not yet final", async () => {
    const s = setup();
    const q = await s.quoted(1);
    s.chain.holds[tokenAccountOf(payer, MINT, TOKEN_2022).toBase58()] = TOKENS(300_000);
    const sent = s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]], final: false });
    expect(await s.check(q.reference)).toEqual({ status: "waiting" });
    expect(await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).toEqual({ ok: false, status: 409, why: "the burn for this has been sent already. It counts once the chain has made it final: look for it in a minute." });
    s.chain.finalize(sent);
    expect((await s.check(q.reference)).status).toBe("paid");
    expect(await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).toEqual({ ok: false, status: 409, why: "that amount has been paid." });
  });
});

describe("a burn", () => {
  it("is counted when the chain shows that much less of the signer's own tokens after a transaction that names the quote", async () => {
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

  it("has to be of the signer's own tokens: what anyone may burn, or a delegate burned of somebody else's, pays for nothing", async () => {
    const s = setup();
    const q = await s.quoted(1);
    const INCINERATOR = "1nc1nerator11111111111111111111111111111111", SYSTEM = "11111111111111111111111111111111", victim = key(81).toBase58();
    // tokens left in an account the token program lets anyone burn from
    s.chain.did({ references: [q.reference], balances: [[INCINERATOR, TOKENS(25_000), 0n]] });
    s.chain.did({ references: [q.reference], balances: [[SYSTEM, TOKENS(25_000), 0n]] });
    // somebody else's tokens, burned by a wallet that was let spend them
    s.chain.did({ references: [q.reference], balances: [[victim, TOKENS(300_000), TOKENS(275_000)]] });
    // the signer's own tokens moved to another wallet of theirs, beside a burn of what was nobody's: the signer lost nothing
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)], [key(82).toBase58(), 0n, TOKENS(25_000)], [INCINERATOR, TOKENS(25_000), 0n]] });
    expect(await s.check(q.reference)).toEqual({ status: "waiting" });
    expect(s.accounts.profile(s.profile)?.tier).toBe("watch");
    // counted exactly: the signer's own burn, less what the signer was sent in the same transaction
    const sig = s.chain.did({ references: [key(5).toBase58()], balances: [[payer.toBase58(), 100n, 40n], [key(6).toBase58(), 7n, 17n], [victim, 50n, 0n]] });
    const tx = fromRpc(sig, s.chain.txs.at(-1)!.result)!;
    expect(signersOf(tx)).toEqual([payer.toBase58()]);
    expect(burned(tx, LAMPORT_MINT)).toBe(50n); // sixty left the signer's account, ten arrived in another; the fifty of somebody else's are not the signer's
    expect(burned(tx, key(9).toBase58())).toBe(0n);
  });

  it("that is short is said to be short, and is not lost: burns that name the same quote add up, since none of it can be sent back", async () => {
    const s = setup();
    const q = await s.quoted(1);
    const first = s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(290_000)]] });
    expect(await s.check(q.reference)).toEqual({ status: "short", arrived: TOKENS(10_000).toString(), wanted: TOKENS(25_000).toString() });
    expect(s.accounts.profile(s.profile)?.tier).toBe("watch");
    // counted, it is spent: it can count toward nothing else from that moment
    expect(s.accounts.credited(first)).toBe(true);
    const second = s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(290_000), TOKENS(280_000)]] });
    expect(await s.check(q.reference)).toEqual({ status: "short", arrived: TOKENS(20_000).toString(), wanted: TOKENS(25_000).toString() });
    const third = s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(280_000), TOKENS(275_000)]] });
    expect((await s.check(q.reference)).status).toBe("paid");
    expect(s.accounts.profile(s.profile)?.prepaid?.payments).toEqual([{ signature: third, asset: "LAMPORT", units: TOKENS(25_000).toString(), months: 1, cents: 0, at: T0 }]);
    for (const sig of [first, second, third]) expect(s.accounts.credited(sig)).toBe(true);
  });

  it("over the amount is not lost either: it stays counted, and a second burn made by mistake pays for the months again", async () => {
    const s = setup();
    const q = await s.quoted(1);
    // 10,000 and then the whole 25,000 again: one month, and 10,000 still counted
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(290_000)]] });
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(290_000), TOKENS(265_000)]] });
    expect((await s.check(q.reference)).status).toBe("paid");
    expect(s.months()).toBe(1);
    expect(s.accounts.profile(s.profile)?.prepaid?.payments[0]?.units).toBe(TOKENS(25_000).toString());
    expect(s.accounts.intentOf(s.profile, q.reference)?.counted).toBe(TOKENS(10_000).toString());
    // 15,000 more for the same quote, found by the service's own look: a second month
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(265_000), TOKENS(250_000)]] });
    expect(await s.prepaid.sweep()).toEqual({ looked: 1, paid: 1 });
    expect(s.months()).toBe(2);
    expect(s.accounts.intentOf(s.profile, q.reference)?.counted).toBe("0");
    // and two whole burns for one quote, found together, are two months: nothing burned is dropped
    const t = setup();
    const twice = await t.quoted(1);
    t.chain.did({ references: [twice.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]] });
    t.chain.did({ references: [twice.reference], balances: [[payer.toBase58(), TOKENS(275_000), TOKENS(250_000)]] });
    expect((await t.check(twice.reference)).status).toBe("paid");
    expect(t.months()).toBe(2);
  });

  it("that names two quotes is counted toward one of them", async () => {
    const s = setup();
    const one = await s.quoted(1), two = await s.quoted(3);
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

describe("looks that overlap", () => {
  // Each of these paid several times over before there was one look at a time: the same burn found unspent by
  // two looks, and counted by both.
  it("pay one quote once, however many ask at once", async () => {
    const s = setup();
    const q = await s.quoted(12);
    s.chain.slow = 5;
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(400_000), TOKENS(100_000)]] });
    for (let i = 0; i < 3; i++) s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), 10n, 9n]] });
    const answers = await Promise.all([1, 2, 3, 4].map(() => s.check(q.reference)));
    expect(answers.map((a) => a.status)).toEqual(["paid", "paid", "paid", "paid"]);
    expect(s.accounts.profile(s.profile)?.prepaid?.payments).toHaveLength(1);
    expect(s.months()).toBe(12);
  });

  it("pay one of two quotes that one burn names", async () => {
    const s = setup();
    const a = await s.quoted(12), b = await s.quoted(3);
    s.chain.slow = 5;
    s.chain.did({ references: [a.reference, b.reference], balances: [[payer.toBase58(), TOKENS(400_000), TOKENS(100_000)]] });
    s.chain.did({ references: [a.reference], balances: [[payer.toBase58(), 10n, 9n]] });
    s.chain.did({ references: [b.reference], balances: [[payer.toBase58(), 9n, 8n]] });
    await Promise.all([s.check(b.reference), s.check(a.reference), s.check(b.reference), s.check(a.reference)]);
    // 300,000 burned, once, is twelve months at 25,000 a month whichever quote it was counted toward (the
    // twelve months once, or the three months four times), and never the two together
    expect(s.months()).toBe(12);
    const counted = [a, b].map((q) => BigInt(s.accounts.intentOf(s.profile, q.reference)?.counted ?? "0"));
    expect(counted[0]! + counted[1]!).toBeLessThan(10n); // only the two dust burns are left over
  });

  it("pay one of five profiles whose quotes one burn names", async () => {
    const s = setup();
    const profiles = [s.profile, s.admit(2), s.admit(3), s.admit(4), s.admit(5)];
    const quotes = await Promise.all(profiles.map((p) => s.quoted(1, p)));
    s.chain.slow = 5;
    s.chain.did({ references: quotes.map((q) => q.reference), balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]] });
    for (const q of quotes.slice(1)) s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), 10n, 9n]] });
    await Promise.all(quotes.map((q, i) => s.check(q.reference, undefined, profiles[i])));
    expect(profiles.filter((p) => s.accounts.profile(p)?.tier === "pro")).toHaveLength(1);
  });
});

describe("a burn that is hard to find", () => {
  it("is not buried by what is sent to the quote's address after it: the list is read from its old end", async () => {
    const s = setup();
    const q = await s.quoted(1);
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]] });
    // sixty transactions by anybody that merely name it, each a few lamports' worth of trouble
    for (let i = 0; i < 60; i++) s.chain.did({ references: [q.reference], balances: [] });
    expect((await s.check(q.reference)).status).toBe("paid");
  });

  it("is found when it came after them: the list is read from its new end too, since the latest payment may be what completes an earlier one", async () => {
    const s = setup();
    const q = await s.quoted(1);
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(290_000)]] });
    for (let i = 0; i < 60; i++) s.chain.did({ references: [q.reference], balances: [] });
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(290_000), TOKENS(275_000)]] });
    expect((await s.check(q.reference)).status).toBe("paid");
  });

  it("is found in the middle of them a few at a time, and at once by its signature; what was read and was nothing is not read again", async () => {
    const s = setup();
    const q = await s.quoted(1);
    for (let i = 0; i < 30; i++) s.chain.did({ references: [q.reference], balances: [] });
    const real = s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]] });
    for (let i = 0; i < 30; i++) s.chain.did({ references: [q.reference], balances: [] });
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
    for (let i = 0; i < 30; i++) t.chain.did({ references: [p.reference], balances: [] });
    const named = t.chain.did({ references: [p.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]] });
    for (let i = 0; i < 30; i++) t.chain.did({ references: [p.reference], balances: [] });
    expect((await t.check(p.reference, [named])).status).toBe("paid");
    expect(real).not.toBe("");
  });

  it("named once by its signature is looked for by that from then on: the page says it when the wallet returns, and the tab can close", async () => {
    const s = setup();
    const q = await s.quoted(1);
    const sent = s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]], final: false, listed: false });
    // the page's first look, a second after the wallet sent it: not final yet
    expect(await s.check(q.reference, [sent])).toEqual({ status: "waiting" });
    expect(s.accounts.intentOf(s.profile, q.reference)?.sent).toEqual([sent]);
    s.chain.finalize(sent);
    // the chain's list never shows it, and nobody names it again: the service's own look reads it by the signature it was given
    expect(await s.prepaid.sweep()).toEqual({ looked: 1, paid: 1 });
  });

  it("is found by its signature when the chain's list does not show it at all; a signature for some other quote finds nothing and harms nothing", async () => {
    const s = setup();
    const q = await s.quoted(1), other = await s.quoted(3);
    const hidden = s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]], listed: false });
    expect(await s.check(q.reference)).toEqual({ status: "waiting" });
    // given to the wrong quote: nothing, and it is not marked as read for its own
    expect(await s.check(other.reference, [hidden])).toEqual({ status: "waiting" });
    expect(await s.check(q.reference, ["not a signature", hidden])).toMatchObject({ status: "paid" });
  });

  it("is found by the service itself when nobody is left on the page to ask: within the hour, for a quote a payment was built for", async () => {
    const s = setup();
    const q = await s.quoted(1), idle = await s.quoted(3);
    s.chain.holds[tokenAccountOf(payer, MINT, TOKEN_2022).toBase58()] = TOKENS(300_000);
    // a quote nobody built a payment for or asked about is not looked for
    expect(idle.reference).not.toBe(q.reference);
    expect(await s.prepaid.sweep()).toEqual({ looked: 0, paid: 0 });
    // the page built the burn, the wallet sent it, and the tab was closed before it was final
    expect((await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).ok).toBe(true);
    const sent = s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]], final: false });
    expect(await s.prepaid.sweep()).toEqual({ looked: 1, paid: 0 });
    s.chain.finalize(sent);
    expect(await s.prepaid.sweep()).toEqual({ looked: 1, paid: 1 });
    expect(s.accounts.profile(s.profile)?.tier).toBe("pro");
    expect(s.said).toHaveLength(1); // the owner's channels are told
    // three days after anybody last asked, the service stops looking by itself
    s.later(3 * 86_400 + 1);
    expect(await s.prepaid.sweep()).toEqual({ looked: 0, paid: 0 });
  });

  it("after paying by burning was switched off is not said to be on its way: its owner is told whom to write to", async () => {
    const s = setup();
    const q = await s.quoted(1);
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]] });
    const why = "paying in LAMPORT is switched off here just now. Anything already burned for this is not lost: write to support@lamportrobotics.com.";
    // switched off, or pointed at another token: the same store, another setting
    expect(await s.made({}).check(s.profile, q.reference)).toEqual({ ok: false, status: 409, why });
    expect(await s.made({ burn: { mint: key(90).toBase58(), perMonth: 25_000 } }).check(s.profile, q.reference)).toEqual({ ok: false, status: 409, why });
    expect(await s.made({ burn: { mint: key(90).toBase58(), perMonth: 25_000 } }).transaction(s.profile, q.reference, payer.toBase58())).toEqual({ ok: false, status: 409, why });
    // switched on again, it is counted
    expect((await s.check(q.reference)).status).toBe("paid");
  });
});

describe("a chain that answers badly", () => {
  it("one transaction that cannot be read does not lose the others: the burn beside it is counted", async () => {
    const s = setup();
    const q = await s.quoted(1);
    const real = s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]] });
    s.chain.broken.add(s.chain.did({ references: [q.reference], balances: [] }));
    expect((await s.check(q.reference, [real])).status).toBe("paid");
    expect((await s.check(q.reference)).status).toBe("paid");
  });

  it("a transaction in a form the RPC will not hand over is nothing toward a quote, and does not stand in the way of paying it", async () => {
    const s = setup();
    const q = await s.quoted(1);
    s.chain.holds[tokenAccountOf(payer, MINT, TOKEN_2022).toBase58()] = TOKENS(300_000);
    s.chain.unsupported.add(s.chain.did({ references: [q.reference], balances: [] }));
    expect(await s.check(q.reference)).toEqual({ status: "waiting" });
    expect((await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).ok).toBe(true);
    // read once, and not again
    const before = s.reads();
    await s.check(q.reference);
    expect(s.reads()).toBe(before);
  });

  it("is said to be a chain that could not be read, and not that nothing is there; and no burn is built over one that could not be read", async () => {
    const s = setup();
    const q = await s.quoted(1);
    s.chain.holds[tokenAccountOf(payer, MINT, TOKEN_2022).toBase58()] = TOKENS(300_000);
    const sent = s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]] });
    const down = { ok: false, status: 502, why: "the chain could not be read just now. Try again in a minute." };
    s.chain.noList = true;
    expect(await s.prepaid.check(s.profile, q.reference)).toEqual(down);
    expect(await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).toEqual(down);
    // the list answers and the transaction in it does not: it may be the burn, so nothing is built
    s.chain.noList = false;
    s.chain.broken.add(sent);
    expect(await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).toEqual(down);
    // with the list still failing, a payment named by its signature is found all the same
    s.chain.broken.clear();
    s.chain.noList = true;
    expect((await s.check(q.reference, [sent])).status).toBe("paid");
  });

  it("a burn that was counted and then not paid for, because the look was cut short, is paid for at the next look", async () => {
    const s = setup();
    const q = await s.quoted(1);
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]] });
    // the disk is full at the moment the burn is counted
    const flush = s.store.flush.bind(s.store);
    let fail = true;
    s.store.flush = () => { if (fail) { fail = false; throw new Error("no space left on device"); } flush(); };
    await expect(s.prepaid.check(s.profile, q.reference)).rejects.toThrow("no space");
    expect(s.accounts.profile(s.profile)?.tier).toBe("watch");
    expect((await s.check(q.reference)).status).toBe("paid");
    expect(s.months()).toBe(1);
  });
});

describe("many looks and many quotes", () => {
  it("one profile's looks do not hold up another's, and what cannot be counted is read once and not at every look", async () => {
    const s = setup();
    const other = s.admit(2);
    // twenty-five payments of one unit toward a quote in USDC, and twenty looks at it
    const usdc = await s.prepaid.quote(s.profile, "USDC", 1);
    if (!usdc.ok) throw new Error(usdc.why);
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    for (let i = 0; i < 25; i++) s.chain.did({ references: [usdc.quote.reference], balances: [[PAY_TO, 0n, 1n]], mint: USDC });
    const mine = await s.quoted(1, other);
    s.chain.did({ references: [mine.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]] });
    s.chain.slow = 3;
    const order: string[] = [];
    const flood = Array.from({ length: 20 }, () => s.prepaid.check(s.profile, usdc.quote.reference).then((r) => { order.push("flood"); return r; }));
    const theirs = s.check(mine.reference, undefined, other).then((r) => { order.push("theirs"); return r; });
    expect((await theirs).status).toBe("paid");
    const answers = await Promise.all(flood);
    // the other profile's burn was answered while the flood was still being worked through
    expect(order.indexOf("theirs")).toBeLessThan(order.lastIndexOf("flood"));
    // and the twenty looks read each of the twenty-five once
    expect(answers.at(-1)).toEqual({ ok: true, result: { status: "short", arrived: "1", wanted: usdc.quote.units } });
    expect(s.reads()).toBe(25 + 1);
  });

  it("a payment in USDC that follows a short one and a pile of small ones is found: none of them is read twice, so they cannot fill every look", async () => {
    const s = setup();
    const r = await s.prepaid.quote(s.profile, "USDC", 1);
    if (!r.ok) throw new Error(r.why);
    const q = r.quote, USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    s.chain.did({ references: [q.reference], balances: [[PAY_TO, 0n, 1n]], mint: USDC });
    for (let i = 0; i < 40; i++) s.chain.did({ references: [q.reference], balances: [[PAY_TO, 0n, 1n]], mint: USDC });
    expect(await s.check(q.reference)).toEqual({ status: "short", arrived: "1", wanted: q.units });
    s.chain.did({ references: [q.reference], balances: [[PAY_TO, 0n, BigInt(q.units)]], mint: USDC });
    expect((await s.check(q.reference)).status).toBe("paid");
  });

  it("the service's own look gets to every quote: the ones looked for longest ago go first, and nobody's asking pushes another's out", async () => {
    const s = setup();
    const q = await s.quoted(1);
    s.chain.holds[tokenAccountOf(payer, MINT, TOKEN_2022).toBase58()] = TOKENS(300_000);
    // a burn was built and sent, and the tab closed
    expect((await s.prepaid.transaction(s.profile, q.reference, payer.toBase58())).ok).toBe(true);
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]] });
    // then twenty-five other profiles ask about three quotes each, later than that
    s.later(60);
    const others: [string, string][] = [];
    for (let n = 2; n <= 26; n++) { const p = s.admit(n); for (const months of [1, 3, 12]) { const o = await s.quoted(months, p); others.push([p, o.reference]); await s.check(o.reference, undefined, p); } }
    // sixty an hour: the first hour does not reach it, the second does, though the others keep asking
    expect(await s.prepaid.sweep()).toEqual({ looked: 60, paid: 0 });
    for (const [p, reference] of others) await s.check(reference, undefined, p);
    const second = await s.prepaid.sweep();
    expect(second.paid).toBe(1);
    expect(s.accounts.profile(s.profile)?.tier).toBe("pro");
  });
});

describe("what a quote is worth later", () => {
  it("holds its number for a week and no longer: a quote that has run out does not go on paying at a number that was since raised", async () => {
    const s = setup();
    const q = await s.quoted(1);
    // the number is raised to 50,000 a month; the same store, another setting
    const dearer = s.made({ burn: { mint: LAMPORT_MINT, perMonth: 50_000 } });
    // within its week the quote is honoured as it was shown
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(275_000)]] });
    expect(await dearer.check(s.profile, q.reference)).toMatchObject({ ok: true, result: { status: "paid" } });
    expect(s.months()).toBe(1);
    // on day twenty, three burns of the old amount naming the old quote: 75,000 burned is one month at 50,000, with 25,000 over, and not three
    s.later(20 * 86_400);
    for (let i = 0; i < 3; i++) s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(275_000), TOKENS(250_000)]] });
    for (const t of s.chain.txs.slice(-3)) t.result.blockTime = T0 + 20 * 86_400;
    await dearer.check(s.profile, q.reference);
    expect(s.months()).toBe(2);
    expect(s.accounts.intentOf(s.profile, q.reference)?.counted).toBe(TOKENS(25_000).toString());
  });

  it("what was over on a quote that is paid counts toward the profile's next one, and so does what was short on one that ran out", async () => {
    const s = setup();
    s.chain.holds[tokenAccountOf(payer, MINT, TOKEN_2022).toBase58()] = TOKENS(1_000_000);
    const first = await s.quoted(1);
    s.chain.did({ references: [first.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(290_000)]] });
    s.chain.did({ references: [first.reference], balances: [[payer.toBase58(), TOKENS(290_000), TOKENS(265_000)]] });
    expect((await s.check(first.reference)).status).toBe("paid");
    // 10,000 over: the next quote starts with it, and burns only the rest
    const next = await s.quoted(1);
    expect(next.reference).not.toBe(first.reference);
    expect(next.counted).toBe(TOKENS(10_000).toString());
    expect(s.accounts.intentOf(s.profile, first.reference)?.counted).toBe("0");
    const rest = await s.prepaid.transaction(s.profile, next.reference, payer.toBase58());
    if (!rest.ok) throw new Error(rest.why);
    expect(Transaction.from(Buffer.from(rest.transaction, "base64")).instructions[0]!.data.readBigUInt64LE(1)).toBe(TOKENS(15_000));

    // 40,000 toward three months, and the quote runs out
    const three = await s.quoted(3);
    s.chain.did({ references: [three.reference], balances: [[payer.toBase58(), TOKENS(265_000), TOKENS(225_000)]] });
    expect(await s.check(three.reference)).toMatchObject({ status: "short", arrived: TOKENS(40_000).toString() });
    s.later(8 * 86_400);
    expect(await s.prepaid.transaction(s.profile, three.reference, payer.toBase58())).toMatchObject({ ok: false, status: 410 });
    // asked for again, it is a new quote that has the 40,000, and the 10,000 from before: nothing burned stays behind
    const again = await s.quoted(3);
    expect(again.reference).not.toBe(three.reference);
    expect(again.counted).toBe(TOKENS(50_000).toString());
  });

  it("what was burned before covers a smaller amount whole: it is counted on asking, and nothing more is burned", async () => {
    const s = setup();
    s.chain.holds[tokenAccountOf(payer, MINT, TOKEN_2022).toBase58()] = TOKENS(1_000_000);
    const three = await s.quoted(3);
    s.chain.did({ references: [three.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(260_000)]] });
    await s.check(three.reference);
    s.later(8 * 86_400);
    const one = await s.quoted(1);
    expect(one.counted).toBe(TOKENS(40_000).toString());
    expect(await s.prepaid.transaction(s.profile, one.reference, payer.toBase58())).toEqual({ ok: false, status: 409, why: "what was burned before covers this. Look for it and it is counted: nothing more needs burning." });
    expect((await s.check(one.reference)).status).toBe("paid");
    expect(s.months()).toBe(1);
    expect(s.accounts.intentOf(s.profile, one.reference)?.counted).toBe(TOKENS(15_000).toString());
  });

  it("with something burned for it and not used is never dropped, however old", async () => {
    const s = setup();
    const q = await s.quoted(3);
    s.chain.did({ references: [q.reference], balances: [[payer.toBase58(), TOKENS(300_000), TOKENS(260_000)]] });
    await s.check(q.reference);
    s.later(200 * 86_400);
    // other profiles ask for amounts, which is when old quotes are cleared out
    for (let n = 2; n < 6; n++) await s.quoted(1, s.admit(n));
    expect(s.accounts.intentOf(s.profile, q.reference)?.counted).toBe(TOKENS(40_000).toString());
    expect((await s.quoted(12)).counted).toBe(TOKENS(40_000).toString());
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
