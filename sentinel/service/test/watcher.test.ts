/**
 * The watcher against a chain it can only reach through an RPC: what it reads, in what order, what it raises,
 * and what it does when the RPC lets it down.
 */
import "../../../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { HttpRpc, type Rpc } from "../src/rpc.js";
import { FileStore, MemoryStore } from "../src/store.js";
import { NtfyNotifier, Watcher, type Notifier } from "../src/watcher.js";
import type { Level, TokenAccountState } from "../src/signals.js";

const wallet = Keypair.fromSeed(new Uint8Array(32).fill(7));
const W = wallet.publicKey.toBase58();
const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const friend = key(11), thief = key(66);
const SYSTEM = "11111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = 1_000_000_000;
const NOON = 1_794_312_000;
const delegate = key(90).toBase58();
const lookalike = (of: PublicKey) => new PublicKey(Buffer.from((BigInt("0x" + Buffer.from(of.toBytes()).toString("hex")) + 707281n * (1n << 80n)).toString(16).padStart(64, "0"), "hex"));

/** A chain as an RPC shows it: the wallet's transactions in order, its token accounts, and who owns the wallet account. */
class Chain implements Rpc {
  txs: { signature: string; result: any; visible: boolean }[] = [];
  tokenAccounts: TokenAccountState[] = [];
  walletOwner = SYSTEM;
  down = false;
  calls: string[] = [];
  private n = 0;

  /** A payment of `sol` from `from` to `to`, confirmed at `at`. */
  pay(from: PublicKey, to: PublicKey, sol: number, at: number, opts: { visible?: boolean } = {}): string {
    const raw = new Transaction({ feePayer: from, recentBlockhash: "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x" }).add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: Math.round(sol * SOL) })).serialize({ requireAllSignatures: false, verifySignatures: false });
    const signature = `sig${String(++this.n).padStart(4, "0")}`;
    const lamports = Math.round(sol * SOL);
    this.txs.push({ signature, visible: opts.visible ?? true, result: { slot: this.n, blockTime: at, transaction: [Buffer.from(raw).toString("base64"), "base64"], meta: { err: null, fee: 5000, preBalances: [20 * SOL, 0, 1], postBalances: [20 * SOL - lamports - 5000, lamports, 1], preTokenBalances: [], postTokenBalances: [] } } });
    return signature;
  }

  async call(method: string, params: any[]): Promise<any> {
    this.calls.push(method);
    if (this.down) throw new Error(`${method}: the RPC answered 503`);
    switch (method) {
      case "getSignaturesForAddress": {
        const { limit = 1000, before, until } = params[1] ?? {};
        let list = [...this.txs].reverse();
        if (before) list = list.slice(list.findIndex((t) => t.signature === before) + 1);
        if (until) { const i = list.findIndex((t) => t.signature === until); if (i >= 0) list = list.slice(0, i); }
        return list.slice(0, limit).map((t) => ({ signature: t.signature }));
      }
      case "getTransaction": { const t = this.txs.find((x) => x.signature === params[0]); return t && t.visible ? t.result : null; }
      case "getTokenAccountsByOwner":
        return { value: this.tokenAccounts.filter((a) => a.owner === params[0] && params[1].programId.startsWith("Tokenkeg")).map((a) => ({ pubkey: a.address, account: { data: { parsed: { info: { mint: a.mint, owner: a.owner, ...(a.delegate ? { delegate: a.delegate } : {}), ...(a.closeAuthority ? { closeAuthority: a.closeAuthority } : {}) } } } } })) };
      case "getAccountInfo": {
        if (params[0] === W) return { value: { owner: this.walletOwner } };
        const a = this.tokenAccounts.find((x) => x.address === params[0]);
        return { value: a ? { data: { parsed: { info: { mint: a.mint, owner: a.owner, ...(a.delegate ? { delegate: a.delegate } : {}) } } } } : null };
      }
      default: throw new Error(`unexpected ${method}`);
    }
  }
}

class Sent implements Notifier {
  list: [Level, string][] = [];
  fail = false;
  notify: Notifier["notify"] = async (_wallet, level, sentence) => { if (this.fail) throw new Error("push service down"); this.list.push([level, sentence]); };
}

/** A wallet with thirty days of payments to one friend, watched from now on. */
function setup(opts: { store?: MemoryStore } = {}) {
  const chain = new Chain();
  for (let i = 0; i < 30; i++) chain.pay(wallet.publicKey, friend, 0.2 + (i % 5) * 0.2, NOON - (30 - i) * 86_400 + ((i % 6) - 2) * 3600);
  chain.tokenAccounts = [{ address: key(21).toBase58(), mint: USDC, owner: W, delegate, closeAuthority: null }];
  const store = opts.store ?? new MemoryStore([{ address: W, sentinelDelegate: delegate }]);
  const sent = new Sent();
  let now = NOON;
  const watcher = new Watcher(chain, store, sent, { drainers: new Set([thief.toBase58()]), now: () => now });
  return { chain, store, sent, watcher, tick: (seconds: number) => { now += seconds; } };
}
const me = { address: W, sentinelDelegate: delegate };

describe("the watcher", () => {
  it("builds the baseline from history on its first pass and raises nothing for the past", async () => {
    const { chain, store, sent, watcher } = setup();
    chain.pay(wallet.publicKey, thief, 5, NOON - 40 * 86_400); // an old theft is history too
    chain.txs.unshift(chain.txs.pop()!);
    expect(await watcher.pass(me)).toEqual([]);
    expect(sent.list).toEqual([]);
    const r = store.record(W);
    expect(r.cursor).toBe(chain.txs.at(-1)!.signature);
    expect(r.baseline!.transactions).toBe(31);
    expect(r.lastSeenAt).toBe(NOON);
  });

  it("reads what is new, oldest first, says nothing about ordinary payments and learns from them", async () => {
    const { chain, store, sent, watcher } = setup();
    await watcher.pass(me);
    chain.pay(wallet.publicKey, friend, 0.4, NOON + 3600);
    chain.pay(wallet.publicKey, friend, 0.6, NOON + 7200);
    expect(await watcher.pass(me)).toEqual([]);
    expect(sent.list).toEqual([]);
    expect(store.record(W).baseline!.transactions).toBe(32);
    // nothing new: nothing fetched but the list, the accounts and the wallet
    chain.calls = [];
    await watcher.pass(me);
    expect(chain.calls).not.toContain("getTransaction");
  });

  it("raises a drain, tells the owner, and does not take the thief for someone the wallet pays", async () => {
    const { chain, store, sent, watcher } = setup();
    await watcher.pass(me);
    const fake = lookalike(friend);
    chain.pay(wallet.publicKey, fake, 0.5, NOON + 600);
    const [event] = await watcher.pass(me);
    expect(event).toMatchObject({ wallet: W, level: "urgent", signals: ["lookalike"], rescueWorthy: true });
    expect(sent.list).toHaveLength(1);
    expect(sent.list[0]![0]).toBe("urgent");
    expect(sent.list[0]![1]).not.toMatch(/https?:\/\//); // an alert never carries a link
    // the same address again is still a look-alike, not a known payee
    chain.pay(wallet.publicKey, fake, 0.5, NOON + 1200);
    expect((await watcher.pass(me))[0]).toMatchObject({ level: "urgent", signals: ["lookalike"] });
    expect(store.events(W)).toHaveLength(2);
  });

  it("marks an alert that reached no channel, and not one that reached one or whose notifier does not say", async () => {
    const { chain, store, sent, watcher } = setup();
    await watcher.pass(me);
    const fake = lookalike(friend);
    // a notifier that says nothing about delivery is taken at its word
    chain.pay(wallet.publicKey, fake, 0.5, NOON + 600);
    await watcher.pass(me);
    // one that says nobody took it, one that says somebody did, and one that fell over
    const told = { delivered: 0, failed: 1 };
    sent.notify = async () => told;
    chain.pay(wallet.publicKey, fake, 0.5, NOON + 1200);
    await watcher.pass(me);
    told.delivered = 1;
    chain.pay(wallet.publicKey, fake, 0.5, NOON + 1800);
    await watcher.pass(me);
    sent.notify = async () => { throw new Error("push service down"); };
    chain.pay(wallet.publicKey, fake, 0.5, NOON + 2400);
    await watcher.pass(me);
    expect(store.events(W).map((e) => e.undelivered === true)).toEqual([false, true, false, true]);
  });

  it("keeps a note of dust without disturbing the owner", async () => {
    const { chain, store, sent, watcher } = setup();
    await watcher.pass(me);
    chain.pay(thief, wallet.publicKey, 0.000001, NOON + 60);
    const raised = await watcher.pass(me);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ level: "info", signals: ["inbound_from_drainer"], rescueWorthy: false });
    expect(sent.list).toEqual([]);
    expect(store.events(W)).toHaveLength(1);
  });

  it("drops a soft alert for a signature the owner's browser reported, and keeps a hard one", async () => {
    const { chain, store, sent, watcher } = setup();
    await watcher.pass(me);
    const big = chain.pay(wallet.publicKey, key(41), 6, NOON + 600);
    const bad = chain.pay(wallet.publicKey, lookalike(friend), 0.5, NOON + 700);
    store.reportOwnerSignature(W, big, NOON + 650);
    store.reportOwnerSignature(W, bad, NOON + 750);
    const raised = await watcher.pass(me);
    expect(raised.map((e) => [e.signature, e.level])).toEqual([[bad, "urgent"]]);
    expect(sent.list).toHaveLength(1);
  });

  it("sees Sentinel's permission replaced, a token account taken, and the wallet reassigned, between two passes", async () => {
    const { chain, sent, watcher } = setup();
    await watcher.pass(me);
    // Each of these changes is made by a transaction the wallet signs, which is why it is in the wallet's
    // list. Here that transaction is an ordinary payment to a friend, which raises nothing of its own.
    const signedSomething = (n: number) => chain.pay(wallet.publicKey, friend, 0.4, NOON + n);
    chain.tokenAccounts[0]!.delegate = key(68).toBase58();
    signedSomething(60);
    let raised = await watcher.pass(me);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ level: "urgent", signals: ["delegate_replaced"], signature: "", rescueWorthy: true });
    // unchanged since: said once
    expect(await watcher.pass(me)).toEqual([]);

    chain.tokenAccounts[0]!.owner = thief.toBase58();
    signedSomething(120);
    raised = await watcher.pass(me);
    expect(raised.map((e) => e.signals)).toEqual([["authority_changed"]]);

    chain.walletOwner = key(82).toBase58();
    signedSomething(180);
    raised = await watcher.pass(me);
    expect(raised.map((e) => e.signals)).toEqual([["wallet_reassigned"]]);
    expect(await watcher.pass(me)).toEqual([]);
    expect(sent.list.map(([l]) => l)).toEqual(["urgent", "urgent", "urgent"]);
  });

  it("reads a quiet wallet with one call, its accounts when something is new, and every quarter of an hour regardless", async () => {
    const { chain, store, watcher, tick } = setup();
    await watcher.pass(me); // the first pass reads everything
    const cost = async () => { chain.calls = []; await watcher.pass(me); return chain.calls; };
    expect(await cost()).toEqual(["getSignaturesForAddress"]);
    expect(await cost()).toEqual(["getSignaturesForAddress"]);
    // something new in the list: the transaction, then the accounts
    chain.pay(wallet.publicKey, friend, 0.4, NOON + 60);
    expect(await cost()).toEqual(["getSignaturesForAddress", "getTransaction", "getTokenAccountsByOwner", "getTokenAccountsByOwner", "getAccountInfo"]);
    expect(await cost()).toEqual(["getSignaturesForAddress"]);

    // a change with no transaction of the wallet's beside it should not be possible. If it happens anyway,
    // it is not seen at once, and it is seen within the quarter of an hour.
    chain.tokenAccounts[0]!.delegate = key(69).toBase58();
    expect(await watcher.pass(me)).toEqual([]);
    tick(899);
    expect(await watcher.pass(me)).toEqual([]);
    tick(1);
    expect((await watcher.pass(me)).map((e) => e.signals)).toEqual([["delegate_replaced"]]);
    // a record from before this was kept had its accounts read on every pass: upgrading does not read them all again
    const old = store.record(W);
    delete old.accountsReadAt;
    store.save(W, old);
    expect(await cost()).toEqual(["getSignaturesForAddress"]);
    // and a transaction the RPC lists but cannot show yet still has the accounts read
    chain.pay(wallet.publicKey, friend, 0.4, NOON + 2000, { visible: false });
    expect(await cost()).toEqual(["getSignaturesForAddress", "getTransaction", "getTokenAccountsByOwner", "getTokenAccountsByOwner", "getAccountInfo"]);
  });

  it("misses nothing when the RPC is down: it says it is blind, and reads on from where it was", async () => {
    const { chain, store, watcher, tick } = setup();
    await watcher.pass(me);
    const cursor = store.record(W).cursor;
    chain.pay(wallet.publicKey, thief, 3, NOON + 600);
    chain.down = true;
    tick(900);
    const out = await watcher.passAll();
    expect(out.raised).toEqual([]);
    expect(out.blind).toEqual([{ wallet: W, why: "getSignaturesForAddress: the RPC answered 503" }]);
    expect(store.record(W).cursor).toBe(cursor);
    expect(watcher.stale(600)).toEqual([W]); // the owner is told watching has stopped
    chain.down = false;
    const back = await watcher.passAll();
    expect(back.raised.map((e) => e.signals)).toEqual([["known_drainer"]]);
    expect(watcher.stale(600)).toEqual([]);
  });

  it("waits for a transaction the RPC lists but cannot show yet, and does not skip past it", async () => {
    const { chain, store, watcher } = setup();
    await watcher.pass(me);
    const before = store.record(W).cursor;
    chain.pay(wallet.publicKey, thief, 3, NOON + 600, { visible: false });
    chain.pay(wallet.publicKey, friend, 0.3, NOON + 660);
    expect(await watcher.pass(me)).toEqual([]);
    expect(store.record(W).cursor).toBe(before);
    chain.txs.at(-2)!.visible = true;
    expect((await watcher.pass(me)).map((e) => e.signals)).toEqual([["known_drainer"]]);
    expect(store.record(W).cursor).toBe(chain.txs.at(-1)!.signature);
  });

  it("counts a report that arrives while the wallet is being read, and keeps it", async () => {
    const { chain, store, sent, watcher } = setup();
    await watcher.pass(me);
    const big = chain.pay(wallet.publicKey, key(41), 6, NOON + 600);
    // the pass has started; the owner's browser reports before the watcher gets to that transaction
    const pass = watcher.pass(me);
    const reported = watcher.ownerSigned(W, big);
    expect(await pass).toEqual([]);
    await reported;
    expect(sent.list).toEqual([]);
    expect(store.record(W).ownerSignatures).toEqual({ [big]: NOON });
    // and one that arrives with no pass running is written all the same
    await watcher.ownerSigned(W, "sigLATER");
    expect(Object.keys(store.record(W).ownerSignatures)).toEqual([big, "sigLATER"]);
  });

  it("forgets what the owner's browser reported after thirty days", async () => {
    const { store, watcher, tick } = setup();
    await watcher.pass(me);
    await watcher.ownerSigned(W, "sigOLD");
    tick(31 * 86_400);
    await watcher.ownerSigned(W, "sigNEW");
    expect(Object.keys(store.record(W).ownerSignatures)).toEqual(["sigNEW"]);
  });

  it("\"this was me\": who the payment went to becomes someone the wallet pays", async () => {
    const { chain, store, sent, watcher } = setup();
    await watcher.pass(me);
    const stranger = key(41);
    const first = chain.pay(wallet.publicKey, stranger, 6, NOON + 600);
    expect((await watcher.pass(me)).map((e) => [e.signature, e.level, e.signals])).toEqual([[first, "alert", ["new_large_payment"]]]);
    // unanswered, the next one to the same address is as new as the first (an hour apart: not a burst)
    chain.pay(wallet.publicKey, stranger, 6, NOON + 3600 + 600);
    expect((await watcher.pass(me)).map((e) => e.signals)).toEqual([["new_large_payment"]]);

    expect(await watcher.confirmOwn(W, first)).toBe(true);
    chain.pay(wallet.publicKey, stranger, 6, NOON + 7200 + 600);
    expect(await watcher.pass(me)).toEqual([]);
    expect(sent.list).toHaveLength(2);
    // a signature the RPC cannot show teaches nothing
    const before = JSON.stringify(store.record(W).baseline);
    expect(await watcher.confirmOwn(W, "sigUNKNOWN")).toBe(false);
    expect(JSON.stringify(store.record(W).baseline)).toBe(before);
  });

  it("reads a wallet once at a time: two passes started together raise an alert once", async () => {
    const { chain, store, sent, watcher } = setup();
    await watcher.pass(me);
    chain.pay(wallet.publicKey, thief, 3, NOON + 600);
    const [a, b] = await Promise.all([watcher.pass(me), watcher.pass(me)]);
    expect(a.length + b.length).toBe(1);
    expect(store.events(W)).toHaveLength(1);
    expect(sent.list).toHaveLength(1);
    // one that fails does not block the next
    chain.down = true;
    await expect(watcher.pass(me)).rejects.toThrow();
    chain.down = false;
    expect(await watcher.pass(me)).toEqual([]);
  });

  it("a wallet removed while it is being read stays forgotten, and gets no alert", async () => {
    const { chain, store, sent, watcher } = setup();
    await watcher.pass(me);
    chain.pay(wallet.publicKey, thief, 3, NOON + 600);
    // the owner removes the wallet while the watcher is fetching that transaction
    const call = chain.call.bind(chain);
    chain.call = async (method: string, params: any[]) => { if (method === "getTransaction") store.forget(W); return call(method, params); };
    const pass = watcher.pass(me);
    const reported = watcher.ownerSigned(W, "sigLATE");
    expect(await pass).toEqual([]);
    await reported;
    expect(store.wallets()).toEqual([]);
    expect(store.events(W)).toEqual([]);
    expect(store.record(W)).toMatchObject({ cursor: null, baseline: null, ownerSignatures: {} });
    expect(sent.list).toEqual([]);
    // and a pass asked for after that reads nothing at all
    chain.calls = [];
    expect(await watcher.pass(me)).toEqual([]);
    expect(chain.calls).toEqual([]);
  });

  it("keeps watching when the push service fails, and the alert is still on record", async () => {
    const { chain, store, sent, watcher } = setup();
    await watcher.pass(me);
    sent.fail = true;
    chain.pay(wallet.publicKey, thief, 3, NOON + 600);
    expect(await watcher.pass(me)).toHaveLength(1);
    expect(store.events(W)).toHaveLength(1);
  });

  it("picks up after a restart from what it wrote to disk", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "sentinel-")), "watch.json");
    const first = setup({ store: new FileStore(file, [me]) });
    await first.watcher.pass(me);
    first.chain.pay(wallet.publicKey, friend, 0.4, NOON + 60);
    await first.watcher.pass(me);

    // a new process: same file, same chain, one more transaction
    const reopened = new FileStore(file);
    expect(reopened.wallets()).toEqual([me]);
    expect(reopened.record(W).cursor).toBe(first.chain.txs.at(-1)!.signature);
    const sent = new Sent();
    const watcher = new Watcher(first.chain, reopened, sent, { drainers: new Set([thief.toBase58()]), now: () => NOON + 900 });
    first.chain.pay(wallet.publicKey, thief, 3, NOON + 800);
    first.chain.calls = [];
    expect((await watcher.pass(me)).map((e) => e.signals)).toEqual([["known_drainer"]]);
    expect(first.chain.calls.filter((c) => c === "getTransaction")).toHaveLength(1); // only the new one was fetched
  });
});

describe("the edges", () => {
  it("an alert goes to ntfy as a plain sentence with a priority, and nothing to click", async () => {
    const posts: any[] = [];
    await new NtfyNotifier("https://ntfy.example/topic", async (url, init) => { posts.push({ url, ...init }); }).notify(W, "urgent", "3 SOL left your wallet.");
    expect(posts).toEqual([{ url: "https://ntfy.example/topic", method: "POST", headers: { Title: "Warden Sentinel: urgent", Priority: "5" }, body: "3 SOL left your wallet." }]);
  });

  it("an RPC that says 'too many requests' is asked again; one that fails says so", async () => {
    let n = 0;
    const busy = new HttpRpc("https://rpc.example", async () => (++n < 3 ? { ok: false, status: 429, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ result: 7 }) }), { waitMs: 1 });
    expect(await busy.call("getSlot", [])).toBe(7);
    expect(n).toBe(3);
    const broken = new HttpRpc("https://rpc.example", async () => ({ ok: false, status: 500, json: async () => ({}) }), { waitMs: 1 });
    await expect(broken.call("getSlot", [])).rejects.toThrow("getSlot: the RPC answered 500");
    const refusing = new HttpRpc("https://rpc.example", async () => ({ ok: true, status: 200, json: async () => ({ error: { message: "Invalid param" } }) }));
    await expect(refusing.call("getSlot", [])).rejects.toThrow("getSlot: Invalid param");
  });
});

void TransactionInstruction;
