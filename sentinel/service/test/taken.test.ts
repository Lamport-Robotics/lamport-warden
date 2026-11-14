/**
 * Tokens taken through a permission the wallet gave earlier.
 *
 * A delegate moves a wallet's tokens in a transaction the wallet does not sign and that need not name the
 * wallet at all, so it is in no list of the wallet's transactions. What shows it is the token account, which
 * holds less. These tests run the watcher against a chain where that happens: that the owner is told, once,
 * with who did it; that the wallet's own spending, and what other people pay in, raise nothing and cost
 * nothing more to read; and what happens when the RPC is behind or there is more to read than one pass reads.
 */
import "../../../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { Rpc } from "../src/rpc.js";
import { fromRpc, tokenLossesOf } from "../src/observed.js";
import { assessTaken, assessTransaction, assessUnexplainedLoss, type TokenAccountState } from "../src/signals.js";
import { Baseline } from "../src/baseline.js";
import { MemoryStore } from "../src/store.js";
import { BEHIND_AFTER_SECONDS, BEHIND_EVERY_SECONDS, EXPLAIN_FOR_SECONDS, MAX_TOKEN_ACCOUNTS, MOST_ACCOUNT_LISTS, MOST_EXTRA_READS, MOST_PER_PASS, STALE_AFTER_SECONDS, WAIT_FOR_OWN_SECONDS, Watcher, type Notifier } from "../src/watcher.js";

const wallet = Keypair.fromSeed(new Uint8Array(32).fill(7));
const W = wallet.publicKey.toBase58();
const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const friend = key(11), thief = key(66), payer = key(67), rescuer = key(68), drainProgram = key(80);
const SD = key(90).toBase58();
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const T0 = 1_794_312_000;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
/** Whole USDC as its smallest units. */
const usdc = (n: number) => n * 1_000_000;

interface Account { mint: string; owner: string; amount: number; delegate: string | null; decimals: number }

/** A chain with slots: token accounts that hold amounts, and transfers between them that say who signed. */
class Chain implements Rpc {
  slot = 1000;
  lamports = 5_000_000_000;
  accounts = new Map<string, Account>();
  /** `hiddenFrom`: addresses whose list does not show it, as when more was sent to an address than its list goes back. */
  txs: { signature: string; slot: number; names: string[]; result: any; failed: boolean; listed: boolean; shown: boolean; hiddenFrom: string[] }[] = [];
  calls: string[] = [];
  /** Something that happens on the chain just after the next look is answered. */
  afterLook: (() => void) | null = null;
  /** When set, the next look is answered by a node that has fallen behind: the accounts as they were when this was taken. */
  behind: { slot: number; lamports: number; amounts: Map<string, number> } | null = null;
  asOfNow() { return { slot: this.slot, lamports: this.lamports, amounts: new Map([...this.accounts].map(([a, t]) => [a, t.amount])) }; }
  private n = 0;

  account(owner: PublicKey | string, amount: number, opts: { delegate?: string; mint?: string; decimals?: number; address?: string } = {}): string {
    const address = opts.address ?? Keypair.generate().publicKey.toBase58();
    this.accounts.set(address, { mint: opts.mint ?? USDC, owner: typeof owner === "string" ? owner : owner.toBase58(), amount, delegate: opts.delegate ?? null, decimals: opts.decimals ?? 6 });
    return address;
  }

  /**
   * A transaction `signer` signs and pays for, which moves tokens: each move is [from, to, amount]. `authority`
   * is whose permission it goes under when that is not the signer (a program's address). `also` are addresses
   * it names without needing them.
   */
  transfer(signer: PublicKey, moves: [string, string, number][], opts: { authority?: PublicKey; also?: PublicKey[]; failed?: boolean; listed?: boolean; shown?: boolean; pays?: [PublicKey, number]; hiddenFrom?: string[] } = {}): string {
    const ixs = moves.map(([from, to, amount], i) => {
      const data = Buffer.alloc(9); data[0] = 3; data.writeBigUInt64LE(BigInt(amount), 1);
      const keys = [{ pubkey: new PublicKey(from), isSigner: false, isWritable: true }, { pubkey: new PublicKey(to), isSigner: false, isWritable: true }, { pubkey: opts.authority ?? signer, isSigner: !opts.authority, isWritable: false }];
      if (i === 0) for (const pubkey of opts.also ?? []) keys.push({ pubkey, isSigner: false, isWritable: false });
      return new TransactionInstruction({ programId: opts.authority ? drainProgram : TOKEN, keys, data });
    });
    const tx = new Transaction({ feePayer: signer, recentBlockhash: "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x" }).add(...ixs);
    const names = tx.compileMessage().accountKeys.map((k) => k.toBase58());
    const touched = [...new Set(moves.flatMap(([from, to]) => [from, to]))].filter((a) => this.accounts.has(a));
    const balances = () => touched.map((a) => { const t = this.accounts.get(a)!; return { accountIndex: names.indexOf(a), mint: t.mint, owner: t.owner, uiTokenAmount: { amount: String(t.amount), decimals: t.decimals } }; });
    const pre = balances();
    if (!opts.failed) for (const [from, to, amount] of moves) { this.accounts.get(from)!.amount -= amount; const t = this.accounts.get(to); if (t) t.amount += amount; }
    const post = balances();
    this.slot += 1;
    if (signer.toBase58() === W) this.lamports -= 5000;
    const signature = `sig${String(++this.n).padStart(4, "0")}`;
    const lamports = names.map(() => 10_000_000_000);
    // `pays`: lamports that reach one of the addresses it names, as the price of a sale does
    const paid = (i: number) => (opts.pays && names[i] === opts.pays[0].toBase58() ? opts.pays[1] : 0);
    this.txs.push({
      signature, slot: this.slot, names, failed: opts.failed ?? false, listed: opts.listed ?? true, shown: opts.shown ?? true, hiddenFrom: opts.hiddenFrom ?? [],
      result: { slot: this.slot, blockTime: T0, transaction: [Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64"), "base64"], meta: { err: opts.failed ? { InstructionError: [0, "Custom"] } : null, fee: 5000, preBalances: lamports, postBalances: lamports.map((l, i) => (i === 0 ? l - 5000 : l) + paid(i)), preTokenBalances: pre, postTokenBalances: post } },
    });
    return signature;
  }

  private info(a: Account) { return { mint: a.mint, owner: a.owner, state: "initialized", tokenAmount: { amount: String(a.amount), decimals: a.decimals }, ...(a.delegate ? { delegate: a.delegate, delegatedAmount: { amount: "18446744073709551615" } } : {}) }; }

  async call(method: string, params: any[], opts?: { background?: boolean }): Promise<any> {
    // a call made to give way to the others is marked, for the tests that ask which ones were
    const bg = opts?.background ? "(bg)" : "";
    switch (method) {
      case "getMultipleAccounts":
        this.calls.push("look");
        try {
          const old = this.behind; this.behind = null;
          return { context: { slot: old?.slot ?? this.slot }, value: (params[0] as string[]).map((address) => {
            if (address === W) return { lamports: old?.lamports ?? this.lamports, owner: SYSTEM, data: ["", "base64"] };
            const a = this.accounts.get(address);
            return a ? { lamports: 2_039_280, owner: TOKEN.toBase58(), data: { parsed: { info: this.info({ ...a, amount: old?.amounts.get(address) ?? a.amount }) } } } : null;
          }) };
        } finally { const then = this.afterLook; this.afterLook = null; then?.(); }
      case "getSignaturesForAddress": {
        this.calls.push((params[0] === W ? "list:wallet" : "list:account") + bg);
        const { limit = 1000, before, until } = params[1] ?? {};
        let list = this.txs.filter((t) => t.listed && t.names.includes(params[0]) && !t.hiddenFrom.includes(params[0])).reverse();
        if (before) list = list.slice(list.findIndex((t) => t.signature === before) + 1);
        if (until) { const i = list.findIndex((t) => t.signature === until); if (i >= 0) list = list.slice(0, i); }
        return list.slice(0, limit).map((t) => ({ signature: t.signature, slot: t.slot, err: t.failed ? { InstructionError: [0, "Custom"] } : null }));
      }
      case "getTransaction": { this.calls.push("tx" + bg); const t = this.txs.find((x) => x.signature === params[0]); return t && t.shown ? t.result : null; }
      case "getTokenAccountsByOwner":
        this.calls.push("accounts");
        return { context: { slot: this.slot }, value: params[1].programId === TOKEN.toBase58() ? [...this.accounts].filter(([, a]) => a.owner === params[0]).map(([pubkey, a]) => ({ pubkey, account: { data: { parsed: { info: this.info(a) } } } })) : [] };
      case "getAccountInfo": {
        this.calls.push("info");
        if (params[0] === W) return { value: { owner: SYSTEM } };
        const a = this.accounts.get(params[0]);
        return { value: a ? { data: { parsed: { info: this.info(a) } } } : null };
      }
      default: throw new Error(`unexpected ${method}`);
    }
  }
  took(): string[] { const c = this.calls; this.calls = []; return c; }
}

/** A wallet that has been read and looked at once, with the token accounts a test gives it. */
async function watched(build: (chain: Chain) => void, opts: { sentinelDelegate?: string; sentinelVault?: string; drainers?: string[]; ownListPagesInAll?: number; ownRescues?: Set<string> } = {}) {
  const chain = new Chain();
  build(chain);
  const store = new MemoryStore([{ address: W, ...(opts.sentinelDelegate ? { sentinelDelegate: opts.sentinelDelegate } : {}), ...(opts.sentinelVault ? { sentinelVault: opts.sentinelVault } : {}) }]);
  let now = T0;
  const told: { level: string; sentence: string }[] = [];
  const notifier: Notifier = { notify: async (_w, level, sentence) => { told.push({ level, sentence }); } };
  const make = () => new Watcher(chain, store, notifier, { now: () => now, ...(opts.drainers ? { drainers: new Set(opts.drainers) } : {}), ...(opts.ownListPagesInAll ? { ownListPagesInAll: opts.ownListPagesInAll } : {}), ...(opts.ownRescues ? { ownRescues: opts.ownRescues } : {}) });
  let watcher = make();
  await watcher.passAll(); await watcher.passAll();
  chain.took();
  return {
    chain, store, told,
    /** The wallet's next turn, a minute later. */
    round: async () => { now += 60; chain.slot += 10; const r = await watcher.passAll(); return { raised: r.raised, calls: chain.took() }; },
    /** Time goes by with the wallet not read at all (its plan lapsed, the service was away). */
    away: (seconds: number) => { now += seconds; chain.slot += Math.round(seconds * 2.5); },
    /** The owner presses "This was me" on the alert about this transaction. */
    thisWasMe: (signature: string) => watcher.confirmOwn(W, signature),
    /** The service stops and starts: what it remembered of the transactions it read is gone, and the record is not. */
    restart: () => { watcher = make(); },
    amountOnRecord: (account: string) => store.record(W).tokenAccounts[account]?.amount,
    /** How many wallets the watcher is still holding transactions for: none, once every account is accounted for. */
    remembered: () => ((watcher as unknown as { moves: Map<string, unknown> }).moves.size),
    kinds: () => store.events(W).map((e) => `${e.signals.join("+")}:${e.level}`),
  };
}

describe("tokens taken through a permission the wallet gave earlier", () => {
  it("tells the owner when a delegate takes tokens in a transaction that does not name the wallet", async () => {
    let mine = "", theirs = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() }); theirs = c.account(thief, 0); });
    expect(s.amountOnRecord(mine)).toBe(String(usdc(100)));
    expect((await s.round()).calls).toEqual(["look"]); // a permission held and not used is not news here

    const signature = s.chain.transfer(thief, [[mine, theirs, usdc(25)]]);
    const r = await s.round();
    // the look sees the account holds less; the wallet's own list has nothing; the account's own list has the transaction
    expect(r.calls).toEqual(["look", "list:wallet", "list:account", "tx"]);
    expect(r.raised).toHaveLength(1);
    expect(r.raised[0]).toMatchObject({
      wallet: W, signature, level: "urgent", signals: ["taken_by_permission"], rescueWorthy: true,
      sentence: `25 USDC left your wallet in a transaction your wallet did not sign. ${short(thief.toBase58())} did it, using a permission to spend that your wallet gave it at some earlier time. Whatever that permission still covers can go the same way until your wallet revokes it.`,
    });
    expect(s.told).toEqual([{ level: "urgent", sentence: r.raised[0]!.sentence }]);
    expect(s.amountOnRecord(mine)).toBe(String(usdc(75)));
    expect(s.store.record(W).unsettled).toBeUndefined();
    expect(s.remembered()).toBe(0); // accounted for, and nothing kept of the thief's account, which is not the wallet's

    // said once: the next turns are quiet, and cost a look
    expect(await s.round()).toEqual({ raised: [], calls: ["look"] });
    expect(await s.round()).toEqual({ raised: [], calls: ["look"] });
    // and the next taking is its own alert
    s.chain.transfer(thief, [[mine, theirs, usdc(75)]]);
    expect((await s.round()).raised.map((e) => e.sentence.split(" left ")[0])).toEqual(["75 USDC"]);
    expect(s.kinds()).toEqual(["taken_by_permission:urgent", "taken_by_permission:urgent"]);
  });

  it("says nothing about the wallet's own spending, and reads nothing more for it", async () => {
    let mine = "", theirs = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100)); theirs = c.account(friend, 0); });
    s.chain.transfer(wallet.publicKey, [[mine, theirs, usdc(10)]]);
    const r = await s.round();
    expect(r.raised).toEqual([]);
    // its own transaction, and the accounts read that follows any transaction of its own: the token account's list is never asked for
    expect(r.calls).toEqual(["look", "list:wallet", "tx", "accounts", "accounts", "info"]);
    expect(s.amountOnRecord(mine)).toBe(String(usdc(90)));
    expect(s.remembered()).toBe(0);
    expect(await s.round()).toEqual({ raised: [], calls: ["look"] });
  });

  it("keeps a look the same look when an account empties: the order it reads them in is not the order it ranks them in", async () => {
    let theirs = "";
    const s = await watched((c) => { for (let i = 0; i < 3; i++) c.account(wallet.publicKey, usdc(10)); theirs = c.account(friend, 0); });
    const first = Object.keys(s.store.record(W).tokenAccounts).sort()[0]!;
    s.chain.transfer(wallet.publicKey, [[first, theirs, usdc(10)]]); // the wallet empties the account that comes first
    expect((await s.round()).raised).toEqual([]);
    expect(s.amountOnRecord(first)).toBe("0");
    expect(await s.round()).toEqual({ raised: [], calls: ["look"] }); // and is not read through again for it
  });

  it("says nothing about what other people pay in, and reads nothing more for it", async () => {
    let mine = "", theirs = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100)); theirs = c.account(payer, usdc(500)); });
    s.chain.transfer(payer, [[theirs, mine, usdc(40)]]);
    const r = await s.round();
    expect(r).toEqual({ raised: [], calls: ["look", "list:wallet"] });
    expect(s.amountOnRecord(mine)).toBe(String(usdc(140)));
    // spending of its own and a payment in, between two reads: what the wallet took out covers what is missing
    s.chain.transfer(wallet.publicKey, [[mine, s.chain.account(friend, 0), usdc(10)]]);
    s.chain.transfer(payer, [[theirs, mine, usdc(3)]]);
    const both = await s.round();
    expect(both.raised).toEqual([]);
    expect(both.calls).not.toContain("list:account");
    expect(s.amountOnRecord(mine)).toBe(String(usdc(133)));
  });

  it("finds a taking among the wallet's own spending", async () => {
    let mine = "", theirs = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() }); theirs = c.account(thief, 0); });
    s.chain.transfer(wallet.publicKey, [[mine, s.chain.account(friend, 0), usdc(10)]]);
    const taking = s.chain.transfer(thief, [[mine, theirs, usdc(25)]]);
    const r = await s.round();
    // 35 are missing and the wallet's own transaction took 10: the account's list is read for the rest
    expect(r.calls).toEqual(["look", "list:wallet", "tx", "accounts", "accounts", "info", "list:account", "tx"]);
    expect(r.raised.map((e) => [e.signature, e.sentence.split(" left ")[0]])).toEqual([[taking, "25 USDC"]]);
    expect(s.amountOnRecord(mine)).toBe(String(usdc(65)));
  });

  it("reads everything else that happened to the account while it is there: a second taking behind a payment in", async () => {
    let mine = "", theirs = "", others = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() }); theirs = c.account(thief, 0); others = c.account(payer, usdc(50)); });
    const small = s.chain.transfer(thief, [[mine, theirs, usdc(5)]]);
    s.chain.transfer(payer, [[others, mine, usdc(5)]]);
    const large = s.chain.transfer(thief, [[mine, theirs, usdc(25)]]);
    const r = await s.round();
    // the newest alone accounts for the 25 that are missing; the two before it are read all the same
    expect(r.calls).toEqual(["look", "list:wallet", "list:account", "tx", "tx", "tx"]);
    expect(r.raised.map((e) => e.signature).sort()).toEqual([small, large].sort());
    expect(s.amountOnRecord(mine)).toBe(String(usdc(75)));
    expect(s.remembered()).toBe(0);
    expect(await s.round()).toEqual({ raised: [], calls: ["look"] });
  });

  it("tells at once of a taking that lands while it is reading, and not again on the next turn", async () => {
    let mine = "", theirs = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() }); theirs = c.account(thief, 0); });
    const first = s.chain.transfer(thief, [[mine, theirs, usdc(25)]]);
    let second = "";
    s.chain.afterLook = () => { second = s.chain.transfer(thief, [[mine, theirs, usdc(10)]]); };
    const r = await s.round();
    expect(r.calls).toEqual(["look", "list:wallet", "list:account", "tx", "tx"]);
    expect(r.raised.map((e) => e.signature).sort()).toEqual([first, second].sort());
    expect(s.amountOnRecord(mine)).toBe(String(usdc(75))); // what the look saw: the second is after it
    // the next look sees the rest gone, and what was read already accounts for it
    expect(await s.round()).toEqual({ raised: [], calls: ["look", "list:wallet"] });
    expect(s.amountOnRecord(mine)).toBe(String(usdc(65)));
    expect(s.remembered()).toBe(0);
  });

  it("does not tell of the same taking twice when it has to read it twice", async () => {
    let mine = "", theirs = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() }); theirs = c.account(thief, 0); });
    const shown = s.chain.transfer(thief, [[mine, theirs, usdc(25)]]);
    const hidden = s.chain.transfer(thief, [[mine, theirs, usdc(10)]], { listed: false });
    expect((await s.round()).raised.map((e) => e.signature)).toEqual([shown]);
    expect(s.store.record(W).unsettled).toBe(true); // ten are still missing
    s.restart(); // and what it read is forgotten
    const again = await s.round();
    expect(again.calls).toEqual(["look", "list:wallet", "list:account(bg)", "tx(bg)"]); // a second look, which gives way to other work
    expect(again.raised).toEqual([]);
    s.chain.txs.find((t) => t.signature === hidden)!.listed = true;
    expect((await s.round()).raised.map((e) => e.signature)).toEqual([hidden]);
    expect(s.kinds()).toEqual(["taken_by_permission:urgent", "taken_by_permission:urgent"]);
    expect(s.amountOnRecord(mine)).toBe(String(usdc(65)));
  });

  it("does not read again a transaction that did nothing to the account", async () => {
    let mine = "", theirs = "", a = "", b = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() }); theirs = c.account(thief, 0); a = c.account(payer, usdc(9)); b = c.account(payer, 0); });
    s.chain.transfer(payer, [[a, b, usdc(1)]], { also: [new PublicKey(mine)] }); // names the account and leaves it alone
    s.chain.transfer(thief, [[mine, theirs, usdc(25)]], { listed: false });
    expect(await s.round()).toEqual({ raised: [], calls: ["look", "list:wallet", "list:account", "tx"] });
    expect(await s.round()).toEqual({ raised: [], calls: ["look", "list:wallet", "list:account(bg)"] });
  });

  it("takes an answer from a node that is behind for what it is, and reads nothing over it", async () => {
    let mine = "", theirs = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100)); theirs = c.account(friend, 0); });
    const before = s.chain.asOfNow();
    s.chain.transfer(wallet.publicKey, [[mine, theirs, usdc(10)]]);
    await s.round();
    expect(s.amountOnRecord(mine)).toBe(String(usdc(90)));
    // the next look is answered as of before the wallet spent: the account seems to hold more again
    s.chain.behind = before;
    expect(await s.round()).toEqual({ raised: [], calls: ["look", "list:wallet"] });
    expect(s.amountOnRecord(mine)).toBe(String(usdc(90))); // the older answer is not taken for the newer
    // and the one after is current: nothing fell, and the account's own list is not asked for
    expect(await s.round()).toEqual({ raised: [], calls: ["look", "list:wallet"] });
    expect(await s.round()).toEqual({ raised: [], calls: ["look"] });
  });

  it("in a wallet with more token accounts than a look takes in, looks first at the ones somebody may spend from", async () => {
    let theirs = "";
    const s = await watched((c) => { for (let i = 0; i < 130; i++) c.account(wallet.publicKey, usdc(1)); theirs = c.account(thief, 0); });
    // the permission is on the account a look sorted by address alone would never reach
    const mine = Object.keys(s.store.record(W).tokenAccounts).sort().at(-1)!;
    s.chain.accounts.get(mine)!.delegate = thief.toBase58();
    const record = s.store.record(W); record.tokenAccounts[mine]!.delegate = thief.toBase58(); s.store.save(W, record);
    await s.round(); // the look now takes that account in, which is a different look: one pass
    expect(await s.round()).toEqual({ raised: [], calls: ["look"] });
    const signature = s.chain.transfer(thief, [[mine, theirs, usdc(1)]]);
    const r = await s.round();
    expect(r.calls).toEqual(["look", "list:wallet", "list:account", "tx"]);
    expect(r.raised.map((e) => e.signature)).toEqual([signature]);
  });

  it("and then at the ones that hold something, before the empty ones", async () => {
    let theirs = "";
    // forty empty accounts (old airdrops, sold positions) and ninety that hold something: the ninety fit in a look
    const s = await watched((c) => { for (let i = 0; i < 130; i++) c.account(wallet.publicKey, i < 40 ? 0 : usdc(1)); theirs = c.account(thief, 0); });
    const holding = Object.entries(s.store.record(W).tokenAccounts).filter(([, a]) => a.amount !== "0").map(([a]) => a).sort();
    expect(holding).toHaveLength(90);
    const signature = s.chain.transfer(thief, [[holding.at(-1)!, theirs, usdc(1)]]);
    const r = await s.round();
    expect(r.raised.map((e) => e.signature)).toEqual([signature]);
    expect(r.calls).toEqual(["look", "list:wallet", "list:account", "tx"]);
  });

  it("finds a taking from an account no look takes in when the wallet's accounts are next read", async () => {
    let theirs = "";
    const s = await watched((c) => { for (let i = 0; i < 130; i++) c.account(wallet.publicKey, usdc(1)); theirs = c.account(thief, 0); });
    const mine = Object.keys(s.store.record(W).tokenAccounts).sort().at(-1)!;
    const signature = s.chain.transfer(thief, [[mine, theirs, usdc(1)]]); // no permission on record: a power of the token's issuer, say
    const found: number[] = [];
    let calls: string[] = [];
    for (let turn = 1; turn <= 20; turn++) { const r = await s.round(); if (r.raised.length) { found.push(turn); calls = r.calls; expect(r.raised.map((e) => [e.signature, e.sentence])).toEqual([[signature, `1 USDC left your wallet in a transaction your wallet did not sign. ${short(thief.toBase58())} signed it.`]]); } }
    // not on the next turn: on the second of the wallet's now-and-then passes, which is when its accounts are a quarter of an hour old
    expect(found).toEqual([20]);
    expect(calls).toEqual(["look", "list:wallet", "accounts", "accounts", "info", "list:account", "tx"]);
  });

  it("tells of one transaction that empties several accounts once, and reads it once", async () => {
    const mine: string[] = []; let theirs = "", theirBonk = "";
    const s = await watched((c) => {
      mine.push(c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() }), c.account(wallet.publicKey, usdc(7), { delegate: thief.toBase58() }), c.account(wallet.publicKey, 5_000_000, { delegate: thief.toBase58(), mint: BONK, decimals: 5 }));
      theirs = c.account(thief, 0); theirBonk = c.account(thief, 0, { mint: BONK, decimals: 5 });
    });
    s.chain.transfer(thief, [[mine[0]!, theirs, usdc(100)], [mine[1]!, theirs, usdc(7)], [mine[2]!, theirBonk, 5_000_000]]);
    const r = await s.round();
    expect(r.calls).toEqual(["look", "list:wallet", "list:account", "tx"]); // the other two accounts are explained by the same transaction
    expect(r.raised).toHaveLength(1);
    const amounts = r.raised[0]!.sentence.split(" left ")[0]!;
    // a token the engine has no name for is called by its mint
    expect(amounts.split(/, | and /).sort()).toEqual(["100 USDC", `50 token ${short(BONK)}`, "7 USDC"].sort());
    expect(amounts).toMatch(/^[^,]+, [^,]+ and [^,]+$/);
    for (const a of mine) expect(s.amountOnRecord(a)).toBe("0");
    expect(await s.round()).toEqual({ raised: [], calls: ["look"] });
  });

  it("names whose permission it went under when a program holds it and somebody else signed", async () => {
    let mine = "", theirs = "";
    const programAddress = key(81);
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: programAddress.toBase58() }); theirs = c.account(thief, 0); });
    s.chain.transfer(thief, [[mine, theirs, usdc(60)]], { authority: programAddress });
    const r = await s.round();
    expect(r.raised.map((e) => e.sentence)).toEqual([`60 USDC left your wallet in a transaction your wallet did not sign. It went under a permission to spend that your wallet gave ${short(programAddress.toBase58())} at some earlier time; ${short(thief.toBase58())} signed the transaction. Whatever that permission still covers can go the same way until your wallet revokes it.`]);
  });

  it("tells of a taking that does name the wallet once, as one of the wallet's transactions", async () => {
    let mine = "", theirs = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() }); theirs = c.account(thief, 0); });
    const signature = s.chain.transfer(thief, [[mine, theirs, usdc(25)]], { also: [wallet.publicKey] });
    const r = await s.round();
    expect(r.calls).not.toContain("list:account");
    expect(r.raised.map((e) => [e.signature, e.signals, e.level])).toEqual([[signature, ["taken_by_permission"], "urgent"]]);
    expect(s.amountOnRecord(mine)).toBe(String(usdc(75)));
    expect(await s.round()).toEqual({ raised: [], calls: ["look"] });
  });

  it("does not call a rescue this service sent a taking, and says nothing more of it: the owner was told when it was sent", async () => {
    let mine = "", vault = "";
    const ours = new Set<string>();
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: SD }); vault = c.account(key(91), 0); }, { sentinelDelegate: SD, ownRescues: ours });
    ours.add(s.chain.transfer(rescuer, [[mine, vault, usdc(100)]], { authority: new PublicKey(SD) }));
    const r = await s.round();
    expect(r.raised).toEqual([]);
    expect(r.calls).toEqual(["look", "list:wallet", "list:account", "tx"]);
    expect(s.amountOnRecord(mine)).toBe("0");
    expect(await s.round()).toEqual({ raised: [], calls: ["look"] });
  });

  it("a rescue somebody else started is said as one, once, and is no reason for another", async () => {
    // Another of the keys that may start a rescue did: nothing leaves a watched wallet unsaid, and a setup
    // the owner did not make would look exactly like this.
    let mine = "", vault = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: SD }); vault = c.account(key(91), 0); }, { sentinelDelegate: SD, sentinelVault: key(91).toBase58(), ownRescues: new Set() });
    const signature = s.chain.transfer(rescuer, [[mine, vault, usdc(100)]], { authority: new PublicKey(SD) });
    const r = await s.round();
    expect(r.raised.map((e) => [e.signals, e.level, e.signature, e.rescueWorthy])).toEqual([[["rescued"], "urgent", signature, false]]);
    expect(r.raised[0]!.sentence).toBe(`100 USDC left your wallet in a rescue that Sentinel did not start from here, and went into the Lamport Vault this wallet is set up for (${short(key(91).toBase58())}). Only that vault's key can move it on. If you did not set this wallet up for rescue, or that vault is not yours, treat the wallet as compromised.`);
    expect(s.told).toHaveLength(1);
    expect(await s.round()).toEqual({ raised: [], calls: ["look"] });
    s.restart();
    expect((await s.round()).raised).toEqual([]);
  });

  it("an account set up for rescue that is emptied to anywhere but the vault was robbed, not rescued", async () => {
    // A token whose issuer may move anyone's, or any other power over the account: the account still names
    // Sentinel's address as its delegate, and that says nothing about who took what was in it. Only tokens
    // that arrive in the wallet's own vault were rescued.
    let mine = "", theirs = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: SD }); theirs = c.account(thief, 0); c.account(key(91), 0); }, { sentinelDelegate: SD, sentinelVault: key(91).toBase58(), ownRescues: new Set() });
    const signature = s.chain.transfer(thief, [[mine, theirs, usdc(100)]]);
    const r = await s.round();
    expect(r.raised.map((e) => [e.signals, e.level, e.signature, e.rescueWorthy])).toEqual([[["taken_by_permission"], "urgent", signature, true]]);
    expect(r.raised[0]!.sentence).toContain("100 USDC left your wallet in a transaction your wallet did not sign.");
    expect(r.raised[0]!.sentence).not.toContain("rescue");
  });

  it("waits for an RPC that is behind, and tells the owner when the transaction shows", async () => {
    let mine = "", theirs = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() }); theirs = c.account(thief, 0); });
    const signature = s.chain.transfer(thief, [[mine, theirs, usdc(25)]], { listed: false });
    // the account holds less and no transaction says why yet: nothing is said, and what it held is kept to compare with
    expect(await s.round()).toEqual({ raised: [], calls: ["look", "list:wallet", "list:account"] });
    expect(s.amountOnRecord(mine)).toBe(String(usdc(100)));
    expect(s.store.record(W).unsettled).toBe(true);
    // its next turn looks again though its accounts are as the last look left them
    expect(await s.round()).toEqual({ raised: [], calls: ["look", "list:wallet", "list:account(bg)"] });
    // listed now, and not yet shown
    const tx = s.chain.txs.find((t) => t.signature === signature)!;
    tx.listed = true; tx.shown = false;
    expect(await s.round()).toEqual({ raised: [], calls: ["look", "list:wallet", "list:account(bg)", "tx(bg)"] });
    tx.shown = true;
    const r = await s.round();
    expect(r.raised.map((e) => [e.signature, e.level])).toEqual([[signature, "urgent"]]);
    expect(s.amountOnRecord(mine)).toBe(String(usdc(75)));
    expect(s.store.record(W).unsettled).toBeUndefined();
    expect(await s.round()).toEqual({ raised: [], calls: ["look"] });
  });

  it("says so when it cannot find the transaction after ten minutes, once", async () => {
    let mine = "", theirs = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() }); theirs = c.account(thief, 0); });
    s.chain.transfer(thief, [[mine, theirs, usdc(25)]], { listed: false });
    const rounds = EXPLAIN_FOR_SECONDS / 60;
    for (let i = 0; i < rounds; i++) expect((await s.round()).raised).toEqual([]);
    const r = await s.round();
    expect(r.raised).toHaveLength(1);
    expect(r.raised[0]).toMatchObject({ level: "alert", signals: ["unexplained_loss"], signature: "", rescueWorthy: false, sentence: "25 USDC left your wallet and Sentinel could not find the transaction that moved it. Your wallet's own transactions do not account for it. Look at the account's recent activity." });
    expect(s.amountOnRecord(mine)).toBe(String(usdc(75)));
    expect(s.store.record(W).unsettled).toBeUndefined();
    expect(await s.round()).toEqual({ raised: [], calls: ["look"] });
    expect(s.kinds()).toEqual(["unexplained_loss:alert"]);
  });

  it("reads so many accounts' lists in one pass and the rest on the next turn, and tells of every taking once", async () => {
    const mine: string[] = []; let theirs = "";
    const n = MOST_ACCOUNT_LISTS + 2;
    const s = await watched((c) => { for (let i = 0; i < n; i++) mine.push(c.account(wallet.publicKey, usdc(10 + i), { delegate: thief.toBase58() })); theirs = c.account(thief, 0); });
    const takings = mine.map((a, i) => s.chain.transfer(thief, [[a, theirs, usdc(1 + i)]]));
    const first = await s.round();
    expect(first.calls.filter((c) => c === "list:account")).toHaveLength(MOST_ACCOUNT_LISTS);
    expect(first.raised).toHaveLength(MOST_ACCOUNT_LISTS);
    expect(s.store.record(W).unsettled).toBe(true);
    const second = await s.round();
    expect(second.calls.filter((c) => c.startsWith("list:account"))).toHaveLength(2);
    expect(second.raised).toHaveLength(2);
    expect([...first.raised, ...second.raised].map((e) => e.signature).sort()).toEqual([...takings].sort());
    expect(s.store.record(W).unsettled).toBeUndefined();
    expect(await s.round()).toEqual({ raised: [], calls: ["look"] });
  });

  it("waits for the wallet's own list to be read through before it looks elsewhere, and remembers what it read", async () => {
    let mine = "", theirs = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(1000)); theirs = c.account(friend, 0); });
    const sends = MOST_PER_PASS + 5;
    for (let i = 0; i < sends; i++) s.chain.transfer(wallet.publicKey, [[mine, theirs, usdc(1)]]);
    // one pass reads so many of the wallet's transactions; the account already holds less than those explain
    const first = await s.round();
    expect(first.calls.filter((c) => c === "tx")).toHaveLength(MOST_PER_PASS);
    expect(first.calls).not.toContain("list:account");
    expect(s.amountOnRecord(mine)).toBe(String(usdc(1000)));
    const second = await s.round();
    expect(second.calls.filter((c) => c === "tx")).toHaveLength(5);
    expect(second.calls).not.toContain("list:account");
    expect(s.amountOnRecord(mine)).toBe(String(usdc(1000 - sends)));
    expect([...first.raised, ...second.raised].filter((e) => e.signals.includes("taken_by_permission") || e.signals.includes("unexplained_loss"))).toEqual([]);
  });

  it("after the service starts again, reads the account's list to account for what it no longer remembers, and blames nobody", async () => {
    let mine = "", theirs = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(1000)); theirs = c.account(friend, 0); });
    const sends = MOST_PER_PASS + 5;
    for (let i = 0; i < sends; i++) s.chain.transfer(wallet.publicKey, [[mine, theirs, usdc(1)]]);
    await s.round();
    s.restart();
    const all: string[] = [];
    // the last five are read from the wallet's list; the twenty-five read before the restart, ten a turn, from the account's
    const turns: number[] = [];
    for (let i = 0; i < 3; i++) { const r = await s.round(); all.push(...r.raised.flatMap((e) => e.signals)); turns.push(r.calls.filter((c) => c.startsWith("tx")).length); }
    expect(turns).toEqual([5 + MOST_EXTRA_READS, MOST_EXTRA_READS, 5]);
    expect(all.filter((k) => k === "taken_by_permission" || k === "unexplained_loss")).toEqual([]);
    expect(s.amountOnRecord(mine)).toBe(String(usdc(1000 - sends)));
    expect(s.store.record(W).unsettled).toBeUndefined();
    expect((await s.round()).calls).toEqual(["look"]);
  });

  it("takes a record from before amounts were kept as it finds it", async () => {
    let mine = "", theirs = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() }); theirs = c.account(thief, 0); });
    const record = s.store.record(W);
    delete record.tokenAccounts[mine]!.amount; delete record.tokenAccounts[mine]!.slot;
    s.store.save(W, record);
    s.chain.transfer(thief, [[mine, theirs, usdc(25)]]); // before there was anything to compare with: not seen
    expect(await s.round()).toEqual({ raised: [], calls: ["look", "list:wallet"] });
    expect(s.amountOnRecord(mine)).toBe(String(usdc(75)));
    s.chain.transfer(thief, [[mine, theirs, usdc(5)]]);
    expect((await s.round()).raised.map((e) => e.sentence.split(" left ")[0])).toEqual(["5 USDC"]);
  });

  it("is not fooled by a transaction that failed, or by one from before the amount on record", async () => {
    let mine = "", theirs = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() }); theirs = c.account(thief, 0); });
    s.chain.transfer(thief, [[mine, theirs, usdc(25)]]);
    expect((await s.round()).raised).toHaveLength(1);
    // a failed attempt, then a real taking: the old taking and the failure are in the account's list and are not read again
    s.chain.transfer(thief, [[mine, theirs, usdc(50)]], { failed: true });
    const real = s.chain.transfer(thief, [[mine, theirs, usdc(10)]]);
    const r = await s.round();
    expect(r.calls).toEqual(["look", "list:wallet", "list:account", "tx"]);
    expect(r.raised.map((e) => e.signature)).toEqual([real]);
    expect(s.amountOnRecord(mine)).toBe(String(usdc(65)));
  });
});

describe("when someone tries to hide it", () => {
  it("reads what happened to the account oldest first, so nothing sent after a taking buries it", async () => {
    let mine = "", theirs = "", dust = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() }); theirs = c.account(thief, 0); dust = c.account(payer, usdc(5)); });
    const taking = s.chain.transfer(thief, [[mine, theirs, usdc(25)]]);
    for (let i = 0; i < 120; i++) s.chain.transfer(payer, [[dust, mine, 1]]); // more than the reads of many passes
    const r = await s.round();
    expect(r.raised.map((e) => [e.signature, e.level])).toEqual([[taking, "urgent"]]);
    expect(r.calls.filter((c) => c === "tx")).toHaveLength(MOST_EXTRA_READS); // and no more read than a pass reads
    // the taking and nine of the payments in account for the fall: the rest of them are not read at all
    expect(await s.round()).toEqual({ raised: [], calls: ["look"] });
    expect(s.amountOnRecord(mine)).toBe(String(usdc(75) + 120));
  });

  it("goes as far back in the account's list as the amount on record, however much was sent since", async () => {
    let mine = "", theirs = "", dust = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() }); theirs = c.account(thief, 0); dust = c.account(payer, usdc(5)); });
    const taking = s.chain.transfer(thief, [[mine, theirs, usdc(25)]]);
    for (let i = 0; i < 1100; i++) s.chain.transfer(payer, [[dust, mine, 1]]); // more than one answer of the list holds
    const r = await s.round();
    expect(r.calls.filter((c) => c === "list:account")).toHaveLength(2);
    expect(r.raised.map((e) => e.signature)).toEqual([taking]);
  });

  it("does not wait long for a wallet's own list that someone keeps full", async () => {
    let mine = "", theirs = "", a = "", b = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() }); theirs = c.account(thief, 0); a = c.account(payer, usdc(1)); b = c.account(payer, 0); });
    const taking = s.chain.transfer(thief, [[mine, theirs, usdc(25)]]);
    const flood = () => { for (let k = 0; k < MOST_PER_PASS + 5; k++) s.chain.transfer(payer, [[a, b, 1]], { also: [wallet.publicKey] }); };
    const turns: string[] = [];
    for (let i = 0; i < 16; i++) { flood(); const r = await s.round(); turns.push(r.raised.map((e) => `${e.signals.join("+")}:${e.level}${e.signature === taking ? "!" : ""}`).join(",") || "-"); }
    // the taking is told of two minutes in, with the wallet's list still unread
    const at = turns.indexOf("taken_by_permission:urgent!");
    expect(at).toBe(WAIT_FOR_OWN_SECONDS / 60);
    expect(s.store.record(W).more).toBe(true);
    // and ten minutes in, that the wallet is being named in more than can be read: once
    expect(turns.filter((t) => t === "watch_behind:alert")).toHaveLength(1);
    expect(turns.indexOf("watch_behind:alert")).toBe(BEHIND_AFTER_SECONDS / 60);
    expect(s.told.at(-1)!.sentence).toMatch(/^Your wallet is being named in more transactions than Sentinel can read at once: \d+ are waiting, and alerts about them will be late\. If you are not expecting that much activity, someone may be trying to delay the reading of one of them\.$/);
    expect(s.kinds().sort()).toEqual(["taken_by_permission:urgent", "watch_behind:alert"]);
    expect(BEHIND_EVERY_SECONDS).toBe(6 * 3600);
  });

  it("tells of a taking that names the wallet from the account's list, when the wallet's own list never shows it, and not again when it does", async () => {
    let mine = "", theirs = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() }); theirs = c.account(thief, 0); });
    // as when a thousand transactions that name the wallet land after it: the wallet's list no longer reaches back to it
    const taking = s.chain.transfer(thief, [[mine, theirs, usdc(25)]], { also: [wallet.publicKey], hiddenFrom: [W] });
    const r = await s.round();
    expect(r.calls).toEqual(["look", "list:wallet", "list:account", "tx"]);
    expect(r.raised.map((e) => [e.signature, e.signals, e.level])).toEqual([[taking, ["taken_by_permission"], "urgent"]]);
    // the wallet's list shows it after all (another node, a longer list). Nothing of the wallet's has moved,
    // so it is read at the wallet's next now-and-then pass: read there, and said once
    s.chain.txs.find((t) => t.signature === taking)!.hiddenFrom = [];
    const later: string[] = [];
    for (let i = 0; i < 10; i++) { const again = await s.round(); expect(again.raised).toEqual([]); later.push(...again.calls); }
    expect(later.filter((c) => c === "tx")).toHaveLength(1);
    expect(s.kinds()).toEqual(["taken_by_permission:urgent"]);
  });

  it("reads a flooded wallet's transactions in order and skips none: a thief with the key cannot bury his own", async () => {
    let mine = "", theirs = "", a = "", b = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100)); theirs = c.account(thief, 0); a = c.account(payer, usdc(5)); b = c.account(payer, 0); }, { drainers: [thief.toBase58()] });
    // the wallet's own key sends its tokens to a known drainer, and then 1,001 transactions name the wallet
    const drain = s.chain.transfer(wallet.publicKey, [[mine, theirs, usdc(100)]]);
    for (let k = 0; k < 1001; k++) s.chain.transfer(payer, [[a, b, 1]], { also: [wallet.publicKey] });
    const r = await s.round();
    // the list is followed back past the thousand to where reading stopped, and the oldest is read first
    expect(r.calls.filter((c) => c === "list:wallet")).toHaveLength(2);
    expect(r.calls.filter((c) => c === "tx").length).toBe(MOST_PER_PASS);
    const told = r.raised.map((e) => [e.signals.join("+"), e.level, e.signature]);
    expect(told).toContainEqual(["known_drainer", "urgent", drain]);
    // and the owner hears that the wallet is behind, in words that say nothing was passed over
    expect(r.raised.find((e) => e.signals.includes("watch_behind"))).toMatchObject({ level: "alert", sentence: "More than a thousand transactions have named your wallet since Sentinel last read it. It reads them in order, none is skipped, and it is behind: alerts about them will be late. If you are not expecting that much activity, someone may be trying to delay the reading of one of them." });
    // not said again for six hours, though it stays behind and goes on reading without asking for the list again
    const next = await s.round();
    expect(next.raised.filter((e) => e.signals.includes("watch_behind"))).toEqual([]);
    expect(next.calls.filter((c) => c === "list:wallet")).toEqual([]);
    expect(next.calls.filter((c) => c === "tx").length).toBe(MOST_PER_PASS);
    expect(s.store.record(W).more).toBe(true);
  });

  it("follows the list back over several turns when it is very long, and still reads the oldest first", async () => {
    let mine = "", theirs = "", a = "", b = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100)); theirs = c.account(thief, 0); a = c.account(payer, usdc(5)); b = c.account(payer, 0); }, { drainers: [thief.toBase58()] });
    const drain = s.chain.transfer(wallet.publicKey, [[mine, theirs, usdc(100)]]);
    for (let k = 0; k < 3500; k++) s.chain.transfer(payer, [[a, b, 1]], { also: [wallet.publicKey] });
    // three pages a pass: the first pass does not reach where reading stopped, reads nothing, and says it is behind
    const first = await s.round();
    expect(first.calls.filter((c) => c === "list:wallet")).toHaveLength(3);
    expect(first.calls).not.toContain("tx");
    expect(first.raised.map((e) => e.signals.join("+"))).toEqual(["watch_behind"]);
    // the next goes on from where that stopped, reaches it, and reads the drain before any of what was sent to bury it
    const second = await s.round();
    expect(second.calls.filter((c) => c === "list:wallet")).toHaveLength(1);
    expect(second.raised.map((e) => [e.signals.join("+"), e.signature])).toContainEqual(["known_drainer", drain]);
  });

  it("says so when it cannot get back to where it stopped reading at all", async () => {
    let mine = "", theirs = "", a = "", b = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100)); theirs = c.account(thief, 0); a = c.account(payer, usdc(5)); b = c.account(payer, 0); }, { ownListPagesInAll: 2 });
    s.chain.transfer(payer, [[a, mine, 1]]);
    for (let k = 0; k < 2500; k++) s.chain.transfer(payer, [[a, b, 1]], { also: [wallet.publicKey] });
    const r = await s.round();
    expect(r.raised.map((e) => [e.signals.join("+"), e.level, e.sentence])).toEqual([["watch_behind", "alert", "Sentinel could not follow your wallet's transactions back to where it stopped reading: there are too many, or the RPC no longer has that far back. It has gone on from the oldest it could reach, and what came before that was not checked. If you are not expecting that much activity, someone may be trying to delay the reading of one of them."]]);
  });

  it("calls a fall behind a flood a taking, urgent, when it cannot read far enough to name anyone", async () => {
    let mine = "", theirs = "", dust = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() }); theirs = c.account(thief, 0); dust = c.account(payer, usdc(5)); });
    // the flood first and the taking behind it: read oldest first, ten a pass, ten minutes do not reach it
    for (let i = 0; i < 150; i++) s.chain.transfer(payer, [[dust, mine, 1]]);
    s.chain.transfer(thief, [[mine, theirs, usdc(25)]]);
    const rounds = EXPLAIN_FOR_SECONDS / 60;
    for (let i = 0; i < rounds; i++) expect((await s.round()).raised).toEqual([]);
    const r = await s.round();
    expect(r.raised).toHaveLength(1);
    expect(r.raised[0]).toMatchObject({ level: "urgent", signals: ["unexplained_loss"], rescueWorthy: true });
    // what is missing is said against what the payments in that were read added
    expect(r.raised[0]!.sentence).toMatch(/^25 USDC left your wallet and your wallet's own transactions do not account for it\. So many transactions were sent to your wallet or to that account at the same time that Sentinel could not read them all, which is a way to hide one\. If anyone holds a permission to spend from that account, revoke it\.$/);
    expect(s.store.record(W).unsettled).toBeUndefined();
  });

  it("gives each account its turn when more of them hold less than one pass looks into, and gives up on none before its turn", async () => {
    const mine: string[] = []; let theirs = "";
    const n = MOST_ACCOUNT_LISTS * 2;
    const s = await watched((c) => { for (let i = 0; i < n; i++) mine.push(c.account(wallet.publicKey, usdc(10), { delegate: thief.toBase58() })); theirs = c.account(thief, 0); });
    // every taking is where the RPC does not show it yet
    const takings = mine.map((a) => s.chain.transfer(thief, [[a, theirs, usdc(1)]], { listed: false }));
    const looked = new Set<string>();
    for (let i = 0; i < 2; i++) { await s.round(); for (const [a, t] of Object.entries(s.store.record(W).tokenAccounts)) if (t.lookedAt) looked.add(a); }
    expect(looked.size).toBe(n); // two passes, five each: all ten, not the same five twice
    for (const t of s.chain.txs) if (takings.includes(t.signature)) t.listed = true;
    const found: string[] = [];
    for (let i = 0; i < 2; i++) found.push(...(await s.round()).raised.map((e) => e.signature));
    expect(found.sort()).toEqual([...takings].sort());
    expect(s.store.record(W).unsettled).toBeUndefined();
  });
});

describe("a wallet's own doing is not called a theft", () => {
  it("when it transacts faster than it can be read, for as long as it likes", async () => {
    let mine = "", theirs = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100_000)); theirs = c.account(friend, 0); });
    const kinds: string[] = [];
    // forty payments a turn, twenty-five read a turn, for a quarter of an hour: it only ever falls further behind
    for (let turn = 0; turn < 15; turn++) {
      for (let k = 0; k < 40; k++) s.chain.transfer(wallet.publicKey, [[mine, theirs, usdc(1)]]);
      kinds.push(...(await s.round()).raised.flatMap((e) => e.signals));
    }
    expect(kinds.filter((k) => k === "taken_by_permission" || k === "unexplained_loss")).toEqual([]);
    // what its owner hears is that it is behind, once
    expect(kinds.filter((k) => k === "watch_behind")).toHaveLength(1);
    expect(s.store.record(W).more).toBe(true);
  }, 30_000);

  it("when it is come back to after hours unread: what its accounts hold is taken as it is found", async () => {
    let mine = "", theirs = "", others = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(1000)); theirs = c.account(friend, 0); others = c.account(payer, usdc(500)); });
    // weeks of its own payments, and of other people paying in, while nobody was reading
    for (let k = 0; k < 150; k++) { s.chain.transfer(wallet.publicKey, [[mine, theirs, usdc(2)]]); s.chain.transfer(payer, [[others, mine, usdc(1)]]); }
    s.away(STALE_AFTER_SECONDS + 60);
    const kinds: string[] = [], calls: string[] = [];
    for (let turn = 0; turn < 14; turn++) { const r = await s.round(); kinds.push(...r.raised.flatMap((e) => e.signals)); calls.push(...r.calls); }
    expect(kinds.filter((k) => k === "taken_by_permission" || k === "unexplained_loss")).toEqual([]);
    expect(calls.filter((c) => c.startsWith("list:account"))).toEqual([]); // nothing was looked into: there was nothing to explain
    expect(s.amountOnRecord(mine)).toBe(String(usdc(1000 - 150)));
    // and from then on it is compared again as ever
    const taker = s.chain.account(thief, 0);
    s.chain.accounts.get(mine)!.delegate = thief.toBase58();
    const taking = s.chain.transfer(thief, [[mine, taker, usdc(5)]]);
    const after: string[] = [];
    for (let turn = 0; turn < 12 && !after.includes(taking); turn++) after.push(...(await s.round()).raised.filter((e) => e.signals.includes("taken_by_permission")).map((e) => e.signature));
    expect(after).toEqual([taking]);
  }, 30_000);
});

describe("one wallet's trouble is not everyone's", () => {
  it("looks a second time at a fall it could not explain only when the RPC has nothing else to do, and counts every page it asks for", async () => {
    let mine = "", theirs = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() }); theirs = c.account(thief, 0); });
    s.chain.transfer(thief, [[mine, theirs, usdc(25)]], { listed: false });
    // the first look into it is news
    expect((await s.round()).calls).toEqual(["look", "list:wallet", "list:account"]);
    // the second, and every one after, gives way
    expect((await s.round()).calls).toEqual(["look", "list:wallet", "list:account(bg)"]);
    const tx = s.chain.txs.find((t) => !t.listed)!;
    tx.listed = true;
    const found = await s.round();
    expect(found.calls).toEqual(["look", "list:wallet", "list:account(bg)", "tx(bg)"]);
    expect(found.raised).toHaveLength(1);
  });

  it("asks for five pages of account lists in a pass and no more, however many accounts and however long their lists", async () => {
    const mine: string[] = []; let theirs = "", dust = "";
    const s = await watched((c) => { for (let i = 0; i < 4; i++) mine.push(c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58() })); theirs = c.account(thief, 0); dust = c.account(payer, usdc(50)); });
    // each of four accounts: a taking, and more than a page of dust after it
    for (const a of mine) { s.chain.transfer(thief, [[a, theirs, usdc(1)]]); for (let k = 0; k < 1001; k++) s.chain.transfer(payer, [[dust, a, 1]]); }
    const r = await s.round();
    expect(r.calls.filter((c) => c.startsWith("list:account"))).toHaveLength(MOST_ACCOUNT_LISTS);
    expect(r.calls.filter((c) => c.startsWith("tx")).length).toBeLessThanOrEqual(MOST_EXTRA_READS);
    expect(s.store.record(W).unsettled).toBe(true);
  }, 30_000);
});

describe("a thousand token accounts opened in a wallet's name", () => {
  it("do not push the one worth watching off the record", async () => {
    // an address that sorts after every other: by address alone it would be the first to go
    let last = "";
    while (!/^[x-z]/.test(last)) last = Keypair.generate().publicKey.toBase58();
    let theirs = "", pays = "";
    const s = await watched((c) => { const before = () => { let a = ""; do a = Keypair.generate().publicKey.toBase58(); while (a >= last); return a; };
      c.account(wallet.publicKey, usdc(100), { delegate: thief.toBase58(), address: last }); c.account(wallet.publicKey, usdc(7), { address: before() }); theirs = c.account(thief, 0); pays = c.account(friend, 0); });
    // anyone can open token accounts for a wallet, for a little rent: a thousand of them, empty, every one sorting before it
    for (let i = 0; i < MAX_TOKEN_ACCOUNTS; i++) { let address = ""; do address = Keypair.generate().publicKey.toBase58(); while (address >= last); s.chain.account(wallet.publicKey, 0, { address }); }
    // the wallet does something, and its accounts are read in full
    const spare = Object.keys(s.store.record(W).tokenAccounts).find((a) => a !== last)!;
    s.chain.transfer(wallet.publicKey, [[spare, pays, usdc(1)]]);
    await s.round();
    const kept = Object.keys(s.store.record(W).tokenAccounts);
    expect(kept).toHaveLength(MAX_TOKEN_ACCOUNTS);
    expect(kept.sort().at(-1)).toBe(last); // it sorts last and is still there
    expect(kept).toContain(spare); // and so is the other one that was already on record
    // and a taking from it is still told of
    const taking = s.chain.transfer(thief, [[last, theirs, usdc(100)]]);
    expect((await s.round()).raised.map((e) => e.signature)).toEqual([taking]);
  }, 30_000);
});

describe("a sale of something the owner listed", () => {
  const market = key(81);
  async function listed() {
    let nft = "", buyers = "", other = "", lent = "", third = "";
    const s = await watched((c) => {
      nft = c.account(wallet.publicKey, 1, { delegate: market.toBase58(), mint: BONK, decimals: 0 }); other = c.account(wallet.publicKey, 1, { delegate: market.toBase58(), mint: USDC, decimals: 0 });
      third = c.account(wallet.publicKey, 1, { delegate: market.toBase58(), mint: BONK, decimals: 0 });
      lent = c.account(wallet.publicKey, usdc(50), { delegate: thief.toBase58() }); // and a permission of another kind, held by someone else
      buyers = c.account(friend, 0, { mint: BONK, decimals: 0 });
    });
    return { ...s, nft, buyers, other, lent, third };
  }

  it("is told as what it is to the eye, a taking, with what the wallet was paid in the same transaction", async () => {
    const s = await listed();
    const sale = s.chain.transfer(friend, [[s.nft, s.buyers, 1]], { authority: market, also: [wallet.publicKey], pays: [wallet.publicKey, 2_500_000_000] });
    const r = await s.round();
    expect(r.raised.map((e) => [e.signature, e.level, e.takers])).toEqual([[sale, "urgent", [market.toBase58()]]]);
    expect(r.raised[0]!.sentence).toBe(`1 token ${short(BONK)} left your wallet in a transaction your wallet did not sign. It went under a permission to spend that your wallet gave ${short(market.toBase58())} at some earlier time; ${short(friend.toBase58())} signed the transaction. Whatever that permission still covers can go the same way until your wallet revokes it. Your wallet received 2.5 SOL in the same transaction.`);
  });

  it("does not make anyone familiar when it went under two permissions at once: a thief's old approval can ride in a sale", async () => {
    const s = await listed();
    // the buyer's transaction takes the listed token under the marketplace's permission, and one unit under the thief's
    const both = s.chain.transfer(friend, [[s.nft, s.buyers, 1], [s.lent, s.chain.account(thief, 0), 1]], { authority: market, also: [wallet.publicKey], pays: [wallet.publicKey, 2_500_000_000] });
    const r = await s.round();
    expect(r.raised[0]!.takers!.sort()).toEqual([market.toBase58(), thief.toBase58()].sort());
    expect(await s.thisWasMe(both)).toBe(true);
    expect(s.store.record(W).trustedTakers ?? []).toEqual([]);
    // so the thief's next taking is as loud as his first
    s.chain.transfer(thief, [[s.lent, s.chain.account(thief, 0), usdc(10)]]);
    expect((await s.round()).raised.map((e) => e.level)).toEqual(["urgent"]);
  });

  it("is not softened by a payment, which a thief can make as well as a buyer", async () => {
    const s = await listed();
    s.chain.transfer(thief, [[s.nft, s.buyers, 1]], { authority: market, also: [wallet.publicKey], pays: [wallet.publicKey, 1] });
    const r = await s.round();
    expect(r.raised[0]).toMatchObject({ level: "urgent", rescueWorthy: true });
    expect(r.raised[0]!.sentence).toContain("Your wallet received 1 lamports in the same transaction.");
  });

  it("becomes ordinary when the owner says the first one was theirs: the next under the same permission is a line on the page", async () => {
    const s = await listed();
    const first = s.chain.transfer(friend, [[s.nft, s.buyers, 1]], { authority: market, also: [wallet.publicKey], pays: [wallet.publicKey, 2_500_000_000] });
    await s.round();
    expect(await s.thisWasMe(first)).toBe(true);
    expect(s.store.record(W).trustedTakers).toEqual([market.toBase58()]);
    const told = s.told.length;
    const second = s.chain.transfer(friend, [[s.other, s.chain.account(friend, 0), 1]], { authority: market, also: [wallet.publicKey], pays: [wallet.publicKey, 1_000_000_000] });
    const r = await s.round();
    expect(r.raised.map((e) => [e.signature, e.level, e.rescueWorthy])).toEqual([[second, "info", false]]);
    expect(r.raised[0]!.sentence).toContain("You have said that what this permission takes is your doing.");
    expect(s.told).toHaveLength(told); // on the page, and nobody's phone rings
    // and the same when the sale does not name the wallet at all, and is come upon in the token account's own list
    const quiet = s.chain.transfer(friend, [[s.third, s.chain.account(friend, 0, { mint: BONK, decimals: 0 }), 1]], { authority: market });
    expect((await s.round()).raised.map((e) => [e.signature, e.level])).toEqual([[quiet, "info"]]);
    expect(s.told).toHaveLength(told);
    // somebody else's permission is still what it was
    s.chain.transfer(thief, [[s.lent, s.chain.account(thief, 0), usdc(50)]]);
    expect((await s.round()).raised.map((e) => [e.level, e.takers])).toEqual([["urgent", [thief.toBase58()]]]);
  });
});

describe("the sentence", () => {
  const account = (delegate: string | null, mint = USDC): TokenAccountState => ({ address: "", mint, owner: W, delegate, closeAuthority: null });
  /** A taking as the watcher reads it from the chain, and the accounts on record it is judged against. */
  function taking(moves: number, opts: { delegates?: (string | null)[]; authority?: PublicKey; also?: PublicKey[] } = {}) {
    const chain = new Chain();
    const theirs = chain.account(thief, 0);
    const onRecord: Record<string, TokenAccountState> = {};
    const list: [string, string, number][] = [];
    for (let i = 0; i < moves; i++) {
      const delegate = opts.delegates ? opts.delegates[i] ?? null : thief.toBase58();
      const a = chain.account(wallet.publicKey, usdc(100), delegate ? { delegate } : {});
      onRecord[a] = { ...account(delegate), address: a };
      list.push([a, theirs, usdc(i + 1)]);
    }
    const signature = chain.transfer(thief, list, opts);
    return { tx: fromRpc(signature, chain.txs[0]!.result)!, onRecord };
  }
  const START = (what: string) => `${what} left your wallet in a transaction your wallet did not sign.`;

  it("says who signed when no permission is on record", () => {
    const t = taking(1, { delegates: [null] });
    expect(assessTaken(t.tx, { wallet: W, tokenAccounts: t.onRecord }).sentence).toBe(`${START("1 USDC")} ${short(thief.toBase58())} signed it.`);
    // and without any record at all
    expect(assessTaken(t.tx, { wallet: W }).sentence).toBe(`${START("1 USDC")} ${short(thief.toBase58())} signed it.`);
  });

  it("speaks of permissions when more than one was used, and counts what it does not list", () => {
    const two = taking(2, { delegates: [thief.toBase58(), key(82).toBase58()] });
    expect(assessTaken(two.tx, { wallet: W, tokenAccounts: two.onRecord }).sentence).toBe(`${START("1 USDC and 2 USDC")} It went under permissions to spend that your wallet gave at some earlier time. Whatever those still cover can go the same way until your wallet revokes them.`);
    const five = taking(5);
    expect(assessTaken(five.tx, { wallet: W, tokenAccounts: five.onRecord }).sentence.split(" left ")[0]).toBe("1 USDC, 2 USDC, 3 USDC and 2 other tokens");
    const four = taking(4);
    expect(assessTaken(four.tx, { wallet: W, tokenAccounts: four.onRecord }).sentence.split(" left ")[0]).toBe("1 USDC, 2 USDC, 3 USDC and 1 other token");
  });

  it("is urgent, is a thing done to the wallet, and may start a rescue", () => {
    const t = taking(1);
    const a = assessTaken(t.tx, { wallet: W, tokenAccounts: t.onRecord });
    expect(a).toMatchObject({ level: "urgent", rescueWorthy: true });
    expect(a.signals).toMatchObject([{ kind: "taken_by_permission", level: "urgent", soft: false, byTable: true }]);
  });

  it("says the same of a transaction that names the wallet, wherever it is come upon, and nothing of one the wallet signed", () => {
    const t = taking(1, { also: [wallet.publicKey] });
    // found on the token account's list: judged by who signed it, not by whom it names
    expect(assessTaken(t.tx, { wallet: W, tokenAccounts: t.onRecord })).toMatchObject({ level: "urgent", sentence: expect.stringContaining("did it, using a permission to spend") });
    // the wallet's own payment, found the same way: its own business
    const chain = new Chain();
    const mine = chain.account(wallet.publicKey, usdc(10)), theirs = chain.account(friend, 0);
    const own = fromRpc(chain.transfer(wallet.publicKey, [[mine, theirs, usdc(1)]]), chain.txs[0]!.result)!;
    expect(assessTaken(own, { wallet: W }).level).toBeNull();
    const a = assessTransaction(t.tx, { wallet: W, baseline: Baseline.empty(), drainers: new Set(), tokenAccounts: t.onRecord });
    expect(a.signals.map((s) => s.kind)).toEqual(["taken_by_permission"]);
    expect(a.sentence).toContain(`${short(thief.toBase58())} did it, using a permission to spend`);
    // the owner's own browser saying "this was mine" does not make it theirs: the wallet did not sign it
    expect(assessTransaction(t.tx, { wallet: W, baseline: Baseline.empty(), drainers: new Set(), tokenAccounts: t.onRecord, ownerSigned: true }).level).toBe("urgent");
  });

  it("tells what the rescue permission moved apart from what was taken, and nothing of a rescue this service sent", () => {
    // (in these, what leaves goes to an account of the thief's: naming the thief as the vault is what makes it an arrival in the vault)
    const VAULT = thief.toBase58();
    const t = taking(2, { delegates: [SD, thief.toBase58()] });
    const mixed = assessTaken(t.tx, { wallet: W, sentinelDelegate: SD, rescueVault: VAULT, tokenAccounts: t.onRecord });
    expect(mixed.signals.map((s) => [s.kind, s.sentence.split(" left ")[0]])).toEqual([["taken_by_permission", "2 USDC"], ["rescued", "1 USDC"]]);
    // the taking is reason for a rescue; the rescue beside it is not what makes it one
    expect(mixed.rescueWorthy).toBe(true);
    const all = taking(2, { delegates: [SD, SD] });
    const elsewhere = assessTaken(all.tx, { wallet: W, sentinelDelegate: SD, rescueVault: VAULT, tokenAccounts: all.onRecord });
    expect([elsewhere.level, elsewhere.signals.map((s) => s.kind), elsewhere.rescueWorthy]).toEqual(["urgent", ["rescued"], false]);
    expect(assessTaken(all.tx, { wallet: W, sentinelDelegate: SD, rescueVault: VAULT, tokenAccounts: all.onRecord, ownRescues: new Set([all.tx.signature]) }).level).toBeNull();
    expect(assessTaken(all.tx, { wallet: W, sentinelDelegate: SD, rescueVault: VAULT, tokenAccounts: all.onRecord, ownRescues: new Set(["another"]) }).level).toBe("urgent");
    // Set up for rescue is not the same as rescued: what did not arrive in the vault the setup names was taken,
    // and is said as a taking, with everything a taking sets off.
    for (const ctx of [{ rescueVault: key(91).toBase58() }, {}]) {
      const robbed = assessTaken(all.tx, { wallet: W, sentinelDelegate: SD, tokenAccounts: all.onRecord, ...ctx });
      expect([robbed.level, robbed.signals.map((s) => s.kind), robbed.rescueWorthy]).toEqual(["urgent", ["taken_by_permission"], true]);
    }
    // someone else's delegate that happens to be on an unarmed wallet is not excused
    expect(assessTaken(all.tx, { wallet: W, tokenAccounts: all.onRecord }).level).toBe("urgent");
  });

  it("counts as taken only what left an account that was the wallet's and still is", () => {
    // an account that moved nothing, beside one that did
    const chain = new Chain();
    const theirs = chain.account(thief, 0), a = chain.account(wallet.publicKey, usdc(100)), b = chain.account(wallet.publicKey, usdc(50));
    chain.transfer(thief, [[a, theirs, usdc(25)], [b, theirs, 0]]);
    const quiet = fromRpc("s", chain.txs[0]!.result)!;
    expect(tokenLossesOf(quiet, W)).toEqual([{ account: a, mint: USDC, decimals: 6, lost: 25_000_000n }]);
    expect(assessTaken(quiet, { wallet: W }).sentence.split(" left ")[0]).toBe("25 USDC");

    // someone else's account that is gone after the transaction (they closed it) is not the wallet's loss
    const t = taking(1, { delegates: [null] });
    const closed = { ...t.tx, preTokenBalances: [...t.tx.preTokenBalances, { accountIndex: 0, mint: USDC, owner: payer.toBase58(), amount: "9000000", decimals: 6 }] };
    expect(tokenLossesOf(closed, W).map((l) => l.lost)).toEqual([1_000_000n]);

    // an account that went to someone else in the transaction is a handing over, told of as one
    const named = taking(1, { also: [wallet.publicKey] });
    const handed = { ...named.tx, postTokenBalances: named.tx.postTokenBalances.map((p) => (p.owner === W ? { ...p, owner: thief.toBase58() } : p)) };
    expect(tokenLossesOf(handed, W)).toEqual([]);
    expect(assessTransaction(handed, { wallet: W, baseline: Baseline.empty(), drainers: new Set(), tokenAccounts: named.onRecord }).signals.map((x) => x.kind)).toEqual(["authority_changed"]);
  });

  it("is ordinary only when every permission it went under is one the owner has called their own doing", () => {
    const other = key(82).toBase58();
    const two = taking(2, { delegates: [thief.toBase58(), other] });
    const ctx = { wallet: W, tokenAccounts: two.onRecord };
    expect(assessTaken(two.tx, { ...ctx, trustedTakers: new Set([thief.toBase58()]) })).toMatchObject({ level: "urgent", rescueWorthy: true });
    const both = assessTaken(two.tx, { ...ctx, trustedTakers: new Set([thief.toBase58(), other]) });
    expect(both).toMatchObject({ level: "info", rescueWorthy: false });
    expect(both.sentence).toContain("You have said that what this permission takes is your doing.");
    expect(both.signals[0]!.takers!.sort()).toEqual([thief.toBase58(), other].sort());
    // a taking nobody's permission explains is never ordinary, whatever is trusted
    const none = taking(1, { delegates: [null] });
    expect(assessTaken(none.tx, { wallet: W, tokenAccounts: none.onRecord, trustedTakers: new Set([thief.toBase58()]) }).level).toBe("urgent");
  });

  it("says what is missing when no transaction was found", () => {
    expect(assessUnexplainedLoss({ ...account(null), decimals: 6 }, 2_500_000n)).toMatchObject({ level: "alert", rescueWorthy: false, sentence: "2.5 USDC left your wallet and Sentinel could not find the transaction that moved it. Your wallet's own transactions do not account for it. Look at the account's recent activity." });
  });
});
