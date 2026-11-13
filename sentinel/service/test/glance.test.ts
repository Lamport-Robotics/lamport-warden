/**
 * The look at many wallets' accounts at once, which is how a wallet is read when nothing has happened to it.
 * What is tested: that a look costs one call for many wallets, that anything an alert is about moves it, that
 * nothing falls between a look and the pass that follows, and that a wallet is still read through now and
 * then when every look finds it unchanged.
 */
import "../../../src/polyfill.js";
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import type { Rpc } from "../src/rpc.js";
import { FileStore, LAZY_WRITE_SECONDS, MemoryStore } from "../src/store.js";
import { ACCOUNTS_PER_CALL, Watcher } from "../src/watcher.js";

const T0 = 1_794_312_000;
const addr = (n: number, m = 0) => Keypair.fromSeed(new Uint8Array(32).fill(n).map((b, i) => (i === 0 ? m : b))).publicKey.toBase58();
const SYSTEM = "11111111111111111111111111111111";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** A chain of wallets that hold SOL and token accounts, and transact when the test says so. */
class Chain implements Rpc {
  wallets = new Map<string, { lamports: number; owner: string; tokens: Map<string, { amount: number; delegate: string | null; owner: string }>; signatures: string[] }>();
  calls: { method: string; n: number }[] = [];
  down = false;
  private n = 0;
  add(wallet: string, tokens = 0): void {
    this.wallets.set(wallet, { lamports: 5_000_000_000, owner: SYSTEM, signatures: [], tokens: new Map(Array.from({ length: tokens }, (_, i) => [Keypair.generate().publicKey.toBase58(), { amount: 100 + i, delegate: null, owner: wallet }])) });
  }
  /** The wallet signs something: it is in its list of transactions from now on. */
  signs(wallet: string): string { const s = `sig${++this.n}`; this.wallets.get(wallet)!.signatures.push(s); return s; }
  async call(method: string, params: any[]): Promise<any> {
    this.calls.push({ method, n: method === "getMultipleAccounts" ? params[0].length : 1 });
    if (this.down) throw new Error(`${method}: the RPC answered 503`);
    if (method === "getMultipleAccounts") {
      if (params[0].length > 100) throw new Error("getMultipleAccounts: Too many inputs provided; max 100");
      return { value: (params[0] as string[]).map((a) => {
        const w = this.wallets.get(a);
        if (w) return { lamports: w.lamports, owner: w.owner, data: ["", "base64"] };
        for (const x of this.wallets.values()) { const t = x.tokens.get(a); if (t) return { lamports: 2_039_280, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: { mint: USDC, owner: t.owner, state: "initialized", tokenAmount: { amount: String(t.amount) }, ...(t.delegate ? { delegate: t.delegate, delegatedAmount: { amount: "5" } } : {}) } } } }; }
        return null;
      }) };
    }
    const w = this.wallets.get(params[0]);
    if (method === "getSignaturesForAddress") { const list = [...(w?.signatures ?? [])].reverse(); const until = params[1]?.until; const i = until ? list.indexOf(until) : -1; return (i >= 0 ? list.slice(0, i) : list).map((signature) => ({ signature })); }
    if (method === "getTransaction") return null; // listed and not yet shown: the pass waits, which is all these tests need of it
    if (method === "getTokenAccountsByOwner") return { value: params[1].programId.startsWith("Tokenkeg") ? [...(w?.tokens ?? [])].map(([pubkey, t]) => ({ pubkey, account: { data: { parsed: { info: { mint: USDC, owner: t.owner, ...(t.delegate ? { delegate: t.delegate } : {}) } } } } })) : [] };
    if (method === "getAccountInfo") return { value: w ? { owner: w.owner } : null };
    throw new Error(`unexpected ${method}`);
  }
  /** The calls since last asked, as "method" or "method×n" for a bulk read. */
  took(): string[] { const c = this.calls.map((x) => (x.method === "getMultipleAccounts" ? `look×${x.n}` : x.method)); this.calls = []; return c; }
}

function setup(wallets: [string, number][], opts: { fullEverySeconds?: number } = {}) {
  const chain = new Chain();
  for (const [w, tokens] of wallets) chain.add(w, tokens);
  const store = new MemoryStore(wallets.map(([address]) => ({ address })));
  let now = T0;
  const watcher = new Watcher(chain, store, { notify: async () => undefined }, { now: () => now, readers: 2, ...opts });
  return { chain, store, watcher, tick: (s: number) => { now += s; }, now: () => now };
}
const A = addr(1), B = addr(2), C = addr(3);

describe("a round of looking", () => {
  it("costs one call for many wallets when nothing has happened to any of them", async () => {
    const s = setup([[A, 4], [B, 9], [C, 0]]);
    await s.watcher.passAll(); // the first read of each: its history and its accounts
    await s.watcher.passAll(); // their first look, and the pass that follows a first look
    s.chain.took();
    s.tick(60);
    expect(await s.watcher.passAll()).toEqual({ raised: [], blind: [], deferred: [] });
    expect(s.chain.took()).toEqual(["look×16"]); // three wallets and their thirteen token accounts, in one call
    for (const w of [A, B, C]) expect(s.store.record(w).lastSeenAt).toBe(s.now()); // looked at is read
    s.tick(60);
    await s.watcher.passAll();
    expect(s.chain.took()).toEqual(["look×16"]);
  });

  it("reads a wallet's transactions when its balance, a token amount, or who may spend one has moved, and only that wallet's", async () => {
    const s = setup([[A, 2], [B, 2]]);
    await s.watcher.passAll(); await s.watcher.passAll(); s.chain.took();
    const reads = async () => { s.tick(60); await s.watcher.passAll(); return s.chain.took(); };
    const tokenOfA = [...s.chain.wallets.get(A)!.tokens.values()][0]!;

    s.chain.wallets.get(A)!.lamports -= 5000; // a fee was paid
    expect(await reads()).toEqual(["look×6", "getSignaturesForAddress"]);
    expect(await reads()).toEqual(["look×6"]); // seen, and quiet again

    tokenOfA.amount -= 40; // tokens left
    expect(await reads()).toEqual(["look×6", "getSignaturesForAddress"]);
    tokenOfA.delegate = addr(90); // someone may now spend it
    expect(await reads()).toEqual(["look×6", "getSignaturesForAddress"]);
    tokenOfA.owner = addr(91); // it is someone else's
    expect(await reads()).toEqual(["look×6", "getSignaturesForAddress"]);
    s.chain.wallets.get(B)!.owner = addr(92); // the other wallet was handed to a program
    expect(await reads()).toEqual(["look×6", "getSignaturesForAddress"]);
    expect(await reads()).toEqual(["look×6"]);
    // which wallet was read through each time is the one that moved
    expect(s.store.record(A).passedAt).toBe(s.now() - 120);
    expect(s.store.record(B).passedAt).toBe(s.now() - 60);
  });

  it("lets nothing fall between a look and the pass after it", async () => {
    const s = setup([[A, 1]]);
    await s.watcher.passAll(); await s.watcher.passAll(); s.chain.took();
    // A thief's first move is seen by a look. While the pass that follows is reading the list, the second move lands.
    const w = s.chain.wallets.get(A)!;
    w.lamports -= 1_000_000;
    s.chain.signs(A);
    const original = s.chain.call.bind(s.chain);
    let struck = false;
    s.chain.call = async (method, params) => {
      if (method === "getSignaturesForAddress" && !struck) { struck = true; const out = await original(method, params); w.lamports -= 2_000_000; return out; }
      return original(method, params);
    };
    s.tick(60);
    await s.watcher.passAll();
    s.chain.took();
    // the line kept is the one from before the pass, so the next look differs and the wallet is read through again
    s.tick(60);
    await s.watcher.passAll();
    expect(s.chain.took()).toContain("getSignaturesForAddress");
    s.tick(60);
    await s.watcher.passAll();
    // And a transaction that is listed and cannot be shown yet (this chain never shows one) is asked for
    // again on the wallet's next turn, though its accounts have not moved since: it is not left for ten minutes.
    expect(s.store.record(A).more).toBe(true);
    expect(s.chain.took().slice(0, 3)).toEqual(["look×2", "getSignaturesForAddress", "getTransaction"]);
  });

  it("still reads a wallet through now and then when every look finds it unchanged, and at once when told to", async () => {
    const s = setup([[A, 1], [B, 1]], { fullEverySeconds: 600 });
    await s.watcher.passAll(); await s.watcher.passAll(); s.chain.took();
    for (let i = 0; i < 9; i++) { s.tick(60); await s.watcher.passAll(); }
    expect(s.chain.took().filter((c) => c !== "look×4")).toEqual([]); // nine minutes of looks, nothing else
    s.tick(60);
    await s.watcher.passAll();
    expect(s.chain.took().filter((c) => c === "getSignaturesForAddress")).toHaveLength(2); // ten minutes: both read through
    // the RPC has just said B was in a transaction: B is read through whatever the look says, A is not
    s.tick(60);
    await s.watcher.passAll(undefined, { full: (w) => w === B });
    expect(s.chain.took()).toEqual(["look×4", "getSignaturesForAddress"]);
    expect(s.store.record(B).passedAt).toBe(s.now());
    expect(s.store.record(A).passedAt).toBe(s.now() - 60);
    // the interval can be worked out afresh each round
    let every = 10_000;
    const grown = new Watcher(s.chain, s.store, { notify: async () => undefined }, { now: s.now, fullEverySeconds: () => every });
    s.tick(60); await grown.passAll(); expect(s.chain.took()).toEqual(["look×4"]);
    every = 30;
    s.tick(60); await grown.passAll(); expect(s.chain.took().filter((c) => c === "getSignaturesForAddress")).toHaveLength(2);
  });

  it("reads a wallet it has never read without a look, and takes its first look on the turn after", async () => {
    const s = setup([[A, 3]]);
    await s.watcher.passAll();
    expect(s.chain.took()).toEqual(["getSignaturesForAddress", "getTokenAccountsByOwner", "getTokenAccountsByOwner", "getAccountInfo"]);
    expect(s.store.record(A).glance).toBeUndefined();
    s.tick(60);
    await s.watcher.passAll();
    expect(s.chain.took()).toEqual(["look×4", "getSignaturesForAddress"]); // its accounts are known now: looked at, and read through once more
    expect(s.store.record(A).glance).toMatchObject({ at: s.now() });
    s.tick(60);
    await s.watcher.passAll();
    expect(s.chain.took()).toEqual(["look×4"]);
  });

  it("keeps each wallet's accounts together in one call of a hundred at most, and a wallet with more is looked at by its first ninety-nine", async () => {
    const wallets: [string, number][] = [[addr(1), 59], [addr(2), 30], [addr(3), 30], [addr(4), 150], [addr(5), 0]];
    const s = setup(wallets);
    await s.watcher.passAll(); await s.watcher.passAll(); s.chain.took();
    s.tick(60);
    await s.watcher.passAll();
    // 60, then 31 (91 so far), then 31 would make 122: a new call; the big wallet takes a call to itself; the last starts another
    expect(s.chain.took().sort()).toEqual(["look×1", "look×100", "look×31", "look×91"].sort());
    expect(ACCOUNTS_PER_CALL).toBe(100);
    // every wallet got its own answer, not its neighbour's
    for (const [w] of wallets) expect(s.store.record(w).glance!.print.startsWith(`${w}:5000000000:${SYSTEM}`)).toBe(true);
    const big = s.store.record(addr(4)).glance!.print.split("\n");
    expect(big).toHaveLength(100);
  });

  it("when the look cannot be made, the wallets in it are blind and are not read through on a guess; the rest are read", async () => {
    const s = setup([[A, 1], [B, 1]]);
    await s.watcher.passAll(); await s.watcher.passAll(); s.chain.took();
    s.chain.down = true;
    s.tick(60);
    const out = await s.watcher.passAll();
    expect(out.blind.map((b) => b.wallet).sort()).toEqual([A, B].sort());
    expect(out.blind[0]!.why).toBe("getMultipleAccounts: the RPC answered 503");
    expect(s.chain.took()).toEqual(["look×4"]);
    expect(s.store.record(A).lastSeenAt).toBe(s.now() - 60); // not counted as read
    s.chain.down = false;
    s.chain.wallets.get(A)!.lamports -= 1; // and what happened meanwhile is found when it is back
    s.tick(60);
    expect((await s.watcher.passAll()).blind).toEqual([]);
    expect(s.chain.took()).toEqual(["look×4", "getSignaturesForAddress"]);
  });
});

describe("a round with more to read through than it has time for", () => {
  it("reads through the most pressing, hands the rest back unread, and counts a wallet that is only due its now-and-then pass as read by the look", async () => {
    const wallets = Array.from({ length: 7 }, (_, i) => addr(i + 1));
    const [spoken, unfinished, moved1, moved2, fresh, routine1, routine2] = wallets as [string, string, string, string, string, string, string];
    const s = setup(wallets.filter((w) => w !== fresh).map((w) => [w, 1]), { fullEverySeconds: 600 });
    await s.watcher.passAll(); await s.watcher.passAll();
    // a wallet that has just been added, one whose last pass left something unread, two whose accounts moved,
    // one the RPC has spoken of, and two that are merely due their ten-minute pass
    s.chain.add(fresh, 1);
    s.store.watch({ address: fresh });
    s.store.save(unfinished, { ...s.store.record(unfinished), more: true });
    s.chain.wallets.get(moved1)!.lamports -= 1;
    s.chain.wallets.get(moved2)!.lamports -= 1;
    s.tick(600);
    s.chain.took();
    const passed = () => s.chain.took().filter((c) => c === "getSignaturesForAddress").length;
    const first = await s.watcher.passAll(undefined, { full: (w) => w === spoken, mostPasses: 3 });
    expect(passed()).toBe(3);
    // the RPC's word, the unfinished pass, and one of the two that moved were read through; the other that
    // moved and the new wallet were not read, and say so
    expect(first.deferred.sort()).toEqual([moved2, fresh].sort());
    for (const w of [spoken, unfinished, moved1]) expect(s.store.record(w).passedAt, w).toBe(s.now());
    // the two routine ones were looked at, found as they were, and that is their read: not deferred, not passed
    for (const w of [routine1, routine2]) { expect(s.store.record(w).lastSeenAt, w).toBe(s.now()); expect(s.store.record(w).passedAt, w).toBe(s.now() - 600); }
    expect(s.store.record(moved2).lastSeenAt).toBe(s.now() - 600); // not read is not marked read
    // next round they are taken first, and then the routine passes get their turn
    s.tick(2);
    const second = await s.watcher.passAll(undefined, { mostPasses: 3 });
    expect(second.deferred).toEqual([]);
    expect(s.store.record(moved2).passedAt).toBe(s.now());
    expect(s.store.record(fresh).passedAt).toBe(s.now());
    expect([routine1, routine2].filter((w) => s.store.record(w).passedAt === s.now())).toHaveLength(1); // one place was left for a routine pass
  });
});

describe("looked at, nothing changed", () => {
  it("is written out within half a minute and not at once: a thousand looks are not a thousand writes of the file", () => {
    vi.useFakeTimers();
    try {
      const file = join(mkdtempSync(join(tmpdir(), "sentinel-seen-")), "sentinel.json");
      const store = new FileStore(file, [{ address: A }, { address: B }]);
      store.save(A, { ...store.record(A), lastSeenAt: T0 });
      store.save(B, { ...store.record(B), lastSeenAt: T0 });
      const onDisk = () => JSON.parse(readFileSync(file, "utf8")).records;
      store.seen([A, B, C], T0 + 60); // C is not watched: nothing is made up for it
      expect(store.record(A).lastSeenAt).toBe(T0 + 60); // known at once
      expect(onDisk()[A].lastSeenAt).toBe(T0); // and not yet written
      vi.advanceTimersByTime(LAZY_WRITE_SECONDS * 1000 - 1);
      expect(onDisk()[A].lastSeenAt).toBe(T0);
      vi.advanceTimersByTime(1);
      expect(onDisk()).toMatchObject({ [A]: { lastSeenAt: T0 + 60 }, [B]: { lastSeenAt: T0 + 60 } });
      expect(onDisk()[C]).toBeUndefined();
      // something that matters is written at once, and takes what was waiting with it
      store.seen([A], T0 + 120);
      store.addEvent({ wallet: B, signature: "", slot: 0, at: T0 + 121, level: "info", signals: [], sentence: "x", rescueWorthy: false });
      expect(onDisk()[A].lastSeenAt).toBe(T0 + 120);
      // a wallet removed is not brought back by a look that was already on its way
      store.forget(A);
      store.seen([A], T0 + 180);
      expect(store.record(A).lastSeenAt).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});
