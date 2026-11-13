/**
 * A plan's pace is a promise: "each wallet read every minute", "every twenty seconds". These tests are about
 * keeping it when there is more to read than can be read at once, and about saying so when it is not kept.
 */
import "../../../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { Blindness } from "../src/blindness.js";
import { LATE_FOR_SECONDS, ROUND_GAP_SECONDS, configFrom, pacer, watchRound } from "../src/main.js";
import { MemoryStore } from "../src/store.js";
import { Watcher } from "../src/watcher.js";
import type { Rpc } from "../src/rpc.js";

const T0 = 1_794_312_000;
const addr = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const SECONDS = { watch: 60, pro: 20 };

describe("who is read next", () => {
  it("the one furthest behind its own promise goes first, and a wallet never read takes its turn among them", () => {
    const pro = new Set([addr(1), addr(2)]);
    const pace = pacer((w) => (pro.has(w) ? "pro" : "watch"), SECONDS);
    const all = [addr(1), addr(2), addr(3), addr(4)];
    expect(pace.due(all, T0)).toEqual(all); // nobody was read yet: all are due, in the order they were met
    for (const w of all) pace.pick(w, T0);
    expect(pace.due(all, T0 + 10)).toEqual([]);
    expect(pace.due(all, T0 + 19)).toEqual([addr(1), addr(2)]); // the paid ones, a second early counts
    expect(pace.due(all, T0 + 59)).toEqual([addr(1), addr(2), addr(3), addr(4)]); // paid ones are three promises behind, free ones one
    // a free wallet that has waited three of its minutes comes before a paid one that has waited two of its twenties
    pace.pick(addr(1), T0 + 140);
    expect(pace.due(all, T0 + 180)[0]).toBe(addr(2)); // 9 promises behind
    pace.pick(addr(2), T0 + 180);
    expect(pace.due(all, T0 + 180)).toEqual([addr(3), addr(4), addr(1)]); // 3, 3 and 2 promises behind
    // a wallet that turns up later is due at once and takes its turn: behind those already waiting
    const withNew = pace.due([...all, addr(5)], T0 + 180);
    expect(withNew.at(-1)).toBe(addr(5));
    // left unread while the others are read on time, it becomes the one furthest behind
    for (const t of [180, 200, 220, 240, 260, 280]) for (const w of pace.due(all, T0 + t)) pace.pick(w, T0 + t);
    expect(pace.due([...all, addr(5)], T0 + 299)).toEqual([addr(5), addr(3), addr(4), addr(1), addr(2)]);
  });

  it("a round reads no more than its batch, and what it leaves is first in the next", async () => {
    const wallets = Array.from({ length: 7 }, (_, i) => addr(10 + i));
    const store = new MemoryStore(wallets.map((address) => ({ address })));
    const read: string[][] = [];
    const watcher = { passAll: async (only?: (a: string) => boolean) => { read.push(store.wallets().map((w) => w.address).filter((a) => !only || only(a))); return { raised: [], blind: [] }; } };
    const state = { lastPassAt: null as number | null, blind: 0, late: 0 };
    const round = watchRound({ watcher, store, notifier: { notify: async () => undefined }, pace: pacer(() => "watch", SECONDS), blindness: new Blindness(), state, log: () => undefined, batch: 3 });
    await round(T0);
    await round(T0 + 2);
    await round(T0 + 4);
    await round(T0 + 6);
    expect(read.map((r) => r.length)).toEqual([3, 3, 1, 0]); // everyone read once, three at a time, then nothing is due
    expect(new Set(read.flat()).size).toBe(7);
    expect(state.lastPassAt).toBe(T0 + 6);
  });

  it("with twenty paid wallets among eighty free ones, the paid ones keep their twenty seconds", async () => {
    const pro = new Set(Array.from({ length: 20 }, (_, i) => addr(100 + i)));
    const wallets = [...Array.from({ length: 80 }, (_, i) => addr(i + 1)), ...pro];
    const store = new MemoryStore(wallets.map((address) => ({ address })));
    const starts = new Map<string, number[]>();
    let now = T0;
    const watcher = { passAll: async (only?: (a: string) => boolean) => { for (const w of store.wallets()) if (!only || only(w.address)) starts.set(w.address, [...(starts.get(w.address) ?? []), now]); return { raised: [], blind: [] }; } };
    const pace = pacer((w) => (pro.has(w) ? "pro" : "watch"), SECONDS);
    const state = { lastPassAt: null as number | null, blind: 0, late: 0 };
    const round = watchRound({ watcher, store, notifier: { notify: async () => undefined }, pace, blindness: new Blindness(), state, log: () => undefined, batch: 6 });
    // an RPC that takes three reads a second: a round of six every two seconds, for five minutes
    for (; now < T0 + 300; now += 2) await round(now);
    const gaps = (w: string) => { const s = starts.get(w) ?? []; return s.slice(1).map((t, i) => t - s[i]!); };
    const worst = (group: Iterable<string>) => Math.max(...[...group].flatMap(gaps));
    // 140 reads a minute asked of an RPC that takes 180, everyone starting at the same moment: each kind is
    // read within a fifth of its promise, and neither is made to pay for the other
    expect(worst(pro)).toBeLessThanOrEqual(24);
    expect(worst(wallets.filter((w) => !pro.has(w)))).toBeLessThanOrEqual(72);
    expect(state.late).toBe(0);
    for (const w of wallets) expect(starts.get(w)!.length, w).toBeGreaterThanOrEqual(pro.has(w) ? 12 : 4);
  });
});

describe("a wallet that was picked and not read", () => {
  it("is due again at once, further forward, and is not counted as read", async () => {
    const wallets = [addr(1), addr(2), addr(3), addr(4)];
    const store = new MemoryStore(wallets.map((address) => ({ address })));
    const rounds: { asked: string[]; read: string[] }[] = [];
    // a watcher that can read two wallets a round, and hands back the rest
    const watcher = { passAll: async (only?: (a: string) => boolean) => { const asked = wallets.filter((a) => !only || only(a)); const read = asked.slice(0, 2); rounds.push({ asked, read }); return { raised: [], blind: [], deferred: asked.slice(2) }; } };
    const pace = pacer(() => "watch", SECONDS);
    const state = { lastPassAt: null as number | null, blind: 0, late: 0 };
    const round = watchRound({ watcher, store, notifier: { notify: async () => undefined }, pace, blindness: new Blindness(), state, log: () => undefined });
    await round(T0);
    expect(rounds[0]).toEqual({ asked: wallets, read: [addr(1), addr(2)] });
    await round(T0 + 2);
    expect(rounds[1]!.asked).toEqual([addr(3), addr(4)]); // the two that were handed back, and only those
    await round(T0 + 4);
    expect(rounds[2]!.asked).toEqual([]); // everyone has been read: nobody is due
    // taken back, a pick leaves no trace: the wallet is as far behind as it was, and late when that is long
    const p = pacer(() => "watch", SECONDS);
    p.pick(addr(9), T0);
    expect(p.pick(addr(9), T0 + 200)).toBe(true);
    p.again(addr(9));
    expect(p.late([addr(9)], T0 + 200)).toEqual({ count: 1, worst: { seconds: 200, promised: 60 } });
    expect(p.tried()).toEqual([]); // and it is not among those the round tried and read
    p.again(addr(9)); // twice is once
    expect(p.pick(addr(9), T0 + 201)).toBe(true);
    // a wallet never read before, picked and handed back, is new again
    p.pick(addr(8), T0 + 300);
    p.again(addr(8));
    expect(p.due([addr(8)], T0 + 300)).toEqual([addr(8)]);
  });
});

describe("when the promise is not being kept", () => {
  it("counts the wallets read later than twice their promise, says so after a quarter of an hour, and stops when it is kept again", async () => {
    const wallets = Array.from({ length: 30 }, (_, i) => addr(i + 1));
    const store = new MemoryStore(wallets.map((address) => ({ address })));
    const said: [string, string][] = [];
    const ops = { say: async (sentence: string, key = sentence) => { said.push([sentence, key]); return true; } };
    // a watcher that reads whoever the round picked, and nobody else
    const watcher = { passAll: async (only?: (a: string) => boolean) => { for (const w of store.wallets()) only?.(w.address); return { raised: [], blind: [] }; } };
    const state = { lastPassAt: null as number | null, blind: 0, late: 0 };
    // an RPC that takes one read every ten seconds: thirty wallets promised a read a minute cannot be kept
    let batch = 1;
    const pace = pacer(() => "watch", SECONDS);
    const kept = watchRound({ watcher, store, notifier: { notify: async () => undefined }, pace, blindness: new Blindness(), state, log: () => undefined, ops, get batch() { return batch; } });
    let now = T0;
    for (; now < T0 + 300; now += 10) await kept(now);
    expect(state.late).toBeGreaterThan(0); // five minutes in: most have waited more than two minutes
    expect(said).toEqual([]); // and it is too early to call it a fact
    for (; now < T0 + 300 + LATE_FOR_SECONDS + 20; now += 10) await kept(now);
    expect(said.length).toBeGreaterThan(0);
    expect(said[0]![1]).toBe("late");
    expect(said[0]![0]).toMatch(/^\d+ of 30 wallets are being read later than their plan promises, and have been for 1[5-9] minutes: the slowest waited \d+ seconds against 60\. The RPC is not taking reads as fast as these wallets need them\.$/);
    expect(said[0]![0]).not.toContain(wallets[0]!); // no wallet is named

    // the RPC takes more again: everyone is read on time, the count goes to nothing
    batch = 30;
    for (const end = now + 180; now < end; now += 10) await kept(now);
    expect(state.late).toBe(0);
  });

  it("is not said about a wallet that was only just added, nor one slow round", () => {
    const pace = pacer(() => "watch", SECONDS);
    expect(pace.late([addr(1)], T0)).toEqual({ count: 0, worst: null }); // met just now
    expect(pace.late([addr(1)], T0 + 120)).toEqual({ count: 0, worst: null }); // twice the promise exactly: not yet
    expect(pace.late([addr(1)], T0 + 121)).toEqual({ count: 1, worst: { seconds: 121, promised: 60 } }); // never read, and waiting
    pace.pick(addr(1), T0 + 121);
    expect(pace.late([addr(1)], T0 + 200)).toEqual({ count: 0, worst: null });
    // a wallet that is gone is forgotten, and met afresh if it comes back
    pace.forget(() => false);
    expect(pace.late([addr(1)], T0 + 9999)).toEqual({ count: 0, worst: null });
  });
});

describe("reading several wallets at once", () => {
  it("has as many in hand as it has readers, reads every one, and one that fails does not stop the rest", async () => {
    const wallets = Array.from({ length: 9 }, (_, i) => addr(i + 1));
    const store = new MemoryStore(wallets.map((address) => ({ address })));
    let inHand = 0, most = 0;
    const seen: string[] = [];
    const rpc: Rpc = { call: async (method, params: any[]) => {
      if (method !== "getSignaturesForAddress") return method === "getAccountInfo" ? { value: { owner: "11111111111111111111111111111111" } } : { value: [] };
      inHand += 1; most = Math.max(most, inHand);
      await new Promise((r) => setTimeout(r, 5));
      inHand -= 1;
      seen.push(params[0]);
      if (params[0] === wallets[4]) throw new Error("getSignaturesForAddress: the RPC answered 503");
      return [];
    } };
    const watcher = new Watcher(rpc, store, { notify: async () => undefined }, { readers: 3 });
    const { blind } = await watcher.passAll();
    expect(most).toBe(3);
    expect(new Set(seen)).toEqual(new Set(wallets));
    expect(blind).toEqual([{ wallet: wallets[4], why: "getSignaturesForAddress: the RPC answered 503" }]);
    // one reader, as before, is one at a time
    most = 0;
    await new Watcher(rpc, store, { notify: async () => undefined }).passAll((a) => a !== wallets[4]);
    expect(most).toBe(1);
  });
});

describe("how fast the RPC is asked", () => {
  const base = { SENTINEL_DATA_KEY: Buffer.alloc(32, 7).toString("base64") };

  it("is what the public RPC was measured to take when that is the RPC, and unlimited for any other unless said", () => {
    expect(configFrom({ ...base, SENTINEL_RPC_URL: "https://api.mainnet-beta.solana.com" })).toMatchObject({ ok: true, config: { rpcPace: { heavyPer10s: 9, lightPer10s: 35 }, readers: 3 } });
    const paceOf = (url: string) => { const c = configFrom({ ...base, SENTINEL_RPC_URL: url }); return c.ok ? c.config.rpcPace : null; };
    expect(paceOf("https://my-own.rpc.example/key")).toEqual({});
    // a paid RPC takes more, and is told how much; a lane can be opened altogether
    expect(configFrom({ ...base, SENTINEL_RPC_URL: "https://my-own.rpc.example/key", SENTINEL_RPC_HEAVY_PER_10S: "100", SENTINEL_READERS: "8" })).toMatchObject({ ok: true, config: { rpcPace: { heavyPer10s: 100 }, readers: 8 } });
    const open = configFrom({ ...base, SENTINEL_RPC_URL: "https://api.mainnet-beta.solana.com", SENTINEL_RPC_LIGHT_PER_10S: "0" });
    expect(open.ok && open.config.rpcPace).toEqual({ heavyPer10s: 9 });
    // a host that only looks like the public one is not it
    expect(paceOf("https://mainnet-beta.solana.com.evil.example")).toEqual({});
    expect(paceOf("https://notmainnet-beta.solana.com")).toEqual({});
  });

  it("refuses settings that are not a pace or a number of readers", () => {
    const rpc = { ...base, SENTINEL_RPC_URL: "https://api.mainnet-beta.solana.com" };
    for (const bad of ["-1", "fast", "100000"]) expect(configFrom({ ...rpc, SENTINEL_RPC_HEAVY_PER_10S: bad })).toEqual({ ok: false, why: "SENTINEL_RPC_HEAVY_PER_10S has to be a number of calls per ten seconds, or 0 for no limit." });
    for (const bad of ["0", "2.5", "100"]) expect(configFrom({ ...rpc, SENTINEL_READERS: bad })).toEqual({ ok: false, why: "SENTINEL_READERS has to be a whole number from 1 to 32." });
    expect(ROUND_GAP_SECONDS).toBeLessThanOrEqual(5); // a wallet that is due is not kept waiting for the next round to begin
  });
});
