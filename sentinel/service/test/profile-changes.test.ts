/**
 * A stolen key is what Sentinel is for, and whoever has one can sign in here with it. These tests are about
 * what that person can do unnoticed (nothing that makes the profile watch less), how many places one visitor
 * can take, and what a name that every object answers to can reach (nothing).
 */
import "../../../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { createPrivateKey, sign } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { Accounts } from "../src/accounts.js";
import { channelAddedNotice, channelRemovedNotice, reportLinkedNotice, signedInNotice, walletRemovedNotice } from "../src/notices.js";
import { ChannelNotifier, type Post } from "../src/notify.js";
import { api, listen, networkOf, type ApiRequest } from "../src/server.js";
import { NonceBook, signInText } from "../src/signin.js";
import { MemoryStore } from "../src/store.js";

const ORIGIN = "https://warden.lamportrobotics.com";
const HOST = "warden.lamportrobotics.com";
const T0 = 1_794_312_000;

function walletOf(n: number) {
  const seed = new Uint8Array(32).fill(n);
  const address = Keypair.fromSeed(seed).publicKey.toBase58();
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]), format: "der", type: "pkcs8" });
  return { address, sign: (message: Uint8Array) => new Uint8Array(sign(null, message, key)) };
}
const alice = walletOf(1), second = walletOf(2), thief = walletOf(3);
const short = (a: string) => `${a.slice(0, 4)}..${a.slice(-4)}`;
const NTFY = "https://ntfy.sh/alice-topic-123";
// made-up addresses in each service's shape, put together here so no line reads as a real webhook to a secret scanner
const DISCORD = ["https://discord.com/api", "webhooks", "123456789012345678", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcd"].join("/");

function service(opts: { newProfilesPerDay?: number } = {}) {
  const store = new MemoryStore();
  const accounts = new Accounts(store, Buffer.alloc(32, 9));
  const nonces = new NonceBook();
  const posts: { url: string; title: string; priority?: string; body: string }[] = [];
  const post: Post = async (url, init) => { posts.push({ url, title: init.headers.Title ?? "", priority: init.headers.Priority, body: init.body }); return { ok: true, status: 200 }; };
  const notifier = new ChannelNotifier(accounts, post, { now: () => T0 });
  let now = T0;
  const handle = api({ accounts, store, watcher: { ownerSigned: async () => undefined, confirmOwn: async () => true }, nonces, origin: ORIGIN, now: () => now, notice: (p, s, o) => notifier.notice(p, s, o), ...opts });
  const call = (method: string, path: string, body?: unknown, bearer: string | null = null, ip = "10.0.0.1") => handle({ method, path, body, bearer, ip } satisfies ApiRequest);
  const signIn = async (w: ReturnType<typeof walletOf>, o: { session?: string; ip?: string } = {}) => {
    const link = !!o.session;
    const n = await call("POST", "/v1/nonce", link ? { purpose: "link" } : {}, o.session ?? null, o.ip);
    const message = new TextEncoder().encode(signInText({ host: HOST, address: w.address, nonce: (n.body as any).nonce, purpose: link ? "link" : "signin", issuedAt: new Date(now * 1000).toISOString() }));
    return call("POST", "/v1/signin", { address: w.address, message: Buffer.from(message).toString("base64"), signature: Buffer.from(w.sign(message)).toString("base64") }, o.session ?? null, o.ip);
  };
  /** Alice, signed in, with one ntfy channel; what was posted so far is cleared. */
  const withChannel = async () => {
    const session = ((await signIn(alice)).body as any).session as string;
    const channel = (await call("POST", "/v1/channels", { target: NTFY }, session)).body as { id: string; hint: string };
    posts.length = 0;
    return { session, channel };
  };
  return { store, accounts, posts, call, signIn, withChannel, tick: (s: number) => { now += s; } };
}

describe("a change that makes a profile watch less", () => {
  it("removing a channel is said on that channel before it goes, naming the wallet that signed in", async () => {
    const s = service();
    const { session, channel } = await s.withChannel();
    expect((await s.call("DELETE", `/v1/channels/${channel.id}`, undefined, session)).status).toBe(200);
    expect(s.posts).toEqual([{ url: NTFY, title: "Warden Sentinel: your profile", priority: "3", body: channelRemovedNotice(channel.hint, alice.address) }]);
    expect(s.posts[0]!.body).toBe(`An alert channel (ntfy.sh/…-123) was removed from this profile, by someone signed in with ${short(alice.address)}. Alerts no longer go there. If that was not you, someone else has the key to ${short(alice.address)}.`);
    expect(s.posts[0]!.body).not.toMatch(/https?:\/\//); // like every alert: no link
    expect(s.accounts.channelsOf(s.accounts.profileOf(alice.address)!)).toEqual([]);
    // a channel that is not there is not announced
    expect((await s.call("DELETE", `/v1/channels/${channel.id}`, undefined, session)).status).toBe(404);
    expect(s.posts).toHaveLength(1);
  });

  it("removing a wallet is said first, and so is the end of the profile with its last one", async () => {
    const s = service();
    const { session } = await s.withChannel();
    await s.signIn(second, { session });
    s.posts.length = 0;

    expect((await s.call("DELETE", `/v1/wallets/${second.address}`, undefined, session)).body).toEqual({ ok: true, profileRemoved: false });
    expect(s.posts.map((p) => p.body)).toEqual([walletRemovedNotice(second.address, false, alice.address)]);
    expect(s.posts[0]!.body).toContain(`Sentinel has stopped watching ${short(second.address)}: it was removed from this profile`);

    // the last wallet takes the profile and its channel with it, and the channel still hears why
    expect((await s.call("DELETE", `/v1/wallets/${alice.address}`, undefined, session)).body).toEqual({ ok: true, profileRemoved: true });
    expect(s.posts[1]).toMatchObject({ url: NTFY, body: walletRemovedNotice(alice.address, true, alice.address) });
    expect(s.posts[1]!.body).toContain("this profile is gone");
    // a wallet that is not the profile's is refused before anything is said
    const other = ((await s.signIn(thief)).body as any).session;
    await s.call("POST", "/v1/channels", { target: "https://ntfy.sh/thief-topic-456" }, other);
    s.posts.length = 0;
    expect((await s.call("DELETE", `/v1/wallets/${alice.address}`, undefined, other)).status).toBe(404);
    expect(s.posts).toEqual([]);
  });

  it("a thief who signs in with one wallet of a profile is named by that wallet in everything that follows", async () => {
    const s = service();
    const { session } = await s.withChannel();
    await s.signIn(second, { session }); // the owner's other wallet, which is the one that leaks
    s.posts.length = 0;

    const theirs = ((await s.signIn(second)).body as any).session as string;
    expect(s.posts).toEqual([{ url: NTFY, title: "Warden Sentinel: your profile", priority: "2", body: signedInNotice(second.address) }]); // quiet: a line, not a buzz
    expect(s.posts[0]!.body).toBe(`${short(second.address)} signed in to Sentinel just now. If that was not you, someone else has the key to ${short(second.address)}.`);

    const channels = ((await s.call("GET", "/v1/me", undefined, theirs)).body as any).channels;
    await s.call("DELETE", `/v1/channels/${channels[0].id}`, undefined, theirs);
    expect(s.posts[1]!.body).toContain(`by someone signed in with ${short(second.address)}`);
    expect(s.posts[1]!.priority).toBe("3");
  });

  it("adding a channel, and linking a browser to report signatures, are said too", async () => {
    const s = service();
    const { session } = await s.withChannel();
    s.accounts.setTier(s.accounts.profileOf(alice.address)!, "pro");
    const added = (await s.call("POST", "/v1/channels", { target: DISCORD }, session)).body as { hint: string };
    // to the channel it already had, and to the new one
    expect(s.posts.map((p) => p.url)).toEqual([NTFY, DISCORD]);
    expect(s.posts[0]!.body).toBe(channelAddedNotice(added.hint, alice.address));
    s.posts.length = 0;

    expect((await s.call("POST", `/v1/wallets/${alice.address}/report-token`, undefined, session)).status).toBe(200);
    expect(s.posts[0]!.body).toBe(reportLinkedNotice(alice.address, alice.address));
    expect(s.posts[0]!.body).toContain("What it reports is treated as yours.");
    s.posts.length = 0;
    // someone else's wallet: refused, and nothing said
    expect((await s.call("POST", `/v1/wallets/${thief.address}/report-token`, undefined, session)).status).toBe(404);
    expect(s.posts).toEqual([]);
  });

  it("a session whose wallet has left the profile is not named as that wallet", async () => {
    const s = service();
    const { session } = await s.withChannel();
    await s.signIn(second, { session });
    const viaSecond = ((await s.signIn(second)).body as any).session as string;
    await s.call("DELETE", `/v1/wallets/${second.address}`, undefined, session);
    s.posts.length = 0;
    const channels = ((await s.call("GET", "/v1/me", undefined, viaSecond)).body as any).channels;
    await s.call("DELETE", `/v1/channels/${channels[0].id}`, undefined, viaSecond);
    expect(s.posts[0]!.body).toBe(channelRemovedNotice(channels[0].hint, null));
    expect(s.posts[0]!.body).toContain("someone else has the key to one of this profile's wallets.");
  });

  it("is said a few times an hour and no more, and a profile is changed only so often", async () => {
    const s = service();
    await s.withChannel();
    for (let i = 0; i < 8; i++) { await s.signIn(alice); s.tick(10); }
    expect(s.posts.filter((p) => p.body === signedInNotice(alice.address))).toHaveLength(6); // signing in still worked each time
    s.tick(3600);
    await s.signIn(alice);
    expect(s.posts.filter((p) => p.body === signedInNotice(alice.address))).toHaveLength(7);

    // twenty changes an hour: the twenty-first is refused, and nothing is removed or said
    const session = ((await s.signIn(alice)).body as any).session as string;
    s.tick(3600);
    s.posts.length = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const id = ((await s.call("GET", "/v1/me", undefined, session)).body as any).channels[0]?.id;
      statuses.push((await s.call("DELETE", `/v1/channels/${id}`, undefined, session)).status);
      statuses.push((await s.call("POST", "/v1/channels", { target: NTFY }, session)).status);
    }
    expect(statuses).toEqual([...Array.from({ length: 10 }, () => [200, 201]).flat(), 429, 429]);
    expect(s.posts).toHaveLength(20);
    expect(((await s.call("GET", "/v1/me", undefined, session)).body as any).channels).toHaveLength(1); // still there
  });

  it("the addresses are taken when the notice is called for, so a slow channel still hears of its own removal", async () => {
    const store = new MemoryStore();
    const accounts = new Accounts(store, Buffer.alloc(32, 9));
    const admitted = accounts.admit(alice.address, null, T0);
    const profile = admitted.ok ? admitted.profile : "";
    const channel = accounts.addChannel(profile, NTFY, T0);
    const started: string[] = [];
    let finish = () => {};
    const notifier = new ChannelNotifier(accounts, (url) => { started.push(url); return new Promise((r) => { finish = () => r({ ok: true, status: 200 }); }); });
    const sent = notifier.notice(profile, "x");
    accounts.removeChannel(profile, channel.ok ? channel.channel.id : "");
    expect(started).toEqual([NTFY]); // already on its way when the channel went
    finish();
    await expect(sent).resolves.toBeUndefined();
    // and a channel that fails does not make a notice throw
    const failing = new ChannelNotifier(accounts, async () => { throw new Error("down"); });
    accounts.addChannel(profile, NTFY, T0);
    await expect(failing.notice(profile, "x")).resolves.toBeUndefined();
    expect(failing.undelivered).toHaveLength(1);
  });
});

describe("how many places one visitor can take", () => {
  it("one network starts a few profiles a day; wallets already here still sign in, and other networks are not held back", async () => {
    const s = service();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await s.signIn(walletOf(50 + i))).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect(s.store.wallets()).toHaveLength(5);
    expect(((await s.signIn(walletOf(57))).body as any).error).toBe("too many new profiles were started from this network today. Try again tomorrow.");
    // a wallet Sentinel already watches signs in from there all the same
    s.tick(61);
    expect((await s.signIn(walletOf(50))).status).toBe(200);
    // someone else, somewhere else
    expect((await s.signIn(walletOf(60), { ip: "10.0.0.2" })).status).toBe(200);
    // and tomorrow
    s.tick(86_400);
    expect((await s.signIn(walletOf(61))).status).toBe(200);
  });

  it("an IPv6 visitor is counted by the /64 they were given, not by each address in it", async () => {
    expect(networkOf("203.0.113.9")).toBe("203.0.113.9");
    expect(networkOf("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(networkOf("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(networkOf("2001:0db8:0001:0002::1")).toBe("2001:db8:1:2::/64");
    expect(networkOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(networkOf("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(networkOf("::1")).toBe("0:0:0:0::/64");
    expect(networkOf("unknown")).toBe("unknown");

    const s = service({ newProfilesPerDay: 2 });
    expect((await s.signIn(walletOf(70), { ip: "2001:db8:1:2::1" })).status).toBe(200);
    expect((await s.signIn(walletOf(71), { ip: "2001:db8:1:2:ffff:ffff:ffff:ffff" })).status).toBe(200);
    expect((await s.signIn(walletOf(72), { ip: "2001:db8:1:2:1234::5" })).status).toBe(429);
    expect((await s.signIn(walletOf(72), { ip: "2001:db8:1:3::1" })).status).toBe(200); // the next /64 is someone else
  });

  it("a profile cannot add and remove wallets in a loop to spend the RPC", async () => {
    const s = service();
    const session = ((await s.signIn(alice)).body as any).session as string;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      s.tick(30); // under the sign-in pace
      const w = walletOf(100 + i);
      statuses.push((await s.signIn(w, { session })).status);
      await s.call("DELETE", `/v1/wallets/${w.address}`, undefined, session);
    }
    expect(statuses).toEqual([...Array<number>(10).fill(200), 429]);
    expect(s.store.wallets()).toEqual([{ address: alice.address }]);
  });

  it("behind a proxy, the caller is whoever the proxy says, not whoever the caller says", async () => {
    const store = new MemoryStore();
    const accounts = new Accounts(store, Buffer.alloc(32, 9));
    const server = await listen({ accounts, store, watcher: { ownerSigned: async () => undefined, confirmOwn: async () => true }, nonces: new NonceBook(), origin: ORIGIN }, { port: 0, trustProxy: true });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      // thirty numbers a minute per caller: a caller who writes a different address in front each time is still one caller
      const statuses: number[] = [];
      for (let i = 0; i < 32; i++) statuses.push((await fetch(`${base}/v1/nonce`, { method: "POST", headers: { "x-forwarded-for": `198.51.100.${i}, 203.0.113.7` }, body: "{}" })).status);
      expect(statuses.slice(0, 30).every((x) => x === 200)).toBe(true);
      expect(statuses.slice(30)).toEqual([429, 429]);
      expect((await fetch(`${base}/v1/nonce`, { method: "POST", headers: { "x-forwarded-for": "203.0.113.8" }, body: "{}" })).status).toBe(200);
      // too much is answered, not hung up on
      const big = await fetch(`${base}/v1/nonce`, { method: "POST", headers: { "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify({ pad: "x".repeat(40_000) }) });
      expect(big.status).toBe(413);
      expect(await big.json()).toEqual({ error: "that request is too large." });
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  });
});

describe("a name every object answers to", () => {
  it("is not a profile, a wallet or a record", async () => {
    const s = service();
    const session = ((await s.signIn(alice)).body as any).session as string;
    for (const name of ["__proto__", "constructor", "__defineGetter__", "hasOwnProperty", "toString"]) {
      expect(s.accounts.profile(name)).toBeUndefined();
      expect(s.accounts.profileOf(name)).toBeUndefined();
      expect(s.accounts.walletsOf(name)).toEqual([]);
      expect(s.accounts.mayReport(name, "x".repeat(43))).toBe(false);
      s.accounts.setBilling(name, { customer: "cus_x", subscription: "sub_x", price: "full", status: "active" });
      s.accounts.setTier(name, "pro");
      expect(s.store.record(name)).toMatchObject({ cursor: null, baseline: null });
      expect((await s.call("DELETE", `/v1/wallets/${name}`, undefined, session)).status).toBe(404);
      expect((await s.call("POST", `/v1/wallets/${name}/report-token`, undefined, session)).status).toBe(404);
      expect((await s.call("DELETE", `/v1/channels/${name}`, undefined, session)).status).toBe(404);
    }
    // nothing was written onto every object
    expect(({} as any).billing).toBeUndefined();
    expect(({} as any).tier).toBeUndefined();
    expect(s.accounts.profile(s.accounts.profileOf(alice.address)!)).toMatchObject({ tier: "watch" });
    expect(s.accounts.profile(s.accounts.profileOf(alice.address)!)!.billing).toBeUndefined();
  });
});
