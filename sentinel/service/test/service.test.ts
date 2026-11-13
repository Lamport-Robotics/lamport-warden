/**
 * The service around the watcher: who may sign in, what a session and a report token can do, where alerts may
 * be sent, and what the stored file gives away.
 */
import "../../../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { Accounts, SESSION_SECONDS, cleanNtfyTarget, cleanTarget } from "../src/accounts.js";
import { dataKeyFrom, hashToken, seal, unseal, verifyWalletSignature } from "../src/crypto.js";
import { configFrom, pacer, startRounds } from "../src/main.js";
import { ChannelNotifier, messageFor, type Post } from "../src/notify.js";
import { RateLimiter, api, corsHeaders, listen, type ApiRequest } from "../src/server.js";
import { LINK_STATEMENT, NonceBook, parseSignInText, signInText, verifySignIn } from "../src/signin.js";
import { FileStore, MemoryStore } from "../src/store.js";

const ORIGIN = "https://warden.lamportrobotics.com";
const HOST = "warden.lamportrobotics.com";
const T0 = 1_794_312_000;
const KEY = Buffer.alloc(32, 9);

/** A wallet that can sign: the test's stand-in for Phantom. */
function walletOf(n: number) {
  const seed = new Uint8Array(32).fill(n);
  const address = Keypair.fromSeed(seed).publicKey.toBase58();
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]), format: "der", type: "pkcs8" });
  return { address, sign: (message: Uint8Array) => new Uint8Array(sign(null, message, key)) };
}
const alice = walletOf(1), second = walletOf(2), third = walletOf(3), fourth = walletOf(4), bob = walletOf(5);
const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const iso = (unix: number) => new Date(unix * 1000).toISOString();

function service(opts: { store?: MemoryStore } = {}) {
  const store = opts.store ?? new MemoryStore();
  const accounts = new Accounts(store, KEY);
  const nonces = new NonceBook();
  const calls = { ownerSigned: [] as [string, string][], confirmOwn: [] as [string, string][] };
  const watcher = {
    ownerSigned: async (w: string, s: string) => { calls.ownerSigned.push([w, s]); },
    confirmOwn: async (w: string, s: string) => { calls.confirmOwn.push([w, s]); return true; },
  };
  let now = T0;
  const handle = api({ accounts, store, watcher, nonces, origin: ORIGIN, now: () => now });
  const call = (method: string, path: string, body?: unknown, bearer: string | null = null, ip = "10.0.0.1") => handle({ method, path, body, bearer, ip } satisfies ApiRequest);
  /** Signs in the way the page does: ask for a number, have the wallet sign the text, send both. */
  const signIn = async (w: ReturnType<typeof walletOf>, o: { session?: string; ip?: string } = {}) => {
    const link = !!o.session;
    const n = await call("POST", "/v1/nonce", link ? { purpose: "link" } : {}, o.session ?? null, o.ip);
    const message = utf8(signInText({ host: HOST, address: w.address, nonce: (n.body as any).nonce, purpose: link ? "link" : "signin", issuedAt: iso(now) }));
    return call("POST", "/v1/signin", { address: w.address, message: b64(message), signature: b64(w.sign(message)) }, o.session ?? null, o.ip);
  };
  return { store, accounts, nonces, calls, call, signIn, tick: (s: number) => { now += s; }, now: () => now };
}

describe("a wallet's signature", () => {
  it("is checked against the address, the exact bytes, and nothing else", () => {
    const m = utf8("hello");
    expect(verifyWalletSignature(alice.address, m, alice.sign(m))).toBe(true);
    expect(verifyWalletSignature(bob.address, m, alice.sign(m))).toBe(false);
    expect(verifyWalletSignature(alice.address, utf8("hellp"), alice.sign(m))).toBe(false);
    expect(verifyWalletSignature(alice.address, m, alice.sign(m).slice(0, 63))).toBe(false);
    expect(verifyWalletSignature("not an address", m, alice.sign(m))).toBe(false);
  });

  it("a sealed box opens only with its key, and not after it was changed", () => {
    const box = seal(KEY, "https://ntfy.sh/my-secret-topic");
    expect(box).not.toContain("secret");
    expect(unseal(KEY, box)).toBe("https://ntfy.sh/my-secret-topic");
    expect(unseal(Buffer.alloc(32, 8), box)).toBeNull();
    const raw = Buffer.from(box, "base64"); raw[raw.length - 1]! ^= 1;
    expect(unseal(KEY, raw.toString("base64"))).toBeNull();
    expect(dataKeyFrom(randomBytes(32).toString("base64"))).toHaveLength(32);
    expect(dataKeyFrom("too short")).toBeNull();
    expect(dataKeyFrom(undefined)).toBeNull();
  });
});

describe("the sign-in text", () => {
  const text = (o: Partial<{ host: string; address: string; nonce: string; statement: string; extra: string[] }> = {}, nonce = "") =>
    [`${o.host ?? HOST} wants you to sign in with your Solana account:`, o.address ?? alice.address, "", o.statement ?? "Sign in to Warden Sentinel.", "", ...(o.extra ?? []), `Nonce: ${o.nonce ?? nonce}`, `Issued At: ${iso(T0)}`].join("\n");
  const attempt = (message: string, book: NonceBook, by = alice, address = alice.address, now = T0) => verifySignIn({ address, message: utf8(message), signature: by.sign(utf8(message)) }, HOST, book, now);

  it("is read as a wallet writes it, with or without the optional lines", () => {
    const full = `${HOST} wants you to sign in with your Solana account:\n${alice.address}\n\nSign in to Warden Sentinel.\n\nURI: ${ORIGIN}/sentinel\nVersion: 1\nChain ID: mainnet\nNonce: abcdef0123456789\nIssued At: ${iso(T0)}\nResources:\n- https://example.org`;
    expect(parseSignInText(full)).toMatchObject({ domain: HOST, address: alice.address, statement: "Sign in to Warden Sentinel.", fields: { URI: `${ORIGIN}/sentinel`, Version: "1", "Chain ID": "mainnet", Nonce: "abcdef0123456789" } });
    expect(parseSignInText(`${HOST} wants you to sign in with your Solana account:\n${alice.address}\n\nNonce: abcdef0123456789`)).toMatchObject({ statement: null });
    expect(parseSignInText("Please sign this to continue")).toBeNull();
    // a second Nonce line, or words after the fields, is not something a wallet writes
    expect(parseSignInText(`${text({ nonce: "aaaaaaaa" })}\nNonce: bbbbbbbb`)).toBeNull();
    expect(parseSignInText(`${text({ nonce: "aaaaaaaa" })}\nand also send everything`)).toBeNull();
  });

  it("signs in once, with a number this service issued", () => {
    const book = new NonceBook();
    const nonce = book.issue({ kind: "signin" }, T0);
    const message = text({ nonce });
    expect(attempt(message, book)).toEqual({ ok: true, address: alice.address, purpose: { kind: "signin" } });
    // the same signed text again: the number is spent
    expect(attempt(message, book)).toMatchObject({ ok: false });
    // a number nobody issued
    expect(attempt(text({ nonce: "f".repeat(32) }), book)).toMatchObject({ ok: false });
    // a number that waited too long
    const old = book.issue({ kind: "signin" }, T0);
    expect(attempt(text({ nonce: old }), book, alice, alice.address, T0 + 301)).toMatchObject({ ok: false });
  });

  it("refuses a text for another site, another wallet, another purpose, or another time", () => {
    const book = new NonceBook();
    const n = () => book.issue({ kind: "signin" }, T0);
    expect(attempt(text({ nonce: n(), host: "warden.lamportrobotics.com.evil.example" }), book)).toEqual({ ok: false, why: "that text signs in to warden.lamportrobotics.com.evil.example, not to this site." });
    // signed by bob, claiming to be alice; and signed by bob over a text that names alice
    expect(attempt(text({ nonce: n() }), book, bob)).toMatchObject({ ok: false, why: "the signature is not that wallet's." });
    expect(attempt(text({ nonce: n() }), book, bob, bob.address)).toMatchObject({ ok: false, why: "the text names a different wallet than the one that signed." });
    // a number issued for signing in does not add a wallet to a profile, and the other way round
    expect(attempt(text({ nonce: n(), statement: LINK_STATEMENT }), book)).toMatchObject({ ok: false });
    expect(attempt(text({ nonce: book.issue({ kind: "link", profile: "p1" }, T0) }), book)).toMatchObject({ ok: false });
    expect(attempt(text({ nonce: book.issue({ kind: "link", profile: "p1" }, T0), statement: LINK_STATEMENT }), book)).toEqual({ ok: true, address: alice.address, purpose: { kind: "link", profile: "p1" } });
    // it points somewhere else, or was written long ago, or has run out
    expect(attempt(text({ nonce: n(), extra: ["URI: https://evil.example/x"] }), book)).toMatchObject({ ok: false, why: "the text points at another site." });
    expect(attempt(text({ nonce: n() }), book, alice, alice.address, T0 + 200)).toMatchObject({ ok: true });
    const stale = text({ nonce: "x" }).replace(iso(T0), iso(T0 - 3600));
    expect(attempt(stale.replace("Nonce: x", `Nonce: ${n()}`), book)).toMatchObject({ ok: false, why: "the text was written too long ago. Start again." });
    expect(attempt(text({ nonce: n(), extra: [`Expiration Time: ${iso(T0 - 1)}`] }).replace(/(Expiration Time: .*)\n(Nonce: .*)\n(Issued At: .*)/, "$2\n$3\n$1"), book)).toMatchObject({ ok: false, why: "the text has expired. Start again." });
    // not text at all
    expect(verifySignIn({ address: alice.address, message: new Uint8Array([0xff, 0xfe, 0xfd]), signature: new Uint8Array(64) }, HOST, book, T0)).toMatchObject({ ok: false });
  });

  it("a changed byte after signing does not pass", () => {
    const book = new NonceBook();
    const message = utf8(text({ nonce: book.issue({ kind: "signin" }, T0) }));
    const signature = alice.sign(message);
    const changed = utf8(new TextDecoder().decode(message).replace("Sign in to Warden Sentinel.", "Sign in to Warden Sentinel!"));
    expect(verifySignIn({ address: alice.address, message: changed, signature }, HOST, book, T0)).toMatchObject({ ok: false });
  });
});

describe("signing in", () => {
  it("makes a profile for a new wallet, starts watching it, and finds the same profile next time", async () => {
    const s = service();
    const first = await s.signIn(alice);
    expect(first.status).toBe(200);
    const body = first.body as any;
    expect(body.session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.profile).toMatchObject({ tier: "watch", autoRescue: false });
    expect(body.wallets).toEqual([{ address: alice.address, armed: false, reporting: false, paused: false, lastReadAt: null }]);
    expect(s.store.wallets()).toEqual([{ address: alice.address }]);

    const again = (await s.signIn(alice)).body as any;
    expect(again.profile.id).toBe(body.profile.id);
    expect(again.session).not.toBe(body.session);
    expect(s.store.wallets()).toHaveLength(1);
    expect(((await s.call("GET", "/v1/me", undefined, body.session)).body as any).profile.id).toBe(body.profile.id);
  });

  it("keeps a session as a hash, lets it be ended, and lets it run out", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "sentinel-")), "s.json");
    const s = service({ store: new FileStore(file) });
    const { session } = (await s.signIn(alice)).body as any;
    const stored = readFileSync(file, "utf8");
    expect(stored).not.toContain(session);
    expect(stored).toContain(hashToken(session));

    expect((await s.call("GET", "/v1/me", undefined, session)).status).toBe(200);
    expect((await s.call("GET", "/v1/me", undefined, `${session}x`)).status).toBe(401);
    expect((await s.call("GET", "/v1/me")).status).toBe(401);
    s.tick(SESSION_SECONDS - 1);
    expect((await s.call("GET", "/v1/me", undefined, session)).status).toBe(200);
    s.tick(2);
    expect((await s.call("GET", "/v1/me", undefined, session)).status).toBe(401);

    const fresh = ((await s.signIn(alice)).body as any).session;
    expect((await s.call("POST", "/v1/signout", undefined, fresh)).status).toBe(200);
    expect((await s.call("GET", "/v1/me", undefined, fresh)).status).toBe(401);
  });

  it("refuses a signature that is not the wallet's, and slows down someone who keeps trying", async () => {
    const s = service();
    const n = ((await s.call("POST", "/v1/nonce", {})).body as any).nonce;
    const message = utf8(signInText({ host: HOST, address: alice.address, nonce: n, purpose: "signin", issuedAt: iso(T0) }));
    const forged = await s.call("POST", "/v1/signin", { address: alice.address, message: b64(message), signature: b64(bob.sign(message)) });
    expect(forged).toEqual({ status: 401, body: { error: "the signature is not that wallet's." } });
    expect(s.store.wallets()).toEqual([]);
    expect((await s.call("POST", "/v1/signin", { address: alice.address })).status).toBe(400);
    // ten tries a minute from one address, then a wait
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await s.call("POST", "/v1/signin", { address: alice.address, message: b64(message), signature: b64(alice.sign(message)) }, null, "10.9.9.9")).status;
    expect(last).toBe(429);
    s.tick(61);
    expect((await s.signIn(alice, { ip: "10.9.9.9" })).status).toBe(200);
  });
});

describe("a profile's wallets", () => {
  it("adds a wallet only on that wallet's own signature, to the profile that asked", async () => {
    const s = service();
    const a = (await s.signIn(alice)).body as any;
    const linked = await s.signIn(second, { session: a.session });
    expect(linked.status).toBe(200);
    expect((linked.body as any).wallets.map((w: any) => w.address)).toEqual([alice.address, second.address]);
    expect((linked.body as any).session).toBeUndefined();
    // either wallet now signs in to the same profile
    expect(((await s.signIn(second)).body as any).profile.id).toBe(a.profile.id);

    // a link number needs a session, and is spent only by the profile it was issued to
    expect((await s.call("POST", "/v1/nonce", { purpose: "link" })).status).toBe(401);
    const b = (await s.signIn(bob)).body as any;
    const n = ((await s.call("POST", "/v1/nonce", { purpose: "link" }, a.session)).body as any).nonce;
    const message = utf8(signInText({ host: HOST, address: third.address, nonce: n, purpose: "link", issuedAt: iso(T0) }));
    const stolen = await s.call("POST", "/v1/signin", { address: third.address, message: b64(message), signature: b64(third.sign(message)) }, b.session);
    expect(stolen.status).toBe(401);
    expect(s.accounts.profileOf(third.address)).toBeUndefined();
  });

  it("does not take a wallet that is someone else's, and stops at the tier's limit", async () => {
    const s = service();
    const a = (await s.signIn(alice)).body as any;
    await s.signIn(bob);
    expect(await s.signIn(bob, { session: a.session })).toEqual({ status: 409, body: { error: "that wallet is already watched under another profile." } });
    expect((await s.signIn(second, { session: a.session })).status).toBe(200);
    expect((await s.signIn(third, { session: a.session })).status).toBe(200);
    expect(await s.signIn(fourth, { session: a.session })).toEqual({ status: 403, body: { error: "this profile watches 3 wallets, which is its plan's limit." } });
    expect(s.store.wallets().map((w) => w.address)).not.toContain(fourth.address);
  });

  it("forgets a wallet that is removed, and the whole profile with the last one", async () => {
    const s = service();
    const a = (await s.signIn(alice)).body as any;
    await s.signIn(second, { session: a.session });
    await s.call("POST", "/v1/channels", { target: "https://ntfy.sh/alice-topic-123" }, a.session);
    s.store.save(second.address, { ...s.store.record(second.address), cursor: "sig1", lastSeenAt: T0 });
    s.store.addEvent({ wallet: second.address, signature: "sig1", slot: 1, at: T0, level: "alert", signals: ["new_large_payment"], sentence: "x", rescueWorthy: false });

    // someone else cannot remove it
    const b = (await s.signIn(bob)).body as any;
    expect((await s.call("DELETE", `/v1/wallets/${second.address}`, undefined, b.session)).status).toBe(404);

    expect((await s.call("DELETE", `/v1/wallets/${second.address}`, undefined, a.session)).body).toEqual({ ok: true, profileRemoved: false });
    expect(s.store.wallets().map((w) => w.address)).toEqual([alice.address, bob.address]);
    expect(s.store.events(second.address)).toEqual([]);
    expect(s.store.record(second.address).cursor).toBeNull();

    expect((await s.call("DELETE", `/v1/wallets/${alice.address}`, undefined, a.session)).body).toEqual({ ok: true, profileRemoved: true });
    expect((await s.call("GET", "/v1/me", undefined, a.session)).status).toBe(401);
    expect(s.accounts.profile(a.profile.id)).toBeUndefined();
    expect(s.accounts.channelsOf(a.profile.id)).toEqual([]);
    // the other owner is untouched
    expect((await s.call("GET", "/v1/me", undefined, b.session)).status).toBe(200);
  });
});

describe("a full house", () => {
  it("takes no new wallet past what the service can read, and still signs in the ones it has", () => {
    const store = new MemoryStore();
    const accounts = new Accounts(store, KEY, { maxWallets: 2 });
    const a = accounts.admit(alice.address, null, T0);
    expect(a).toMatchObject({ ok: true });
    expect(accounts.admit(second.address, a.ok ? a.profile : "", T0)).toMatchObject({ ok: true });
    expect(accounts.admit(bob.address, null, T0)).toEqual({ ok: false, status: 503, why: "Sentinel is watching as many wallets as it can for now. Try again later." });
    expect(accounts.admit(third.address, a.ok ? a.profile : "", T0)).toMatchObject({ ok: false, status: 503 });
    expect(accounts.admit(alice.address, null, T0)).toMatchObject({ ok: true, created: false }); // an owner already here still gets in
    expect(store.wallets()).toHaveLength(2);
    // room comes back when a wallet is removed
    accounts.removeWallet(a.ok ? a.profile : "", second.address);
    expect(accounts.admit(bob.address, null, T0)).toMatchObject({ ok: true, created: true });
  });
});

describe("where alerts go", () => {
  const DISCORD = ["https://discord.com/api", "webhooks", "123456789012345678", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcd"].join("/");
  // made-up addresses in the shape each service hands out, put together here so that no line of this file
  // reads as a real webhook to a secret scanner
  const SLACK = ["https://hooks.slack.com", "services", "T01ABCDEF", "B01ABCDEFGH", "abcdefghijklmnopqrstuvwx"].join("/");
  const hosts = new Set(["ntfy.sh"]);

  it("takes an ntfy topic on a host it was told about, and nothing else", () => {
    expect(cleanNtfyTarget("https://ntfy.sh/alice-topic-123", hosts)).toBe("https://ntfy.sh/alice-topic-123");
    expect(cleanNtfyTarget(" https://NTFY.sh/alice-topic-123 ", hosts)).toBe("https://ntfy.sh/alice-topic-123");
    for (const bad of [
      "http://ntfy.sh/alice-topic-123", // not https
      "https://ntfy.sh.evil.example/alice-topic-123", "https://evil.example/alice-topic-123",
      "https://169.254.169.254/latest-meta-data", "https://localhost/alice-topic-123", "https://ntfy.sh:8443/alice-topic-123",
      "https://user:pw@ntfy.sh/alice-topic-123", "https://ntfy.sh/alice-topic-123?x=1", "https://ntfy.sh/alice-topic-123#x",
      "https://ntfy.sh/short", "https://ntfy.sh/a/b-long-enough", "https://ntfy.sh/", "ntfy.sh/alice-topic-123", "", 7, null,
    ]) expect(cleanNtfyTarget(bad, hosts), String(bad)).toBeNull();
  });

  it("reads a Discord or Slack webhook only in the exact shape that service hands out", () => {
    expect(cleanTarget(DISCORD, hosts)).toEqual({ kind: "discord", url: DISCORD });
    expect(cleanTarget(DISCORD.replace("discord.com", "discordapp.com"), hosts)).toEqual({ kind: "discord", url: DISCORD });
    expect(cleanTarget(` ${SLACK} `, hosts)).toEqual({ kind: "slack", url: SLACK });
    expect(cleanTarget("https://ntfy.sh/alice-topic-123", hosts)).toEqual({ kind: "ntfy", url: "https://ntfy.sh/alice-topic-123" });
    for (const bad of [
      DISCORD.replace("https://", "http://"), DISCORD.replace("discord.com", "discord.com.evil.example"), DISCORD.replace("discord.com", "evil.example"),
      `${DISCORD}?wait=true`, `${DISCORD}/slack`, `${DISCORD}#x`, DISCORD.replace("/api/webhooks/", "/api/v10/channels/"), DISCORD.replace("123456789012345678", "../../users/@me"),
      "https://discord.com/api/webhooks/123456789012345678/short", `https://user@${DISCORD.slice(8)}`,
      SLACK.replace("hooks.slack.com", "hooks.slack.com.evil.example"), SLACK.replace("/services/", "/workflows/"), `${SLACK}/x`, SLACK.replace("T01ABCDEF", "t01abcdef"),
      "https://slack.com/api/chat.postMessage", "https://hooks.slack.com/services/", "x".repeat(400), 5, null, undefined,
    ]) expect(cleanTarget(bad, hosts), String(bad)).toBeNull();
  });

  it("the free plan has one ntfy channel; Pro has five, with Discord and Slack; a lapsed plan keeps them and stops using them", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "sentinel-")), "s.json");
    const s = service({ store: new FileStore(file) });
    const a = (await s.signIn(alice)).body as any;
    expect(a.limits).toEqual({ wallets: 3, channels: 1, kinds: ["ntfy"], pollSeconds: 60 });
    const add = (target: unknown, session = a.session) => s.call("POST", "/v1/channels", { target }, session);

    const first = await add("https://ntfy.sh/alice-private-topic-77");
    expect(first).toMatchObject({ status: 201, body: { kind: "ntfy", hint: "ntfy.sh/…c-77" } });
    // the topic is sealed in the file, and the page is shown only its last characters
    expect(readFileSync(file, "utf8")).not.toContain("alice-private-topic");
    expect(((await s.call("GET", "/v1/me", undefined, a.session)).body as any).channels).toEqual([{ id: (first.body as any).id, kind: "ntfy", hint: "ntfy.sh/…c-77", active: true, lastDeliveredAt: null, failing: null }]);
    expect(s.accounts.targetsFor(alice.address)).toEqual(["https://ntfy.sh/alice-private-topic-77"]);
    // a store opened with another key cannot read where alerts go, and sends nowhere
    expect(new Accounts(new FileStore(file), Buffer.alloc(32, 1)).targetsFor(alice.address)).toEqual([]);

    // on the free plan: no second channel, no Discord or Slack, nothing that is not a channel
    expect(await add("https://ntfy.sh/alice-second-topic")).toEqual({ status: 403, body: { error: "this plan has one alert channel. Remove it to use another, or move to Pro for five." } });
    expect(await s.call("DELETE", `/v1/channels/${(first.body as any).id}`, undefined, a.session)).toMatchObject({ status: 200 });
    expect(await add(DISCORD)).toEqual({ status: 403, body: { error: "Discord and Slack channels come with Pro. On Watch, alerts go to ntfy." } });
    expect((await add("https://evil.example/alice-private-topic")).status).toBe(400);
    expect((await add("a@b.c")).status).toBe(400);
    expect((await add("https://ntfy.sh/alice-private-topic-77")).status).toBe(201);
    expect((await add("https://ntfy.sh/alice-private-topic-77")).status).toBe(403); // the plan's one channel is taken

    // Pro: five channels of any kind
    s.accounts.setTier(a.profile.id, "pro");
    expect(((await s.call("GET", "/v1/me", undefined, a.session)).body as any).limits).toEqual({ wallets: 10, channels: 5, kinds: ["ntfy", "discord", "slack"], pollSeconds: 20 });
    expect((await add("https://ntfy.sh/alice-private-topic-77")).status).toBe(409);
    const discord = await add(DISCORD);
    expect(discord).toMatchObject({ status: 201, body: { kind: "discord", hint: "Discord webhook …abcd" } });
    expect(await add(SLACK)).toMatchObject({ status: 201, body: { kind: "slack", hint: "Slack webhook …uvwx" } });
    expect(readFileSync(file, "utf8")).not.toContain("abcdefghijklmnopqrstuvwxyzABCDEF");
    expect(JSON.stringify((await s.call("GET", "/v1/me", undefined, a.session)).body)).not.toContain("abcdefghijklmnopqrstuvwxyzABCDEF");
    await add("https://ntfy.sh/alice-phone-4567");
    await add("https://ntfy.sh/alice-tablet-890");
    expect((await add("https://ntfy.sh/alice-sixth-topic")).body).toEqual({ error: "this plan has 5 alert channels at most." });
    expect(s.accounts.channelsFor(alice.address).map((c) => c.kind)).toEqual(["ntfy", "discord", "slack", "ntfy", "ntfy"]);

    // the plan lapses: everything stays listed, and only what the free plan covers is used
    s.accounts.setTier(a.profile.id, "watch");
    expect(s.accounts.targetsFor(alice.address)).toEqual(["https://ntfy.sh/alice-private-topic-77"]);
    expect(((await s.call("GET", "/v1/me", undefined, a.session)).body as any).channels.map((c: any) => [c.kind, c.active])).toEqual([["ntfy", true], ["discord", false], ["slack", false], ["ntfy", false], ["ntfy", false]]);
    s.accounts.setTier(a.profile.id, "pro");
    expect(s.accounts.channelsFor(alice.address)).toHaveLength(5);

    // only its owner removes one
    const b = (await s.signIn(bob)).body as any;
    expect((await s.call("DELETE", `/v1/channels/${(discord.body as any).id}`, undefined, b.session)).status).toBe(404);
    expect((await s.call("DELETE", `/v1/channels/${(discord.body as any).id}`, undefined, a.session)).status).toBe(200);
    expect(s.accounts.channelsFor(alice.address).map((c) => c.kind)).toEqual(["ntfy", "slack", "ntfy", "ntfy"]);
  });

  it("sends the sentence to each channel in that service's plain form, follows no redirect, and says what it could not deliver", async () => {
    const s = service();
    const a = (await s.signIn(alice)).body as any;
    s.accounts.setTier(a.profile.id, "pro");
    for (const target of ["https://ntfy.sh/alice-topic-123", DISCORD, SLACK]) await s.call("POST", "/v1/channels", { target }, a.session);
    const posts: { url: string; init: Parameters<Post>[1] }[] = [];
    let answer: () => Promise<{ ok: boolean; status: number }> = async () => ({ ok: true, status: 200 });
    const notifier = new ChannelNotifier(s.accounts, async (url, init) => { posts.push({ url, init }); return answer(); }, { now: () => T0 });

    await notifier.notify(alice.address, "urgent", "Your USDC account was handed to another wallet.");
    expect(posts.map((p) => p.url)).toEqual(["https://ntfy.sh/alice-topic-123", DISCORD, SLACK]);
    const title = `Warden Sentinel: urgent (${alice.address.slice(0, 4)}..${alice.address.slice(-4)})`;
    expect(posts[0]!.init).toMatchObject({ method: "POST", redirect: "error", body: "Your USDC account was handed to another wallet.", headers: { Title: title, Priority: "5" } });
    expect(/^[\x20-\x7e]+$/.test(posts[0]!.init.headers.Title!)).toBe(true); // a header: plain ASCII
    expect(JSON.parse(posts[1]!.init.body)).toEqual({ content: `${title.replace(/[()-]/g, (c) => c)}\nYour USDC account was handed to another wallet.`, allowed_mentions: { parse: [] }, flags: 4 });
    expect(JSON.parse(posts[2]!.init.body)).toEqual({ text: `${title}\nYour USDC account was handed to another wallet.`, mrkdwn: false, unfurl_links: false, unfurl_media: false });
    expect(posts.every((p) => p.init.redirect === "error")).toBe(true);
    expect(notifier.undelivered).toEqual([]);

    // a channel that refuses, one that throws, and an owner with none: recorded, never thrown
    answer = async () => ({ ok: false, status: 507 });
    await notifier.notify(alice.address, "alert", "x");
    answer = async () => { throw new Error("redirect mode is set to error"); };
    await notifier.notify(alice.address, "alert", "x");
    await notifier.notify(bob.address, "alert", "x");
    expect(notifier.undelivered.map((u) => u.why)).toEqual([...Array(3).fill("the channel answered 507"), ...Array(3).fill("redirect mode is set to error"), "the owner has no channel"]);
  });

  it("text quoted from the chain cannot become a link, a mention or formatting in any channel", () => {
    const hostile = "Sent 5 USDC to a token named @everyone **FREE** [claim](https://evil.example) at www.evil.example <!channel> <https://evil.example|safe> `x` & more";
    const discord = JSON.parse(messageFor("discord", "T", "alert", hostile).body);
    expect(discord.allowed_mentions).toEqual({ parse: [] });
    expect(discord.flags).toBe(4);
    expect(discord.content).not.toContain("https://");
    expect(discord.content).not.toMatch(/(^|[^\\])[*_`\[\]@|>~#]/); // every formatting character is escaped
    expect(discord.content).toContain("\\@everyone \\*\\*FREE\\*\\*");
    const slack = JSON.parse(messageFor("slack", "T", "alert", hostile).body);
    expect(slack.mrkdwn).toBe(false);
    expect(slack.text).not.toContain("<");
    expect(slack.text).not.toContain("https://");
    expect(slack.text).toContain("&lt;!channel&gt;");
    expect(slack.text).toContain("&amp; more");
    // read aloud it is the same sentence: only invisible characters and escapes were added
    expect(slack.text.replace(/​/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")).toBe(`T\n${hostile}`);
    expect(discord.content.replace(/​/g, "").replace(/\\(.)/g, "$1")).toBe(`T\n${hostile}`);
    // ntfy shows text as text; the sentence goes as it is
    expect(messageFor("ntfy", "T", "urgent", hostile)).toEqual({ headers: { Title: "T", Priority: "5" }, body: hostile });
  });
});

describe("\"this signature was mine\"", () => {
  const SIG = "5".repeat(87);

  it("is taken only with the token issued for that wallet", async () => {
    const s = service();
    const a = (await s.signIn(alice)).body as any;
    await s.signIn(second, { session: a.session });
    const b = (await s.signIn(bob)).body as any;

    // no token yet: nobody can report for the wallet
    expect((await s.call("POST", "/v1/report", { wallet: alice.address, signature: SIG }, "x".repeat(43))).status).toBe(401);
    const { token } = (await s.call("POST", `/v1/wallets/${alice.address}/report-token`, undefined, a.session)).body as any;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(((await s.call("GET", "/v1/me", undefined, a.session)).body as any).wallets.find((w: any) => w.address === alice.address).reporting).toBe(true);

    expect(await s.call("POST", "/v1/report", { wallet: alice.address, signature: SIG }, token)).toEqual({ status: 202, body: { ok: true } });
    expect(s.calls.ownerSigned).toEqual([[alice.address, SIG]]);

    // not without it, not with a session instead of it, not for another wallet of the same owner, not for a stranger's
    for (const [wallet, bearer] of [[alice.address, null], [alice.address, a.session], [second.address, token], [bob.address, token], [walletOf(77).address, token]] as const) {
      expect((await s.call("POST", "/v1/report", { wallet, signature: SIG }, bearer)).status, `${wallet} ${bearer}`).toBe(401);
    }
    // someone else cannot issue or revoke the token
    expect((await s.call("POST", `/v1/wallets/${alice.address}/report-token`, undefined, b.session)).status).toBe(404);
    expect((await s.call("DELETE", `/v1/wallets/${alice.address}/report-token`, undefined, b.session)).status).toBe(404);
    expect(s.calls.ownerSigned).toHaveLength(1);
  });

  it("a new token replaces the old one, and a revoked one stops working", async () => {
    const s = service();
    const a = (await s.signIn(alice)).body as any;
    const first = ((await s.call("POST", `/v1/wallets/${alice.address}/report-token`, undefined, a.session)).body as any).token;
    const next = ((await s.call("POST", `/v1/wallets/${alice.address}/report-token`, undefined, a.session)).body as any).token;
    expect((await s.call("POST", "/v1/report", { wallet: alice.address, signature: SIG }, first)).status).toBe(401);
    expect((await s.call("POST", "/v1/report", { wallet: alice.address, signature: SIG }, next)).status).toBe(202);
    expect((await s.call("DELETE", `/v1/wallets/${alice.address}/report-token`, undefined, a.session)).status).toBe(200);
    expect((await s.call("POST", "/v1/report", { wallet: alice.address, signature: SIG }, next)).status).toBe(401);
  });

  it("takes only something shaped like a signature, and only so many an hour", async () => {
    const s = service();
    const a = (await s.signIn(alice)).body as any;
    const { token } = (await s.call("POST", `/v1/wallets/${alice.address}/report-token`, undefined, a.session)).body as any;
    for (const bad of ["", "short", "0".repeat(87), "5".repeat(200), 5, null, { $gt: "" }]) expect((await s.call("POST", "/v1/report", { wallet: alice.address, signature: bad }, token)).status, String(bad)).toBe(400);
    expect((await s.call("POST", "/v1/report", { wallet: "nope", signature: SIG }, token)).status).toBe(400);
    let last = 0;
    for (let i = 0; i < 241; i++) last = (await s.call("POST", "/v1/report", { wallet: alice.address, signature: SIG }, token)).status;
    expect(last).toBe(429);
    expect(s.calls.ownerSigned).toHaveLength(240);
  });
});

describe("alerts", () => {
  const raise = (s: ReturnType<typeof service>, wallet: string, signature: string, at: number) => {
    const e = { wallet, signature, slot: at, at, level: "alert" as const, signals: ["new_large_payment" as const], sentence: `Sent 6 SOL to a new address.`, rescueWorthy: false };
    s.store.addEvent(e);
    return (e as { id?: string }).id!;
  };

  it("shows an owner their own alerts, newest first, and nobody else's", async () => {
    const s = service();
    const a = (await s.signIn(alice)).body as any;
    await s.signIn(second, { session: a.session });
    const b = (await s.signIn(bob)).body as any;
    const e1 = raise(s, alice.address, "sigA", T0 + 10);
    const e2 = raise(s, second.address, "sigB", T0 + 20);
    const e3 = raise(s, bob.address, "sigC", T0 + 30);
    const mine = ((await s.call("GET", "/v1/events", undefined, a.session)).body as any).events;
    expect(mine.map((e: any) => e.id)).toEqual([e2, e1]);
    expect(mine[0]).toEqual({ id: e2, wallet: second.address, signature: "sigB", at: T0 + 20, level: "alert", signals: ["new_large_payment"], sentence: "Sent 6 SOL to a new address.", canRescue: false, answer: null, undelivered: false });
    expect(((await s.call("GET", "/v1/events", undefined, b.session)).body as any).events.map((e: any) => e.id)).toEqual([e3]);
    expect((await s.call("GET", "/v1/events")).status).toBe(401);
  });

  it("records \"this was me\" and has the watcher learn it from the chain; \"ignore\" teaches nothing", async () => {
    const s = service();
    const a = (await s.signIn(alice)).body as any;
    const b = (await s.signIn(bob)).body as any;
    const e1 = raise(s, alice.address, "sigA", T0 + 10);
    const e2 = raise(s, alice.address, "sigB", T0 + 20);

    // not someone else's alert, not an answer that is not one
    expect((await s.call("POST", `/v1/events/${e1}/answer`, { answer: "this_was_me" }, b.session)).status).toBe(404);
    expect((await s.call("POST", `/v1/events/${e1}/answer`, { answer: "delete everything" }, a.session)).status).toBe(400);
    expect((await s.call("POST", `/v1/events/nope/answer`, { answer: "ignore" }, a.session)).status).toBe(404);
    expect(s.calls.confirmOwn).toEqual([]);

    expect((await s.call("POST", `/v1/events/${e1}/answer`, { answer: "this_was_me" }, a.session)).status).toBe(200);
    expect((await s.call("POST", `/v1/events/${e2}/answer`, { answer: "ignore" }, a.session)).status).toBe(200);
    expect(s.calls.confirmOwn).toEqual([[alice.address, "sigA"]]);
    expect(((await s.call("GET", "/v1/events", undefined, a.session)).body as any).events.map((e: any) => e.answer)).toEqual(["ignore", "this_was_me"]);
    // rescue is not something this service does yet, and it says so
    expect(await s.call("POST", `/v1/events/${e1}/answer`, { answer: "rescue" }, a.session)).toEqual({ status: 501, body: { error: "rescue is not switched on yet." } });
  });
});

describe("over HTTP", () => {
  const start = async () => {
    const s = service();
    const store = s.store, accounts = s.accounts;
    const server = await listen({ accounts, store, watcher: { ownerSigned: async () => undefined, confirmOwn: async () => true }, nonces: new NonceBook(), origin: ORIGIN, health: () => ({ lastPassAt: 123, blind: 0 }) }, { port: 0 });
    const port = (server.address() as { port: number }).port;
    return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
  };

  it("answers the Sentinel page, and no other page, except for the extension's one report path", async () => {
    expect(corsHeaders("/v1/me", ORIGIN, ORIGIN)["Access-Control-Allow-Origin"]).toBe(ORIGIN);
    expect(corsHeaders("/v1/me", "https://evil.example", ORIGIN)["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(corsHeaders("/v1/me", undefined, ORIGIN)["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(corsHeaders("/v1/report", "chrome-extension://abcdefgh", ORIGIN)["Access-Control-Allow-Origin"]).toBe("*");

    const { base, close } = await start();
    try {
      const health = await fetch(`${base}/v1/health`, { headers: { Origin: ORIGIN } });
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true, watching: 0, lastPassAt: 123, blind: 0 });
      expect(health.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(health.headers.get("cache-control")).toBe("no-store");
      expect(health.headers.get("x-content-type-options")).toBe("nosniff");
      expect((await fetch(`${base}/v1/health`, { headers: { Origin: "https://evil.example" } })).headers.get("access-control-allow-origin")).toBeNull();

      const preflight = await fetch(`${base}/v1/report`, { method: "OPTIONS", headers: { Origin: "chrome-extension://abcdefgh", "Access-Control-Request-Method": "POST" } });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
      expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
    } finally { await close(); }
  });

  it("reads small JSON bodies and bearer tokens, and turns away the rest", async () => {
    const { base, close } = await start();
    try {
      const nonce = await fetch(`${base}/v1/nonce`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(nonce.status).toBe(200);
      expect((await nonce.json()).host).toBe(HOST);
      expect((await fetch(`${base}/v1/nonce`, { method: "POST", body: "{not json" })).status).toBe(400);
      expect((await fetch(`${base}/v1/nonce`, { method: "POST", body: JSON.stringify({ pad: "x".repeat(20_000) }) }).catch(() => ({ status: 413 }))).status).toBe(413);
      // a bearer header that is not a token is no token
      expect((await fetch(`${base}/v1/me`, { headers: { Authorization: "Bearer short" } })).status).toBe(401);
      expect((await fetch(`${base}/v1/me`, { headers: { Authorization: "Basic abc" } })).status).toBe(401);
      expect((await fetch(`${base}/nothing`)).status).toBe(404);
      expect((await fetch(`${base}/v1/nothing`)).status).toBe(401);
    } finally { await close(); }
  });
});

describe("the process", () => {
  const env = { SENTINEL_RPC_URL: "https://rpc.example", SENTINEL_DATA_KEY: randomBytes(32).toString("base64") };

  it("starts only with an RPC and a data key, and says which is missing", () => {
    expect(configFrom(env)).toMatchObject({ ok: true, config: { origin: ORIGIN, port: 8791, pollSeconds: 60, proPollSeconds: 20, maxWallets: 100, trustProxy: false } });
    // the paid plan is the faster one, whatever the settings say
    expect(configFrom({ ...env, SENTINEL_PRO_POLL_SECONDS: "120" })).toMatchObject({ ok: false, why: expect.stringContaining("SENTINEL_PRO_POLL_SECONDS") });
    expect(configFrom({ ...env, SENTINEL_POLL_SECONDS: "30", SENTINEL_PRO_POLL_SECONDS: "10" })).toMatchObject({ ok: true, config: { pollSeconds: 30, proPollSeconds: 10 } });
    expect(configFrom({ ...env, SENTINEL_MAX_WALLETS: "0" })).toMatchObject({ ok: false });
    expect(configFrom({ ...env, SENTINEL_RPC_URL: undefined })).toEqual({ ok: false, why: "SENTINEL_RPC_URL has to be the address of a Solana RPC." });
    expect(configFrom({ ...env, SENTINEL_RPC_URL: "ftp://x" })).toMatchObject({ ok: false });
    expect(configFrom({ ...env, SENTINEL_DATA_KEY: "c2hvcnQ=" })).toMatchObject({ ok: false, why: expect.stringContaining("SENTINEL_DATA_KEY") });
    expect(configFrom({ ...env, SENTINEL_POLL_SECONDS: "1" })).toMatchObject({ ok: false });
    expect(configFrom({ ...env, SENTINEL_PORT: "99999" })).toMatchObject({ ok: false });
    const custom = configFrom({ ...env, SENTINEL_ORIGIN: "http://localhost:5173/sentinel", SENTINEL_NTFY_HOSTS: "ntfy.sh, Push.Example.org", SENTINEL_TRUST_PROXY: "1" });
    expect(custom).toMatchObject({ ok: true, config: { origin: "http://localhost:5173", trustProxy: true } });
    expect(custom.ok && [...custom.config.ntfyHosts]).toEqual(["ntfy.sh", "push.example.org"]);
  });

  it("runs one round at a time, and a round that fails does not stop the next", async () => {
    const log: string[] = [];
    let running = 0, most = 0, rounds = 0;
    const stop = startRounds(async () => {
      running += 1; most = Math.max(most, running); rounds += 1;
      await new Promise((r) => setTimeout(r, 15));
      running -= 1;
      if (rounds === 2) throw new Error("the RPC answered 503");
    }, 0.005, (line) => log.push(line));
    await new Promise((r) => setTimeout(r, 120));
    stop();
    const at = rounds;
    await new Promise((r) => setTimeout(r, 60));
    expect(most).toBe(1);
    expect(at).toBeGreaterThanOrEqual(3);
    expect(rounds).toBeLessThanOrEqual(at + 1); // nothing new after stop, but for one already under way
    expect(log).toEqual(["sentinel: a round failed: the RPC answered 503"]);
  });

  it("reads each wallet at its plan's pace", () => {
    const tiers: Record<string, "watch" | "pro"> = { free: "watch", paid: "pro" };
    const pace = pacer((w) => tiers[w] ?? "watch", { watch: 60, pro: 20 });
    const read = (now: number) => ["free", "paid"].filter((w) => pace.pick(w, now));
    expect(read(T0)).toEqual(["free", "paid"]);       // both at once, the first time
    expect(read(T0 + 20)).toEqual(["paid"]);
    expect(read(T0 + 40)).toEqual(["paid"]);
    expect(read(T0 + 60)).toEqual(["free", "paid"]);
    expect(pace.tried()).toEqual(["free", "paid", "paid", "paid", "free", "paid"]);
    expect(pace.tried()).toEqual([]);
    // over three minutes: the paid wallet is read three times as often
    let free = 0, paid = 0;
    for (let t = T0 + 80; t < T0 + 80 + 180; t += 20) for (const w of read(t)) { if (w === "free") free += 1; else paid += 1; }
    expect([free, paid]).toEqual([3, 9]);
    // a plan that starts is felt at the next round, and one that ends too
    tiers.free = "pro";
    expect(read(T0 + 280)).toEqual(["free", "paid"]);
    pace.forget((w) => w === "paid");
    expect(read(T0 + 281)).toEqual(["free"]); // forgotten, so due again
  });

  it("a limiter counts per key and forgets after its window", () => {
    const l = new RateLimiter();
    expect([1, 2, 3].map(() => l.allow("a", 2, 60, T0))).toEqual([true, true, false]);
    expect(l.allow("b", 2, 60, T0)).toBe(true);
    expect(l.allow("a", 2, 60, T0 + 60)).toBe(true);
  });
});
