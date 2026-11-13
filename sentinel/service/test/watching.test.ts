/**
 * Two things an owner needs to be able to rely on: that an alert would reach them (a test they can send),
 * and that they hear about it when Sentinel itself stops being able to watch.
 */
import "../../../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { Accounts } from "../src/accounts.js";
import { Blindness, RESUMED_SENTENCE, stoppedSentence } from "../src/blindness.js";
import { pacer, watchRound } from "../src/main.js";
import { ChannelNotifier, TEST_SENTENCE, type Post } from "../src/notify.js";
import { api } from "../src/server.js";
import { NonceBook } from "../src/signin.js";
import type { Level } from "../src/signals.js";
import { MemoryStore } from "../src/store.js";

const T0 = 1_794_312_000;
const addr = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const A = addr(1), B = addr(2), C = addr(3);
// made-up addresses in each service's shape, put together here so no line reads as a real webhook to a secret scanner
const DISCORD = ["https://discord.com/api", "webhooks", "123456789012345678", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcd"].join("/");

function setup() {
  const store = new MemoryStore();
  const accounts = new Accounts(store, Buffer.alloc(32, 9));
  const posts: { url: string; init: Parameters<Post>[1] }[] = [];
  const answer: { next: () => Promise<{ ok: boolean; status: number }> } = { next: async () => ({ ok: true, status: 200 }) };
  const notifier = new ChannelNotifier(accounts, async (url, init) => { posts.push({ url, init }); return answer.next(); }, { now: () => T0 });
  const admitted = accounts.admit(A, null, T0);
  if (!admitted.ok) throw new Error("setup");
  const profile = admitted.profile;
  let now = T0;
  const handle = api({ accounts, store, watcher: { ownerSigned: async () => undefined, confirmOwn: async () => true }, nonces: new NonceBook(), origin: "https://warden.lamportrobotics.com", now: () => now, testChannel: (p, id) => notifier.test(p, id) });
  const session = accounts.startSession(profile, T0);
  const call = (method: string, path: string, body?: unknown, bearer: string | null = session) => handle({ method, path, body, bearer, ip: "10.0.0.1" });
  return { store, accounts, posts, answer, notifier, profile, call, tick: (s: number) => { now += s; } };
}

describe("a test alert", () => {
  it("goes to the one channel asked for, in that channel's plain form, and says so", async () => {
    const s = setup();
    s.accounts.setTier(s.profile, "pro");
    const ntfy = (await s.call("POST", "/v1/channels", { target: "https://ntfy.sh/alice-topic-123" })).body as any;
    const discord = (await s.call("POST", "/v1/channels", { target: DISCORD })).body as any;

    expect(await s.call("POST", `/v1/channels/${ntfy.id}/test`)).toEqual({ status: 200, body: { ok: true } });
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]!.url).toBe("https://ntfy.sh/alice-topic-123");
    expect(s.posts[0]!.init).toMatchObject({ method: "POST", redirect: "error", body: TEST_SENTENCE, headers: { Title: "Warden Sentinel: test" } });
    expect(TEST_SENTENCE).not.toMatch(/https?:\/\//);

    expect((await s.call("POST", `/v1/channels/${discord.id}/test`)).status).toBe(200);
    expect(s.posts[1]!.url).toBe(DISCORD);
    expect(JSON.parse(s.posts[1]!.init.body)).toMatchObject({ allowed_mentions: { parse: [] }, flags: 4 });
    // a test is not an alert: nothing is put on record
    expect(s.store.events(A)).toEqual([]);
  });

  it("says when the channel did not take it, instead of saying it was sent", async () => {
    const s = setup();
    const ntfy = (await s.call("POST", "/v1/channels", { target: "https://ntfy.sh/alice-topic-123" })).body as any;
    s.answer.next = async () => ({ ok: false, status: 404 });
    expect(await s.call("POST", `/v1/channels/${ntfy.id}/test`)).toEqual({ status: 502, body: { error: "the channel did not take it (it answered 404). Check the address, or remove it and add it again." } });
    s.answer.next = async () => { throw new Error("getaddrinfo ENOTFOUND ntfy.sh"); };
    const failed = await s.call("POST", `/v1/channels/${ntfy.id}/test`);
    expect(failed).toEqual({ status: 502, body: { error: "the channel could not be reached. Check the address, or try again in a minute." } });
    expect(JSON.stringify(failed)).not.toContain("ENOTFOUND"); // what went wrong inside stays inside
  });

  it("is sent only by the channel's owner, only to a channel in use, and only a few at a time", async () => {
    const s = setup();
    const ntfy = (await s.call("POST", "/v1/channels", { target: "https://ntfy.sh/alice-topic-123" })).body as any;
    // someone else's session, no session, a channel that does not exist
    const other = s.accounts.admit(B, null, T0);
    const theirs = s.accounts.startSession(other.ok ? other.profile : "", T0);
    expect((await s.call("POST", `/v1/channels/${ntfy.id}/test`, undefined, theirs)).status).toBe(404);
    expect((await s.call("POST", `/v1/channels/${ntfy.id}/test`, undefined, null)).status).toBe(401);
    expect((await s.call("POST", "/v1/channels/nope/test")).status).toBe(404);
    expect(s.posts).toEqual([]);

    // a channel the plan no longer covers gets nothing, and the owner is told why
    s.accounts.setTier(s.profile, "pro");
    const discord = (await s.call("POST", "/v1/channels", { target: DISCORD })).body as any;
    s.accounts.setTier(s.profile, "watch");
    expect(await s.call("POST", `/v1/channels/${discord.id}/test`)).toEqual({ status: 409, body: { error: "that channel is not in use on this plan, so nothing is sent to it." } });
    expect(s.posts).toEqual([]);

    // five in ten minutes, then a wait
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await s.call("POST", `/v1/channels/${ntfy.id}/test`)).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]); // the two refusals above counted too
    expect(s.posts).toHaveLength(3);
    s.tick(601);
    expect((await s.call("POST", `/v1/channels/${ntfy.id}/test`)).status).toBe(200);
  });
});

describe("when Sentinel cannot read a wallet", () => {
  it("says nothing about a hiccup, tells the owner once after a quarter of an hour, and once more when it is back", () => {
    const b = new Blindness();
    expect(b.note(A, true, T0)).toBeNull();
    expect(b.note(A, false, T0 + 60)).toBeNull();
    expect(b.note(A, true, T0 + 120)).toBeNull(); // one failed read, then fine: not news
    expect(b.note(A, false, T0 + 180)).toBeNull();
    expect(b.note(A, false, T0 + 180 + 899)).toBeNull();
    expect(b.note(A, false, T0 + 180 + 900)).toBe("stopped");
    expect(b.note(A, false, T0 + 180 + 5000)).toBeNull(); // told once, not every round
    expect(b.note(B, false, T0 + 180 + 5000)).toBeNull(); // each wallet has its own clock
    expect(b.note(A, true, T0 + 180 + 6000)).toBe("resumed");
    expect(b.note(A, true, T0 + 180 + 6060)).toBeNull();
    // and it can happen again
    expect(b.note(A, false, T0 + 20_000)).toBeNull();
    expect(b.note(A, false, T0 + 20_900)).toBe("stopped");
    expect(stoppedSentence(900)).toBe("Sentinel has not been able to read this wallet for 15 minutes, so it is not being watched right now. The fault is at Sentinel's end, not in your wallet.");
  });

  it("a round puts it on record and pushes it, for the wallet that is blind and no other", async () => {
    const store = new MemoryStore([{ address: A }, { address: B }]);
    const sent: [string, Level, string][] = [];
    const down = new Set<string>();
    const watcher = { passAll: async (only?: (a: string) => boolean) => ({ raised: [], blind: store.wallets().filter((w) => (!only || only(w.address)) && down.has(w.address)).map((w) => ({ wallet: w.address, why: "the RPC answered 503" })) }) };
    const state = { lastPassAt: null as number | null, blind: 0 };
    const log: string[] = [];
    const round = watchRound({ watcher, store, notifier: { notify: async (w, level, sentence) => { sent.push([w, level, sentence]); } }, pace: pacer(() => "watch", { watch: 60, pro: 20 }), blindness: new Blindness(), state, log: (l) => log.push(l) });

    await round(T0);
    expect(state).toEqual({ lastPassAt: T0, blind: 0, late: 0 });
    down.add(A);
    for (let t = 60; t < 900; t += 60) await round(T0 + t);
    expect(state.blind).toBe(1);
    expect(sent).toEqual([]); // fourteen minutes: not yet
    expect(log[0]).toBe(`sentinel: could not read ${A.slice(0, 4)}..${A.slice(-4)}: the RPC answered 503`);

    await round(T0 + 960);
    expect(sent).toEqual([[A, "alert", stoppedSentence(900)]]);
    expect(store.events(A)).toMatchObject([{ level: "alert", signals: ["watch_stopped"], sentence: stoppedSentence(900), rescueWorthy: false, signature: "" }]);
    expect(store.events(B)).toEqual([]);
    await round(T0 + 1020);
    expect(sent).toHaveLength(1);

    down.delete(A);
    await round(T0 + 1080);
    expect(sent[1]).toEqual([A, "alert", RESUMED_SENTENCE]);
    expect(store.events(A).map((e) => e.signals)).toEqual([["watch_stopped"], ["watch_resumed"]]);
    expect(state.blind).toBe(0);

    // a wallet that is removed while blind is no longer counted, and nothing more is said about it
    down.add(B);
    await round(T0 + 1140);
    expect(state.blind).toBe(1);
    store.forget(B);
    await round(T0 + 1200);
    expect(state.blind).toBe(0);
    await round(T0 + 5000);
    expect(sent).toHaveLength(2);
    // a push service that is down does not stop the round
    const failing = watchRound({ watcher, store: new MemoryStore([{ address: C }]), notifier: { notify: async () => { throw new Error("push down"); } }, pace: pacer(() => "watch", { watch: 60, pro: 20 }), blindness: new Blindness(0), state: { lastPassAt: null, blind: 0 }, log: () => undefined });
    await expect(failing(T0)).resolves.toBeUndefined();
  });
});
