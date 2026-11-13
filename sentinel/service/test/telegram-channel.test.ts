/**
 * A Telegram chat as one of a profile's channels: how it gets there (only by the chat itself sending the bot a
 * code made for the profile), what the plans allow, how alerts reach it, how it leaves, and what the owner's
 * other channels are told. The bot's own calls are tested in telegram.test.ts.
 */
import "../../../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { createPrivateKey, sign } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { Accounts } from "../src/accounts.js";
import { unseal } from "../src/crypto.js";
import { configFrom, telegramLinking } from "../src/main.js";
import { ChannelNotifier, type Post } from "../src/notify.js";
import { channelAddedNotice, channelRemovedNotice } from "../src/notices.js";
import { api, type ApiRequest } from "../src/server.js";
import { NonceBook, signInText } from "../src/signin.js";
import { MemoryStore } from "../src/store.js";
import { LINK_SECONDS, LinkCodes, SAID, answer } from "../src/telegram.js";

const ORIGIN = "https://warden.lamportrobotics.com", HOST = "warden.lamportrobotics.com";
const T0 = 1_794_312_000;
const KEY = Buffer.alloc(32, 9);
const NTFY = "https://ntfy.sh/alice-topic-123456";
const DISCORD = ["https://discord.com/api", "webhooks", "123456789012345678", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcd"].join("/");

function walletOf(n: number) {
  const seed = new Uint8Array(32).fill(n);
  const address = Keypair.fromSeed(seed).publicKey.toBase58();
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]), format: "der", type: "pkcs8" });
  return { address, sign: (message: Uint8Array) => new Uint8Array(sign(null, message, key)) };
}
const alice = walletOf(1), bob = walletOf(5);

function service(opts: { telegram?: boolean } = {}) {
  const store = new MemoryStore();
  const accounts = new Accounts(store, KEY);
  const codes = new LinkCodes();
  const posted: { url: string; body: string }[] = [], chats: { chat: string; text: string; quiet: boolean }[] = [];
  const post: Post = async (url, init) => { posted.push({ url, body: init.body }); return { ok: true, status: 200 }; };
  let botAnswers: { ok: boolean; status: number | null } = { ok: true, status: 200 };
  const bot = { send: async (chat: string, text: string, quiet = false) => { chats.push({ chat, text, quiet }); return botAnswers; } };
  const notifier = new ChannelNotifier(accounts, post, { now: () => T0, ...(opts.telegram === false ? {} : { telegram: bot }) });
  let now = T0;
  const handle = api({ accounts, store, watcher: { ownerSigned: async () => undefined, confirmOwn: async () => true }, nonces: new NonceBook(), origin: ORIGIN, now: () => now, notice: (p, s, o) => notifier.notice(p, s, o), testChannel: (p, id) => notifier.test(p, id), ...(opts.telegram === false ? {} : { telegram: { username: "WardenSentinelBot", codes } }) });
  const call = (method: string, path: string, body?: unknown, bearer: string | null = null) => handle({ method, path, body, bearer, ip: "10.0.0.1" } satisfies ApiRequest);
  const signIn = async (w: ReturnType<typeof walletOf>) => {
    const n = await call("POST", "/v1/nonce", {});
    const message = new TextEncoder().encode(signInText({ host: HOST, address: w.address, nonce: (n.body as any).nonce, purpose: "signin", issuedAt: new Date(now * 1000).toISOString() }));
    const r = await call("POST", "/v1/signin", { address: w.address, message: Buffer.from(message).toString("base64"), signature: Buffer.from(w.sign(message)).toString("base64") });
    return (r.body as any).session as string;
  };
  const linking = telegramLinking(accounts, (p, s) => notifier.notice(p, s), () => now);
  /** What a chat sending the bot this text leads to, and what the bot says back. */
  const says = (chat: string, text: string) => answer({ chat, text }, { codes, ...linking }, now);
  const codeOf = (url: string) => new URL(url).searchParams.get("start")!;
  return { store, accounts, codes, posted, chats, call, signIn, says, codeOf, linking, notifier, tick: (s: number) => { now += s; }, botRefuses: (status: number | null) => { botAnswers = { ok: false, status }; } };
}

describe("connecting a Telegram chat", () => {
  it("is offered only where the service has a bot", async () => {
    const without = service({ telegram: false });
    const session = await without.signIn(alice);
    expect(((await without.call("GET", "/v1/me", undefined, session)).body as any).limits.kinds).toEqual(["ntfy"]);
    expect(await without.call("POST", "/v1/channels/telegram", {}, session)).toEqual({ status: 501, body: { error: "Telegram alerts are not switched on here." } });
    const s = service();
    expect(((await s.call("GET", "/v1/me", undefined, await s.signIn(alice))).body as any).limits.kinds).toEqual(["ntfy", "telegram"]);
    expect((await s.call("POST", "/v1/channels/telegram", {})).status).toBe(401); // and only to someone signed in
  });

  it("goes by a one-time code that the chat itself sends the bot, and the profile's channels are told", async () => {
    const s = service();
    const session = await s.signIn(alice);
    const r = await s.call("POST", "/v1/channels/telegram", {}, session);
    expect(r.status).toBe(201);
    const { url, seconds } = r.body as { url: string; seconds: number };
    expect(url).toMatch(/^https:\/\/t\.me\/WardenSentinelBot\?start=[A-Za-z0-9_-]{24}$/);
    expect(seconds).toBe(LINK_SECONDS);
    // nothing is a channel until the chat has spoken
    expect(((await s.call("GET", "/v1/me", undefined, session)).body as any).channels).toEqual([]);

    expect(await s.says("5550001234", `/start ${s.codeOf(url)}`)).toBe(SAID.linked);
    const me = (await s.call("GET", "/v1/me", undefined, session)).body as any;
    expect(me.channels).toMatchObject([{ kind: "telegram", hint: "Telegram chat …1234", active: true }]);
    // the chat's number is sealed in the data, like any channel's address
    const stored = s.store.accounts.channels[0]!;
    expect(stored.target).not.toContain("5550001234");
    expect(unseal(KEY, stored.target)).toBe("telegram:5550001234");
    // and the profile's channels (this one is the only one) hear that it was added
    expect(s.chats).toEqual([{ chat: "5550001234", text: `Warden Sentinel: your profile\n${channelAddedNotice("Telegram chat …1234", null)}`, quiet: false }]);

    // the same link again, from another chat: nothing
    expect(await s.says("666", `/start ${s.codeOf(url)}`)).toBe(SAID.stale);
    expect(s.accounts.telegramChannels("666")).toEqual([]);
  });

  it("cannot be done by typing a chat in as an address", async () => {
    const s = service();
    const session = await s.signIn(alice);
    for (const typed of ["telegram:5550001234", "tg://5550001234", "https://t.me/someone"]) expect((await s.call("POST", "/v1/channels", { target: typed }, session)).status, typed).toBe(400);
    expect(s.accounts.addTelegram(s.accounts.profileOf(alice.address)!, "not-a-chat", T0)).toMatchObject({ ok: false, status: 400 });
  });

  it("keeps to the plan's number of channels, and says so in the chat", async () => {
    const s = service();
    const session = await s.signIn(alice);
    expect((await s.call("POST", "/v1/channels", { target: NTFY }, session)).status).toBe(201);
    // the free plan has one channel and it is taken: the page is told before anyone is sent to Telegram
    expect(await s.call("POST", "/v1/channels/telegram", {}, session)).toEqual({ status: 403, body: { error: "this plan has one alert channel. Remove it to use another, or move to Pro for five." } });
    // a code made while there was room, used when there no longer is: the chat is told why, as a sentence
    const profile = s.accounts.profileOf(alice.address)!;
    const code = s.codes.issue(profile, T0);
    expect(await s.says("5550001234", `/start ${code}`)).toBe("This plan has one alert channel. Remove it to use another, or move to Pro for five.");
    expect(s.accounts.telegramChannels("5550001234")).toEqual([]);
  });

  it("is one channel however often the same chat connects, and says it once", async () => {
    const s = service();
    await s.signIn(alice);
    const profile = s.accounts.profileOf(alice.address)!;
    expect(await s.says("5550001234", `/start ${s.codes.issue(profile, T0)}`)).toBe(SAID.linked);
    expect(await s.says("5550001234", `/start ${s.codes.issue(profile, T0)}`)).toBe(SAID.linked);
    expect(s.accounts.telegramChannels("5550001234")).toHaveLength(1);
    expect(s.chats.filter((c) => c.text.includes("was added"))).toHaveLength(1);
  });
});

describe("alerts to a Telegram chat", () => {
  async function linked(opts: { pro?: boolean } = {}) {
    const s = service();
    const session = await s.signIn(alice);
    const profile = s.accounts.profileOf(alice.address)!;
    if (opts.pro) s.accounts.setTier(profile, "pro");
    await s.says("5550001234", `/start ${s.codes.issue(profile, T0)}`);
    s.chats.length = 0;
    return { ...s, session, profile };
  }

  it("go through the bot, to that chat, with the wallet in the title", async () => {
    const s = await linked();
    expect(await s.notifier.notify(alice.address, "urgent", "25 USDC left your wallet in a transaction your wallet did not sign.")).toEqual({ delivered: 1, failed: 0 });
    expect(s.chats).toEqual([{ chat: "5550001234", text: `Warden Sentinel: urgent (${alice.address.slice(0, 4)}..${alice.address.slice(-4)})\n25 USDC left your wallet in a transaction your wallet did not sign.`, quiet: false }]);
    expect(s.posted).toEqual([]); // nothing was posted to an address: a chat has none
    // a test from the page reaches it too
    const id = s.accounts.channelViews(s.profile)[0]!.id;
    expect((await s.call("POST", `/v1/channels/${id}/test`, {}, s.session)).status).toBe(200);
    expect(s.chats.at(-1)!.text).toContain("This is a test from Warden Sentinel.");
    expect(s.accounts.channelViews(s.profile)[0]).toMatchObject({ failing: null, lastDeliveredAt: T0 });
  });

  it("show on the page when the chat has blocked the bot, and say so on the owner's other channels", async () => {
    const s = await linked({ pro: true });
    expect((await s.call("POST", "/v1/channels", { target: NTFY }, s.session)).status).toBe(201);
    s.posted.length = 0;
    s.botRefuses(403);
    expect(await s.notifier.notify(alice.address, "alert", "Something happened.")).toEqual({ delivered: 1, failed: 1 });
    expect(s.accounts.channelViews(s.profile).find((c) => c.kind === "telegram")!.failing).toEqual({ since: T0, why: "it answered 403" });
    expect(s.posted.map((p) => p.body).join("\n")).toContain("An alert could not be delivered to another of this profile's channels (Telegram chat …1234): it answered 403.");
  });

  it("are not sent anywhere by a service that has lost its bot, and the channel says so", async () => {
    const s = service();
    await s.signIn(alice);
    const profile = s.accounts.profileOf(alice.address)!;
    s.accounts.addTelegram(profile, "5550001234", T0);
    const botless = new ChannelNotifier(s.accounts, async () => ({ ok: true, status: 200 }), { now: () => T0 });
    expect(await botless.notify(alice.address, "alert", "Something happened.")).toEqual({ delivered: 0, failed: 1 });
    expect(s.accounts.channelViews(profile)[0]!.failing).toEqual({ since: T0, why: "it could not be reached" });
  });
});

describe("leaving", () => {
  it("/stop in the chat ends it, after the profile's channels, that chat among them, are told", async () => {
    const s = service();
    const session = await s.signIn(alice);
    const profile = s.accounts.profileOf(alice.address)!;
    s.accounts.setTier(profile, "pro");
    await s.call("POST", "/v1/channels", { target: NTFY }, session);
    await s.says("5550001234", `/start ${s.codes.issue(profile, T0)}`);
    s.chats.length = 0; s.posted.length = 0;
    expect(await s.says("5550001234", "/stop")).toBe(SAID.stopped);
    expect(s.accounts.telegramChannels("5550001234")).toEqual([]);
    const said = channelRemovedNotice("Telegram chat …1234", null);
    expect(s.chats.map((c) => c.text)).toEqual([`Warden Sentinel: your profile\n${said}`]);
    expect(s.posted.map((p) => p.body)).toEqual([said]);
    expect(s.accounts.channelViews(profile).map((c) => c.kind)).toEqual(["ntfy"]);
    // again, and from a chat that never was one: nothing to stop
    expect(await s.says("5550001234", "/stop")).toBe(SAID.notLinked);
    expect(await s.says("42", "/stop")).toBe(SAID.notLinked);
  });

  it("the page removes it like any channel, and one profile's /stop is not another's", async () => {
    const s = service();
    const a = await s.signIn(alice), b = await s.signIn(bob);
    const pa = s.accounts.profileOf(alice.address)!, pb = s.accounts.profileOf(bob.address)!;
    // a group chat that two owners both send their alerts to
    await s.says("-1009876543210", `/start ${s.codes.issue(pa, T0)}`);
    await s.says("-1009876543210", `/start ${s.codes.issue(pb, T0)}`);
    expect(s.accounts.telegramChannels("-1009876543210").map((c) => c.profile).sort()).toEqual([pa, pb].sort());
    const id = s.accounts.channelViews(pa)[0]!.id;
    expect((await s.call("DELETE", `/v1/channels/${id}`, undefined, b)).status).toBe(404); // not bob's to remove
    expect((await s.call("DELETE", `/v1/channels/${id}`, undefined, a)).status).toBe(200);
    expect(s.accounts.telegramChannels("-1009876543210").map((c) => c.profile)).toEqual([pb]);
    // /stop typed in a group ends nothing: any member could type it, and it would end every owner's alerts there
    expect(await s.says("-1009876543210", "/stop")).toBe(SAID.inGroup);
    expect(await s.says("-1009876543210", "/stop@WardenSentinelBot")).toBe(SAID.inGroup);
    expect(s.accounts.telegramChannels("-1009876543210").map((c) => c.profile)).toEqual([pb]);
    // bob ends his on the page
    expect((await s.call("DELETE", `/v1/channels/${s.accounts.channelViews(pb)[0]!.id}`, undefined, b)).status).toBe(200);
    expect(s.accounts.channelViews(pb)).toEqual([]);
  });
});

describe("the bot's token", () => {
  const base = { SENTINEL_RPC_URL: "https://rpc.example", SENTINEL_DATA_KEY: Buffer.alloc(32, 1).toString("base64") };
  const token = ["7123456789", "AAH" + "x".repeat(32)].join(":");
  it("is optional, has to look like one, and is not repeated when it does not", () => {
    expect(configFrom(base)).toMatchObject({ ok: true, config: { telegramToken: null } });
    expect(configFrom({ ...base, SENTINEL_TELEGRAM_BOT_TOKEN: ` ${token} ` })).toMatchObject({ ok: true, config: { telegramToken: token } });
    const bad = configFrom({ ...base, SENTINEL_TELEGRAM_BOT_TOKEN: "123:not-long-enough-to-be-one" });
    expect(bad).toEqual({ ok: false, why: "SENTINEL_TELEGRAM_BOT_TOKEN is not a bot token as BotFather gives them (a number, a colon, and a long secret)." });
    expect(JSON.stringify(bad)).not.toContain("not-long-enough");
  });
});
