/**
 * The watcher's rules against what happens to a wallet: each drain raises its signal at the level in the
 * spec's table, and a wallet going about its business raises nothing.
 */
import "../../../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, NONCE_ACCOUNT_LENGTH } from "@solana/web3.js";
import { Baseline } from "../src/baseline.js";
import { accountKeys, decode, fromRpc, movementOf, type ObservedTx, type TokenBalance } from "../src/observed.js";
import { BurstWindow, assessTokenAccount, assessTransaction, assessWalletAccount, type TokenAccountState, type WatchContext } from "../src/signals.js";
import { splitTransaction } from "../../../pincer1/daemon/src/tx/parse.js";

const wallet = Keypair.fromSeed(new Uint8Array(32).fill(7));
const W = wallet.publicKey.toBase58();
const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const friend = key(11), shop = key(12), thief = key(66), dex = key(80);
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM = "11111111111111111111111111111111";
const BLOCKHASH = "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x";
const SOL = 1_000_000_000;
/** 2026-11-10 12:00 UTC, a Tuesday noon. */
const NOON = 1_794_312_000;
const lookalike = (of: PublicKey) => new PublicKey(Buffer.from((BigInt("0x" + Buffer.from(of.toBytes()).toString("hex")) + 707281n * (1n << 80n)).toString(16).padStart(64, "0"), "hex"));
const myUsdc = key(21), sentinelDelegate = key(90).toBase58();

interface Told {
  at?: number;
  /** What the wallet held before, in SOL (10 unless said). */
  held?: number;
  payer?: PublicKey;
  failed?: boolean;
  /** Lamports that left (positive) or reached (negative) an account besides the fee. */
  sol?: [PublicKey, number][];
  /** Token accounts before and after: [account, mint, owner before, amount before, owner after, amount after]. */
  tokens?: [PublicKey, PublicKey, PublicKey | null, number, PublicKey | null, number][];
}

/** A confirmed transaction as the watcher would have it, with the balances a test says it left behind. */
function observed(ixs: TransactionInstruction[], told: Told = {}): ObservedTx {
  const payer = told.payer ?? wallet.publicKey;
  const bytes = new Transaction({ feePayer: payer, recentBlockhash: BLOCKHASH }).add(...ixs).serialize({ requireAllSignatures: false, verifySignatures: false });
  const tx: ObservedTx = { signature: `sig${Math.random()}`, slot: 1, blockTime: told.at ?? NOON, message: splitTransaction(bytes).messageBytes, failed: told.failed ?? false, fee: 5000, preBalances: [], postBalances: [], preTokenBalances: [], postTokenBalances: [] };
  const keys = accountKeys(tx);
  tx.preBalances = keys.map((k) => (k === W ? (told.held ?? 10) : 10) * SOL);
  tx.postBalances = keys.map((k, i) => tx.preBalances[i]! - (k === payer.toBase58() ? 5000 : 0));
  for (const [who, lamports] of told.sol ?? []) { const i = keys.indexOf(who.toBase58()); if (i >= 0) tx.postBalances[i]! -= lamports; }
  const bal = (account: PublicKey, mint: PublicKey, owner: PublicKey, amount: number): TokenBalance => ({ accountIndex: keys.indexOf(account.toBase58()), mint: mint.toBase58(), owner: owner.toBase58(), amount: String(amount), decimals: 6 });
  for (const [account, mint, ownerBefore, before, ownerAfter, after] of told.tokens ?? []) {
    if (ownerBefore) tx.preTokenBalances.push(bal(account, mint, ownerBefore, before));
    if (ownerAfter) tx.postTokenBalances.push(bal(account, mint, ownerAfter, after));
  }
  return tx;
}

const pay = (to: PublicKey, sol: number, at = NOON, held = 10) => observed([SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: to, lamports: Math.round(sol * SOL) })], { at, held, sol: [[wallet.publicKey, Math.round(sol * SOL)], [to, -Math.round(sol * SOL)]] });
const swap = (program: PublicKey, solOut: number, usdcIn: number, at = NOON) =>
  observed([new TransactionInstruction({ programId: program, keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }, { pubkey: myUsdc, isSigner: false, isWritable: true }], data: Buffer.from([1]) })], { at, sol: [[wallet.publicKey, Math.round(solOut * SOL)]], tokens: [[myUsdc, USDC, wallet.publicKey, 0, wallet.publicKey, usdcIn]] });

/** A wallet with a past: 24 payments to two addresses and 6 swaps on one program, on weekdays between 09:00 and 17:00 UTC. */
function history(): ObservedTx[] {
  const out: ObservedTx[] = [];
  for (let i = 0; i < 24; i++) out.push(pay(i % 3 === 0 ? shop : friend, 0.2 + (i % 5) * 0.2, NOON - (30 - i) * 86_400 + ((i % 8) - 3) * 3600));
  for (let i = 0; i < 6; i++) out.push(swap(dex, 0.5, 80_000_000, NOON - (12 - i) * 86_400 + 3600));
  return out;
}
function watching(over: Partial<WatchContext> = {}): WatchContext {
  const baseline = Baseline.empty();
  for (const tx of history()) baseline.learn(tx, W);
  return { wallet: W, baseline, drainers: new Set([thief.toBase58()]), sentinelDelegate, ...over };
}
const kinds = (ctx: WatchContext, tx: ObservedTx) => assessTransaction(tx, ctx).signals.map((s) => `${s.kind}:${s.level}`);

describe("the baseline", () => {
  it("is built from what the wallet itself sent, and nothing that arrived", () => {
    const b = watching().baseline;
    expect(b.transactions).toBe(30);
    expect(b.memory.lookup(friend.toBase58())?.timesPaid).toBe(16);
    expect(b.memory.lookup(shop.toBase58())?.timesPaid).toBe(8);
    expect(b.memory.programUses(dex.toBase58())).toBe(6);
    expect(b.neverAt(3)).toBe(true);
    expect(b.neverAt(12)).toBe(false);

    // dust from a look-alike of the friend's address, a failed payment, and someone else's transaction: nothing learned
    const fake = lookalike(friend);
    b.learn(observed([SystemProgram.transfer({ fromPubkey: fake, toPubkey: wallet.publicKey, lamports: 1 })], { payer: fake, sol: [[wallet.publicKey, -1]] }), W);
    b.learn({ ...pay(key(40), 1), failed: true }, W);
    expect(b.transactions).toBe(30);
    expect(b.memory.lookup(fake.toBase58())).toBeUndefined();
    expect(b.memory.lookup(key(40).toBase58())).toBeUndefined();
    expect(Baseline.from(JSON.parse(JSON.stringify(b))).memory.lookup(friend.toBase58())?.timesPaid).toBe(16);
  });

  it("says nothing about a wallet going about its business", () => {
    const ctx = watching({ window: new BurstWindow() });
    let alerts = 0;
    // sixty more days of the same: payments to the same two addresses and swaps on the same program
    for (let day = 1; day <= 60; day++) {
      const tx = day % 4 === 0 ? swap(dex, 0.4, 60_000_000, NOON + day * 86_400) : pay(day % 3 === 0 ? shop : friend, 0.3 + (day % 4) * 0.2, NOON + day * 86_400 + ((day % 6) - 2) * 3600);
      if (assessTransaction(tx, ctx).level !== null) alerts++;
      ctx.baseline.learn(tx, W);
    }
    expect(alerts).toBe(0);
  });
});

describe("what was done to the wallet (hard signals, Urgent by the table unless noted)", () => {
  it("a token account handed to someone else, by an instruction or behind a program", () => {
    const setAuthority = new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: myUsdc, isSigner: false, isWritable: true }, { pubkey: wallet.publicKey, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([6, 2, 1]), thief.toBuffer()]) });
    const a = assessTransaction(observed([setAuthority]), watching());
    expect(a).toMatchObject({ level: "urgent", rescueWorthy: true });
    expect(a.signals[0]).toMatchObject({ kind: "authority_changed", soft: false });

    // no instruction names it: a program did it, and only the account's owner field shows
    const hidden = observed([new TransactionInstruction({ programId: key(81), keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }, { pubkey: myUsdc, isSigner: false, isWritable: true }], data: Buffer.from([9]) })], { tokens: [[myUsdc, USDC, wallet.publicKey, 50_000_000, thief, 50_000_000]] });
    const b = assessTransaction(hidden, watching());
    expect(b.signals.map((s) => s.kind)).toContain("authority_changed");
    expect(b.rescueWorthy).toBe(true);
    expect(b.signals.find((s) => s.kind === "authority_changed")!.sentence).toBe(`Your USDC account now belongs to ${thief.toBase58().slice(0, 4)}…${thief.toBase58().slice(-4)}, not to you.`);
  });

  it("the wallet account assigned to a program", () => {
    const a = assessTransaction(observed([SystemProgram.assign({ accountPubkey: wallet.publicKey, programId: key(82) })]), watching());
    expect(a).toMatchObject({ level: "urgent", rescueWorthy: true });
    expect(a.signals[0]!.kind).toBe("wallet_reassigned");
    expect(assessWalletAccount(SYSTEM, key(82).toBase58())).toMatchObject({ level: "urgent", rescueWorthy: true });
    expect(assessWalletAccount(SYSTEM, SYSTEM).level).toBeNull();
  });

  it("value sent to a known drainer, by a transfer or through a program that hides it", () => {
    expect(kinds(watching(), pay(thief, 3))).toContain("known_drainer:urgent");
    const through = observed([new TransactionInstruction({ programId: dex, keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }, { pubkey: myUsdc, isSigner: false, isWritable: true }, { pubkey: key(67), isSigner: false, isWritable: true }], data: Buffer.from([2]) })], { tokens: [[myUsdc, USDC, wallet.publicKey, 900_000_000, wallet.publicKey, 0], [key(67), USDC, thief, 0, thief, 900_000_000]] });
    const a = assessTransaction(through, watching());
    expect(a).toMatchObject({ level: "urgent", rescueWorthy: true });
    expect(a.sentence).toMatch(/^900 USDC left your wallet for .{4}….{4}, an address known for draining wallets\.$/);
  });

  it("value sent to a look-alike of an address the wallet pays", () => {
    const a = assessTransaction(pay(lookalike(friend), 0.5), watching());
    expect(a).toMatchObject({ level: "urgent", rescueWorthy: true });
    expect(a.sentence).toMatch(/which you have paid 16 times, but it is a different address\.$/);
  });

  it("an unlimited approval to anyone but Sentinel is an Alert, and Sentinel's own is nothing", () => {
    const approve = (delegate: PublicKey | string) => { const d = Buffer.alloc(9); d[0] = 4; d.writeBigUInt64LE(2n ** 64n - 1n, 1); return observed([new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: myUsdc, isSigner: false, isWritable: true }, { pubkey: new PublicKey(delegate), isSigner: false, isWritable: false }, { pubkey: wallet.publicKey, isSigner: true, isWritable: false }], data: d })]); };
    const a = assessTransaction(approve(key(68)), watching());
    expect(a).toMatchObject({ level: "alert", rescueWorthy: false });
    expect(a.signals[0]).toMatchObject({ kind: "unlimited_approval", soft: false });
    expect(assessTransaction(approve(sentinelDelegate), watching()).level).toBeNull();
  });

  it("a durable-nonce account that someone else controls is an Alert", () => {
    const nonce = key(69);
    const created = observed(SystemProgram.createNonceAccount({ fromPubkey: wallet.publicKey, noncePubkey: nonce, authorizedPubkey: thief, lamports: 2_000_000 }).instructions);
    expect(kinds(watching(), created)).toEqual(["foreign_nonce:alert"]);
    const own = observed(SystemProgram.createNonceAccount({ fromPubkey: wallet.publicKey, noncePubkey: nonce, authorizedPubkey: wallet.publicKey, lamports: 2_000_000 }).instructions);
    expect(kinds(watching(), own)).toEqual([]);
    const handed = observed([SystemProgram.nonceAuthorize({ noncePubkey: nonce, authorizedPubkey: wallet.publicKey, newAuthorizedPubkey: thief })]);
    expect(kinds(watching(), handed)).toEqual(["foreign_nonce:alert"]);
    expect(NONCE_ACCOUNT_LENGTH).toBe(80);
  });

  it("stays, with its level, when the owner's browser says the signature was theirs", () => {
    const a = assessTransaction(pay(lookalike(friend), 0.5), watching({ ownerSigned: true }));
    expect(a).toMatchObject({ level: "urgent", rescueWorthy: true });
  });
});

describe("unlike the wallet's past (soft signals)", () => {
  it("a first payment larger than anything the wallet has sent is an Alert, and is dropped when the owner reported it", () => {
    const tx = pay(key(41), 4);
    const a = assessTransaction(tx, watching());
    expect(a).toMatchObject({ level: "alert", rescueWorthy: false });
    expect(a.signals[0]).toMatchObject({ kind: "new_large_payment", soft: true });
    expect(a.sentence).toMatch(/^4 SOL left your wallet for .{4}….{4}, an address it has never paid\. That is more than it has ever sent at once \(1 SOL\)\.$/);
    expect(assessTransaction(tx, watching({ ownerSigned: true })).level).toBeNull();
    // a first payment of an ordinary size is not news
    expect(assessTransaction(pay(key(41), 0.4), watching()).level).toBeNull();
  });

  it("value leaving through a program the wallet never used is an Alert", () => {
    expect(kinds(watching(), swap(key(83), 0.5, 10))).toEqual(["new_program:alert"]);
    expect(kinds(watching(), swap(dex, 0.5, 10))).toEqual([]);
  });

  it("several payments close together are an Alert, and most of the wallet leaving is Urgent but never rescues on its own", () => {
    const ctx = watching({ window: new BurstWindow() });
    const levels = [0, 1, 2, 3].map((i) => assessTransaction(pay(friend, 0.3, NOON + i * 60, 40), ctx).level);
    expect(levels).toEqual([null, null, null, "alert"]);

    // a wallet holding 10 SOL: 3 leave, then 3 more of the 7 that were left
    const draining = watching({ window: new BurstWindow() });
    const a = assessTransaction(pay(friend, 3, NOON, 10), draining);
    expect(a.level).toBeNull(); // less than half so far
    const b = assessTransaction(pay(friend, 3, NOON + 30, 7), draining);
    expect(b.signals.find((s) => s.kind === "burst")).toMatchObject({ level: "urgent", soft: true });
    expect(b.rescueWorthy).toBe(false);

    // It is said once for a run, not on every payment of it: eight payments a minute apart are one Alert,
    // though each of the last five is "four or more in ten minutes".
    const busy = watching({ window: new BurstWindow() });
    expect(Array.from({ length: 8 }, (_, i) => assessTransaction(pay(friend, 0.3, NOON + i * 60, 40), busy).level)).toEqual([null, null, null, "alert", null, null, null, null]);
    // still at it ten minutes after that was said: said again
    expect(assessTransaction(pay(friend, 0.3, NOON + 3 * 60 + 600, 40), busy).level).toBe("alert");
    // and at once, without waiting, when it gets worse: the run that was an Alert takes most of the wallet
    const worse = watching({ window: new BurstWindow() });
    for (let i = 0; i < 4; i++) assessTransaction(pay(friend, 0.3, NOON + i * 60, 40), worse);
    expect(assessTransaction(pay(friend, 0.3, NOON + 240, 40), worse).level).toBeNull();
    const emptied = assessTransaction(pay(friend, 30, NOON + 300, 38.5), worse);
    expect(emptied.signals.find((s) => s.kind === "burst")).toMatchObject({ level: "urgent" });
    expect(assessTransaction(pay(friend, 3, NOON + 330, 8.5), worse).signals.filter((s) => s.kind === "burst")).toEqual([]); // and that once, too

    // ten minutes later the window has moved on
    const later = watching({ window: new BurstWindow() });
    for (let i = 0; i < 6; i++) expect(assessTransaction(pay(friend, 0.3, NOON + i * 700, 40), later).level).toBeNull();
  });

  it("an hour the wallet never transacts in raises what else there is by one level, and that is not a reason to rescue unasked", () => {
    const at3am = NOON - 9 * 3600;
    const a = assessTransaction(pay(key(41), 4, at3am), watching());
    expect(a.level).toBe("urgent");
    expect(a.signals.map((s) => [s.kind, s.level, s.byTable])).toEqual([["new_large_payment", "urgent", false], ["odd_hour", "info", true]]);
    expect(a.rescueWorthy).toBe(false);
    // an ordinary payment at an odd hour is nothing by itself
    expect(assessTransaction(pay(friend, 0.4, at3am), watching()).level).toBeNull();
  });
});

describe("what arrives", () => {
  it("is a note at most, and never changes what the wallet is taken to trust", () => {
    const ctx = watching();
    const fake = lookalike(friend);
    const dust = (from: PublicKey) => observed([SystemProgram.transfer({ fromPubkey: from, toPubkey: wallet.publicKey, lamports: 1000 })], { payer: from, sol: [[wallet.publicKey, -1000]] });
    expect(kinds(ctx, dust(fake))).toEqual(["inbound_from_lookalike:info"]);
    expect(kinds(ctx, dust(thief))).toEqual(["inbound_from_drainer:info"]);
    expect(kinds(ctx, dust(key(42)))).toEqual([]);
    ctx.baseline.learn(dust(fake), W);
    // the look-alike is still a look-alike afterwards
    expect(assessTransaction(pay(fake, 0.5), ctx).level).toBe("urgent");
  });

  it("a transaction that failed did nothing and says nothing", () => {
    expect(assessTransaction({ ...pay(thief, 3), failed: true }, watching()).level).toBeNull();
  });
});

describe("a token account that changed", () => {
  const state = (over: Partial<TokenAccountState> = {}): TokenAccountState => ({ address: myUsdc.toBase58(), mint: USDC.toBase58(), owner: W, delegate: sentinelDelegate, closeAuthority: null, ...over });
  it("Sentinel's permission replaced is Urgent, by a reviewed program an Alert, and removed is Urgent", () => {
    const ctx = watching({ reviewedPrograms: new Set([key(84).toBase58()]) });
    const replaced = assessTokenAccount(state(), state({ delegate: key(68).toBase58() }), ctx);
    expect(replaced).toMatchObject({ level: "urgent", rescueWorthy: true });
    expect(replaced.sentence).toMatch(/^Your USDC account's spending permission moved from Sentinel to .{4}….{4}\. Only you can revoke it\./);
    expect(assessTokenAccount(state(), state({ delegate: key(84).toBase58() }), ctx)).toMatchObject({ level: "alert", rescueWorthy: false });
    expect(assessTokenAccount(state(), state({ delegate: null }), ctx)).toMatchObject({ level: "urgent" });
    expect(assessTokenAccount(state(), state(), ctx).level).toBeNull();
    // an account that was never armed changing its delegate is the transaction rules' business, not this one's
    expect(assessTokenAccount(state({ delegate: null }), state({ delegate: key(68).toBase58() }), ctx).level).toBeNull();
  });
  it("a new owner or a stranger's close authority is Urgent", () => {
    const ctx = watching();
    expect(assessTokenAccount(state(), state({ owner: thief.toBase58() }), ctx)).toMatchObject({ level: "urgent", rescueWorthy: true });
    expect(assessTokenAccount(state(), state({ closeAuthority: thief.toBase58() }), ctx)).toMatchObject({ level: "urgent" });
  });
});

describe("reading what an RPC returns", () => {
  it("takes a version 0 transaction with its loaded addresses and balances, and reads the accounts behind the table", () => {
    const table = new AddressLookupTableAccount({ key: key(60), state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [key(61), thief] } });
    const message = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: BLOCKHASH, instructions: [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: thief, lamports: 2 * SOL })] }).compileToV0Message([table]);
    const raw = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
    const tx = fromRpc("5ig", {
      slot: 400, blockTime: NOON, transaction: [raw, "base64"],
      meta: { err: null, fee: 5000, preBalances: [10 * SOL, 1, 0], postBalances: [8 * SOL - 5000, 1, 2 * SOL], preTokenBalances: [], postTokenBalances: [], loadedAddresses: { writable: [thief.toBase58()], readonly: [] } },
    })!;
    expect(accountKeys(tx)).toEqual([W, SYSTEM, thief.toBase58()]);
    expect(decode(tx, W)?.dest).toBe(thief.toBase58());
    expect(movementOf(tx, W).lamports).toBe(BigInt(-2 * SOL - 5000));
    expect(kinds(watching(), tx)).toContain("known_drainer:urgent");
    expect(fromRpc("x", { transaction: ["!!", "base64"], meta: {} })).toBeNull();
    expect(fromRpc("x", null)).toBeNull();
  });
});
