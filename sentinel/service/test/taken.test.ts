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
import { EXPLAIN_FOR_SECONDS, MOST_ACCOUNT_LISTS, MOST_EXTRA_READS, MOST_PER_PASS, Watcher, type Notifier } from "../src/watcher.js";

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
  txs: { signature: string; slot: number; names: string[]; result: any; failed: boolean; listed: boolean; shown: boolean }[] = [];
  calls: string[] = [];
  /** Something that happens on the chain just after the next look is answered. */
  afterLook: (() => void) | null = null;
  /** When set, the next look is answered by a node that has fallen behind: the accounts as they were when this was taken. */
  behind: { slot: number; lamports: number; amounts: Map<string, number> } | null = null;
  asOfNow() { return { slot: this.slot, lamports: this.lamports, amounts: new Map([...this.accounts].map(([a, t]) => [a, t.amount])) }; }
  private n = 0;

  account(owner: PublicKey | string, amount: number, opts: { delegate?: string; mint?: string; decimals?: number } = {}): string {
    const address = Keypair.generate().publicKey.toBase58();
    this.accounts.set(address, { mint: opts.mint ?? USDC, owner: typeof owner === "string" ? owner : owner.toBase58(), amount, delegate: opts.delegate ?? null, decimals: opts.decimals ?? 6 });
    return address;
  }

  /**
   * A transaction `signer` signs and pays for, which moves tokens: each move is [from, to, amount]. `authority`
   * is whose permission it goes under when that is not the signer (a program's address). `also` are addresses
   * it names without needing them.
   */
  transfer(signer: PublicKey, moves: [string, string, number][], opts: { authority?: PublicKey; also?: PublicKey[]; failed?: boolean; listed?: boolean; shown?: boolean } = {}): string {
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
    this.txs.push({
      signature, slot: this.slot, names, failed: opts.failed ?? false, listed: opts.listed ?? true, shown: opts.shown ?? true,
      result: { slot: this.slot, blockTime: T0, transaction: [Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64"), "base64"], meta: { err: opts.failed ? { InstructionError: [0, "Custom"] } : null, fee: 5000, preBalances: lamports, postBalances: lamports.map((l, i) => (i === 0 ? l - 5000 : l)), preTokenBalances: pre, postTokenBalances: post } },
    });
    return signature;
  }

  private info(a: Account) { return { mint: a.mint, owner: a.owner, state: "initialized", tokenAmount: { amount: String(a.amount), decimals: a.decimals }, ...(a.delegate ? { delegate: a.delegate, delegatedAmount: { amount: "18446744073709551615" } } : {}) }; }

  async call(method: string, params: any[]): Promise<any> {
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
        this.calls.push(params[0] === W ? "list:wallet" : "list:account");
        const { limit = 1000, before, until } = params[1] ?? {};
        let list = this.txs.filter((t) => t.listed && t.names.includes(params[0])).reverse();
        if (before) list = list.slice(list.findIndex((t) => t.signature === before) + 1);
        if (until) { const i = list.findIndex((t) => t.signature === until); if (i >= 0) list = list.slice(0, i); }
        return list.slice(0, limit).map((t) => ({ signature: t.signature, slot: t.slot, err: t.failed ? { InstructionError: [0, "Custom"] } : null }));
      }
      case "getTransaction": { this.calls.push("tx"); const t = this.txs.find((x) => x.signature === params[0]); return t && t.shown ? t.result : null; }
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
async function watched(build: (chain: Chain) => void, opts: { sentinelDelegate?: string } = {}) {
  const chain = new Chain();
  build(chain);
  const store = new MemoryStore([{ address: W, ...(opts.sentinelDelegate ? { sentinelDelegate: opts.sentinelDelegate } : {}) }]);
  let now = T0;
  const told: { level: string; sentence: string }[] = [];
  const notifier: Notifier = { notify: async (_w, level, sentence) => { told.push({ level, sentence }); } };
  const make = () => new Watcher(chain, store, notifier, { now: () => now });
  let watcher = make();
  await watcher.passAll(); await watcher.passAll();
  chain.took();
  return {
    chain, store, told,
    /** The wallet's next turn, a minute later. */
    round: async () => { now += 60; chain.slot += 10; const r = await watcher.passAll(); return { raised: r.raised, calls: chain.took() }; },
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
    expect(again.calls).toEqual(["look", "list:wallet", "list:account", "tx"]);
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
    expect(await s.round()).toEqual({ raised: [], calls: ["look", "list:wallet", "list:account"] });
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

  it("does not call Sentinel's own rescue a taking", async () => {
    let mine = "", vault = "";
    const s = await watched((c) => { mine = c.account(wallet.publicKey, usdc(100), { delegate: SD }); vault = c.account(key(91), 0); }, { sentinelDelegate: SD });
    s.chain.transfer(rescuer, [[mine, vault, usdc(100)]], { authority: new PublicKey(SD) });
    const r = await s.round();
    expect(r.raised).toEqual([]);
    expect(r.calls).toEqual(["look", "list:wallet", "list:account", "tx"]);
    expect(s.amountOnRecord(mine)).toBe("0");
    expect(await s.round()).toEqual({ raised: [], calls: ["look"] });
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
    expect(await s.round()).toEqual({ raised: [], calls: ["look", "list:wallet", "list:account"] });
    // listed now, and not yet shown
    const tx = s.chain.txs.find((t) => t.signature === signature)!;
    tx.listed = true; tx.shown = false;
    expect(await s.round()).toEqual({ raised: [], calls: ["look", "list:wallet", "list:account", "tx"] });
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
    expect(second.calls.filter((c) => c === "list:account")).toHaveLength(2);
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
    for (let i = 0; i < 3; i++) { const r = await s.round(); all.push(...r.raised.flatMap((e) => e.signals)); turns.push(r.calls.filter((c) => c === "tx").length); }
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

  it("leaves a transaction that names the wallet to the rules for the wallet's own, which say the same", () => {
    const t = taking(1, { also: [wallet.publicKey] });
    expect(assessTaken(t.tx, { wallet: W, tokenAccounts: t.onRecord }).level).toBeNull();
    const a = assessTransaction(t.tx, { wallet: W, baseline: Baseline.empty(), drainers: new Set(), tokenAccounts: t.onRecord });
    expect(a.signals.map((s) => s.kind)).toEqual(["taken_by_permission"]);
    expect(a.sentence).toContain(`${short(thief.toBase58())} did it, using a permission to spend`);
    // the owner's own browser saying "this was mine" does not make it theirs: the wallet did not sign it
    expect(assessTransaction(t.tx, { wallet: W, baseline: Baseline.empty(), drainers: new Set(), tokenAccounts: t.onRecord, ownerSigned: true }).level).toBe("urgent");
  });

  it("says nothing of what Sentinel's own delegate moved, and still tells of the rest", () => {
    const t = taking(2, { delegates: [SD, thief.toBase58()] });
    expect(assessTaken(t.tx, { wallet: W, sentinelDelegate: SD, tokenAccounts: t.onRecord }).sentence.split(" left ")[0]).toBe("2 USDC");
    const all = taking(2, { delegates: [SD, SD] });
    expect(assessTaken(all.tx, { wallet: W, sentinelDelegate: SD, tokenAccounts: all.onRecord }).level).toBeNull();
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

  it("says what is missing when no transaction was found", () => {
    expect(assessUnexplainedLoss({ ...account(null), decimals: 6 }, 2_500_000n)).toMatchObject({ level: "alert", rescueWorthy: false, sentence: "2.5 USDC left your wallet and Sentinel could not find the transaction that moved it. Your wallet's own transactions do not account for it. Look at the account's recent activity." });
  });
});
