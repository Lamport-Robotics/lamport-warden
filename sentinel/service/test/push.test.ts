/**
 * The push line: the RPC saying, unasked, that a watched wallet was in a transaction. What is tested is that
 * it only ever makes a read happen sooner, for a wallet that is watched, and that when it breaks nothing else
 * does.
 */
import "../../../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { Blindness } from "../src/blindness.js";
import { LATE_FOR_SECONDS, configFrom, pacer, pushedRounds, watchRound } from "../src/main.js";
import { Push, pushUrlFor, type SocketLike } from "../src/push.js";
import { MemoryStore } from "../src/store.js";

const T0 = 1_794_312_000;
const addr = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const A = addr(1), B = addr(2), C = addr(3);

/** A websocket the test holds both ends of. */
class FakeSocket implements SocketLike {
  sent: any[] = [];
  closed = false;
  private listeners: Record<string, ((e: any) => void)[]> = {};
  constructor(readonly url: string) {}
  send(data: string): void { if (this.closed) throw new Error("socket is closed"); this.sent.push(JSON.parse(data)); }
  close(): void { this.closed = true; }
  addEventListener(type: string, listener: (e: any) => void): void { (this.listeners[type] ??= []).push(listener); }
  emit(type: string, event: any = {}): void { for (const l of this.listeners[type] ?? []) l(event); }
  say(message: unknown): void { this.emit("message", { data: JSON.stringify(message) }); }
  /** Answers every subscription asked so far, giving each a number, as the RPC does. */
  ack(from = 100): void { for (const m of this.sent.filter((x) => x.method === "logsSubscribe" && !x.acked)) { m.acked = true; this.say({ jsonrpc: "2.0", id: m.id, result: from + m.id }); } }
  numberFor(wallet: string, from = 100): number { return from + this.sent.find((x) => x.method === "logsSubscribe" && x.params[0].mentions[0] === wallet).id; }
}

function setup(most?: number) {
  const sockets: FakeSocket[] = [];
  const mentions: string[] = [];
  const timers: { work: () => void; ms: number }[] = [];
  const log: string[] = [];
  const push = new Push({ url: "wss://rpc.example", onMention: (w) => mentions.push(w), socket: (u) => { const s = new FakeSocket(u); sockets.push(s); return s; }, later: (work, ms) => { timers.push({ work, ms }); }, log: (l) => log.push(l), ...(most ? { most } : {}) });
  return { push, sockets, mentions, timers, log, runTimers: () => { for (const t of timers.splice(0)) t.work(); } };
}

describe("the push line", () => {
  it("asks the RPC to say when each watched wallet is mentioned, and passes on only what it asked for", () => {
    const s = setup();
    s.push.start();
    s.push.watch([A, B]);
    expect(s.sockets[0]!.sent).toEqual([]); // not open yet: nothing is sent into the void
    s.sockets[0]!.emit("open");
    expect(s.sockets[0]!.sent.map((m) => [m.method, m.params[0].mentions, m.params[1]])).toEqual([["logsSubscribe", [A], { commitment: "confirmed" }], ["logsSubscribe", [B], { commitment: "confirmed" }]]);
    expect(s.push.state).toEqual({ connected: true, listening: 0 }); // asked, not yet answered
    s.sockets[0]!.ack();
    expect(s.push.state).toEqual({ connected: true, listening: 2 });

    s.sockets[0]!.say({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: s.sockets[0]!.numberFor(B), result: { value: { signature: "sigX", err: null, logs: [] } } } });
    expect(s.mentions).toEqual([B]);
    // a number that was never given, a message naming a wallet itself, and things that are not messages: nothing
    s.sockets[0]!.say({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: 424242, result: { value: { signature: "sigY" } } } });
    s.sockets[0]!.say({ jsonrpc: "2.0", method: "logsNotification", params: { wallet: A, result: {} } });
    s.sockets[0]!.emit("message", { data: "not json" });
    s.sockets[0]!.say(null);
    s.sockets[0]!.say([1, 2, 3]);
    expect(s.mentions).toEqual([B]);
  });

  it("follows the wallets that are watched: a new one is added, one that is gone is dropped and no longer heard", () => {
    const s = setup();
    s.push.start();
    s.sockets[0]!.emit("open");
    s.push.watch([A, B]);
    s.sockets[0]!.ack();
    const numberOfB = s.sockets[0]!.numberFor(B);
    s.push.watch([A, C]);
    const after = s.sockets[0]!.sent.slice(2);
    expect(after.map((m) => [m.method, m.method === "logsSubscribe" ? m.params[0].mentions[0] : m.params[0]])).toEqual([["logsSubscribe", C], ["logsUnsubscribe", numberOfB]]);
    // word about the wallet that was dropped, arriving late, is not passed on
    s.sockets[0]!.say({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: numberOfB, result: {} } });
    expect(s.mentions).toEqual([]);
    // asking again changes nothing: no subscription is made twice
    s.push.watch([A, C]);
    s.push.watch([A, C]);
    expect(s.sockets[0]!.sent).toHaveLength(4);
    // only addresses are ever put in a subscription, and no more of them than the line is given
    const few = setup(2);
    few.push.start();
    few.sockets[0]!.emit("open");
    few.push.watch(["not an address", A, B, C, '"}, {"mentions": ["x'] as string[]);
    expect(few.sockets[0]!.sent.map((m) => m.params[0].mentions[0])).toEqual([A, B]);
  });

  it("a subscription the RPC refuses is not asked for again and again, and that wallet is simply not pushed", () => {
    const s = setup();
    s.push.start();
    s.sockets[0]!.emit("open");
    s.push.watch([A]);
    s.sockets[0]!.say({ jsonrpc: "2.0", id: s.sockets[0]!.sent[0].id, error: { code: -32602, message: "Too many subscriptions" } });
    s.push.watch([A]);
    s.push.watch([A]);
    expect(s.sockets[0]!.sent).toHaveLength(1);
    expect(s.push.state.listening).toBe(0);
  });

  it("when the line drops it is put up again after a wait that grows, and everything is asked for afresh", () => {
    const s = setup();
    s.push.start();
    s.sockets[0]!.emit("open");
    s.push.watch([A, B]);
    s.sockets[0]!.ack();
    s.sockets[0]!.emit("close");
    expect(s.push.state).toEqual({ connected: false, listening: 0 });
    expect(s.timers.map((t) => t.ms)).toEqual([1000]);
    s.runTimers();
    expect(s.sockets).toHaveLength(2);
    // it fails to open three times: each wait is longer, and none is longer than a minute
    for (let i = 0; i < 3; i++) { s.sockets.at(-1)!.emit("error"); s.runTimers(); }
    expect(s.sockets).toHaveLength(5);
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) { s.sockets.at(-1)!.emit("close"); waits.push(s.timers[0]!.ms); s.runTimers(); }
    expect(waits.slice(0, 3)).toEqual([16_000, 32_000, 60_000]);
    expect(Math.max(...waits)).toBe(60_000);
    // it opens: both wallets are subscribed again on the new line, and the waits start over
    const line = s.sockets.at(-1)!;
    line.emit("open");
    expect(line.sent.map((m) => m.params[0].mentions[0])).toEqual([A, B]);
    line.emit("close");
    expect(s.timers[0]!.ms).toBe(1000);
    // an event from a line that was already replaced does nothing
    s.sockets[0]!.emit("close");
    s.sockets[0]!.say({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: 101, result: {} } });
    expect(s.mentions).toEqual([]);
    expect(s.timers).toHaveLength(1);
  });

  it("a line that has gone quiet is asked whether it is there, and taken down when it does not answer twice", () => {
    const s = setup();
    s.push.start();
    s.sockets[0]!.emit("open");
    s.push.watch([A]);
    s.sockets[0]!.ack();
    s.push.check();
    const question = s.sockets[0]!.sent.at(-1);
    expect(question).toMatchObject({ method: "logsUnsubscribe", params: [0] });
    // the RPC answers (with an error: there is no such subscription), which is all that was wanted
    s.sockets[0]!.say({ jsonrpc: "2.0", id: question.id, error: { code: -32602, message: "Invalid subscription id." } });
    s.push.check();
    s.push.check();
    expect(s.push.state.connected).toBe(true); // one unanswered question is not yet a dead line
    s.push.check();
    expect(s.push.state.connected).toBe(false);
    expect(s.log).toEqual(["sentinel: the push line stopped answering; reconnecting"]);
    expect(s.sockets[0]!.closed).toBe(true);
    // stopped, it stays down: no timer puts it up again
    s.push.stop();
    s.runTimers();
    expect(s.sockets).toHaveLength(1);
    expect(pushUrlFor("https://api.mainnet-beta.solana.com")).toBe("wss://api.mainnet-beta.solana.com/");
    expect(pushUrlFor("http://127.0.0.1:8899")).toBe("ws://127.0.0.1:8899/");
    expect(pushUrlFor("ftp://x")).toBeNull();
    expect(pushUrlFor("nonsense")).toBeNull();
  });
});

describe("a wallet the RPC has just mentioned", () => {
  const SECONDS = { watch: 60, pro: 20 };

  it("is read next, ahead of everyone's turn, and then takes its turn from that read", async () => {
    const wallets = [A, B, C];
    const store = new MemoryStore(wallets.map((address) => ({ address })));
    const read: string[][] = [];
    const watcher = { passAll: async (only?: (a: string) => boolean) => { read.push(wallets.filter((a) => !only || only(a))); return { raised: [], blind: [] }; } };
    const pace = pacer(() => "watch", SECONDS);
    const round = watchRound({ watcher, store, notifier: { notify: async () => undefined }, pace, blindness: new Blindness(), state: { lastPassAt: null, blind: 0, late: 0 }, log: () => undefined, batch: 1 });
    for (const t of [0, 1, 2]) await round(T0 + t); // everyone's first read, one a round
    await round(T0 + 10);
    expect(read.at(-1)).toEqual([]); // nobody is due for nearly a minute
    expect(pace.hurry(B, T0 + 12)).toBe(true);
    await round(T0 + 12);
    expect(read.at(-1)).toEqual([B]); // ten seconds after its last read, because the RPC said so
    await round(T0 + 14);
    expect(read.at(-1)).toEqual([]);
    // its next turn is a minute from that read, not from the one before
    await round(T0 + 62);
    expect(read.at(-1)).toEqual([A]);
    await round(T0 + 63);
    expect(read.at(-1)).toEqual([C]);
    await round(T0 + 64);
    expect(read.at(-1)).toEqual([]);
    await round(T0 + 72);
    expect(read.at(-1)).toEqual([B]);
  });

  it("goes ahead of wallets that are merely due, and what it is read with is as fresh as the word about it", async () => {
    const pace = pacer(() => "watch", SECONDS);
    for (const w of [A, B, C]) pace.pick(w, T0);
    pace.hurry(C, T0 + 61);
    expect(pace.due([A, B, C], T0 + 61)).toEqual([C, A, B]); // all three are due; the one the RPC spoke of is first
    expect(pace.due([A, B, C], T0 + 61, 1)).toEqual([C]);
    // the list of what is new is asked for at the same commitment the push speaks at
    const asked: any[] = [];
    const rpc = { call: async (method: string, params: any[]) => { if (method === "getSignaturesForAddress") { asked.push(params[1]); return []; } return method === "getAccountInfo" ? { value: { owner: "11111111111111111111111111111111" } } : { value: [] }; } };
    const { Watcher } = await import("../src/watcher.js");
    await new Watcher(rpc, new MemoryStore([{ address: A }]), { notify: async () => undefined }).pass({ address: A });
    expect(asked[0]).toMatchObject({ commitment: "confirmed" });
  });

  it("is not read on the RPC's word more often than every quarter of its promise, however often it is mentioned", () => {
    const pro = new Set([B]);
    const pace = pacer((w) => (pro.has(w) ? "pro" : "watch"), SECONDS);
    pace.pick(A, T0); pace.pick(B, T0);
    let reads = 0;
    // a wallet in a transaction every second for a minute
    for (let t = 1; t <= 60; t++) { pace.hurry(A, T0 + t); if (pace.pick(A, T0 + t)) reads += 1; }
    expect(reads).toBe(4); // every fifteen seconds for a wallet promised a minute
    reads = 0;
    for (let t = 1; t <= 60; t++) { pace.hurry(B, T0 + t); if (pace.pick(B, T0 + t)) reads += 1; }
    expect(reads).toBe(12); // every five for one promised twenty
    // a word about a wallet that is then removed is forgotten with it
    pace.hurry(C, T0 + 100);
    pace.forget((w) => w !== C);
    expect(pace.due([A, B], T0 + 100)).not.toContain(C);
  });
});

describe("the rounds, with the push line looked after", () => {
  it("tell it which wallets to listen for, ask after it twice a minute, and say so when it has been down a quarter of an hour", async () => {
    let connected = true, now = T0;
    const seen: string[][] = [];
    let checks = 0, rounds = 0;
    const said: string[] = [];
    const push = { watch: (w: string[]) => { seen.push(w); }, check: () => { checks += 1; }, get state() { return { connected, listening: 2 }; } };
    const tick = pushedRounds(async () => { rounds += 1; }, push, () => [A, B], { say: async (s: string) => { said.push(s); return true; } }, () => now);
    for (let i = 0; i < 31; i++) { await tick(); now += 2; }
    expect(rounds).toBe(31);
    expect(seen.at(-1)).toEqual([A, B]);
    expect(checks).toBe(3); // at the start, and every thirty seconds
    expect(said).toEqual([]);
    connected = false;
    for (const end = now + LATE_FOR_SECONDS - 2; now < end; now += 2) await tick();
    expect(said).toEqual([]); // not yet a quarter of an hour
    now += 4;
    await tick();
    expect(said[0]).toBe("The RPC has not been telling Sentinel about transactions as they happen for a quarter of an hour (the push line is down). Wallets are still read in turn, at the pace of their plans, so alerts come later than they could.");
    expect(rounds).toBeGreaterThan(400); // and the reading in turn never stopped
    // with no push line at all, a round is a round
    let plain = 0;
    await pushedRounds(async () => { plain += 1; }, null, () => [A])();
    expect(plain).toBe(1);
  });

  it("is on unless turned off, at the RPC's own address unless another is given", () => {
    const base = { SENTINEL_RPC_URL: "https://api.mainnet-beta.solana.com", SENTINEL_DATA_KEY: Buffer.alloc(32, 7).toString("base64") };
    const urlOf = (env: Record<string, string>) => { const c = configFrom({ ...base, ...env }); return c.ok ? c.config.pushUrl : c.why; };
    expect(urlOf({})).toBe("wss://api.mainnet-beta.solana.com/");
    expect(urlOf({ SENTINEL_PUSH: "off" })).toBeNull();
    expect(urlOf({ SENTINEL_RPC_WS_URL: "wss://ws.my-rpc.example/key" })).toBe("wss://ws.my-rpc.example/key");
    expect(urlOf({ SENTINEL_RPC_WS_URL: "https://not-a-websocket.example" })).toBe("SENTINEL_RPC_WS_URL has to be the RPC's websocket address (wss://…).");
  });
});
