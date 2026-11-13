/**
 * Running the service: that its one data file survives a bad write and a slip of the hand, and that whoever
 * runs it hears about the things no owner can act on.
 */
import "../../../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { Accounts } from "../src/accounts.js";
import { Billing, Stripe } from "../src/billing.js";
import { Blindness } from "../src/blindness.js";
import { LAMPORT_MINT, configFrom, nearlyFull, nearlyOutOfReads, pacer, watchRound } from "../src/main.js";
import type { Post } from "../src/notify.js";
import { Ops } from "../src/ops.js";
import { api } from "../src/server.js";
import { NonceBook } from "../src/signin.js";
import { FileStore, MemoryStore, SNAPSHOT_DAYS } from "../src/store.js";
import { createHmac } from "node:crypto";

const T0 = 1_794_312_000; // 2026-11-10
const DAY = 86_400;
const addr = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const A = addr(1), B = addr(2);
const fresh = () => join(mkdtempSync(join(tmpdir(), "sentinel-ops-")), "sentinel.json");
const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

describe("the data file", () => {
  it("is copied aside once a day, and the last week of copies is kept", () => {
    const file = fresh();
    const store = new FileStore(file);
    new Accounts(store, Buffer.alloc(32, 9)).admit(A, null, T0);
    const first = store.snapshot(T0);
    expect(first).toBe(join(file, "..", "snapshots", `sentinel-${day(T0)}.json`));
    expect(statSync(first!).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(first!, "utf8")).wallets).toEqual([{ address: A }]);
    expect(store.snapshot(T0 + 3600)).toBeNull(); // today's is there
    for (let d = 1; d <= 9; d++) expect(store.snapshot(T0 + d * DAY)).not.toBeNull();
    expect(store.snapshots()).toHaveLength(SNAPSHOT_DAYS);
    expect(store.snapshots()[0]).toContain(day(T0 + 3 * DAY)); // the oldest three are gone
    expect(store.snapshots().at(-1)).toContain(day(T0 + 9 * DAY));
    expect(readdirSync(join(file, "..", "snapshots")).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  it("when it cannot be read, is set aside untouched and the newest snapshot that can be read is used", () => {
    const file = fresh();
    const before = new FileStore(file);
    const accounts = new Accounts(before, Buffer.alloc(32, 9));
    accounts.admit(A, null, T0);
    before.snapshot(T0);
    accounts.admit(B, null, T0 + DAY);
    before.snapshot(T0 + DAY);
    writeFileSync(before.snapshots()[1]!, '{"wallets":[{"addr'); // the newest snapshot was cut short too
    writeFileSync(file, '{"wallets":[{"address":"cut sho');

    const after = new FileStore(file);
    expect(after.restoredFrom).toBe(before.snapshots()[0]);
    expect(after.setAside).toMatch(/sentinel\.json\.unreadable-\d+$/);
    expect(readFileSync(after.setAside!, "utf8")).toBe('{"wallets":[{"address":"cut sho'); // kept as it was found
    expect(after.wallets()).toEqual([{ address: A }]); // as of the snapshot: the second wallet came after it
    expect(JSON.parse(readFileSync(file, "utf8")).wallets).toEqual([{ address: A }]); // and the file is whole again
    // the next start is an ordinary one
    expect(new FileStore(file)).toMatchObject({ restoredFrom: null, setAside: null });
  });

  it("when it is gone and snapshots are there, comes back from the newest; when it is not this shape, counts as unreadable", () => {
    const file = fresh();
    const before = new FileStore(file);
    const accounts = new Accounts(before, Buffer.alloc(32, 9));
    accounts.admit(B, null, T0 - DAY);
    before.snapshot(T0 - DAY);
    accounts.removeWallet(accounts.profileOf(B)!, B);
    accounts.admit(A, null, T0);
    before.snapshot(T0);
    unlinkSync(file);
    const back = new FileStore(file);
    expect(back).toMatchObject({ restoredFrom: before.snapshots()[1], setAside: null }); // the newest, not the first
    expect(back.wallets()).toEqual([{ address: A }]);

    for (const wrong of ["[]", "null", "3", '{"wallets":3}', '{"records":[]}', '{"accounts":"x"}']) {
      writeFileSync(file, wrong);
      const again = new FileStore(file);
      expect(again.restoredFrom, wrong).not.toBeNull();
      expect(again.wallets()).toEqual([{ address: A }]);
    }
  });

  it("with nothing to stand in for it, does not start, and deletes nothing", () => {
    const file = fresh();
    writeFileSync(file, "not json");
    expect(() => new FileStore(file)).toThrow(/could not be read and no snapshot can stand in for it\. It was set aside as .*unreadable-\d+; nothing was overwritten\./);
    const left = readdirSync(join(file, ".."));
    expect(left).toHaveLength(1);
    expect(readFileSync(join(file, "..", left[0]!), "utf8")).toBe("not json");
    // and a first start, with no file and no snapshot, is simply empty
    const empty = new FileStore(fresh());
    expect(empty).toMatchObject({ restoredFrom: null, setAside: null });
    expect(empty.wallets()).toEqual([]);
  });

  it("is written whole: a file left half-written by a crash is never the data file", () => {
    const file = fresh();
    const store = new FileStore(file);
    new Accounts(store, Buffer.alloc(32, 9)).admit(A, null, T0);
    writeFileSync(`${file}.tmp`, '{"wallets":[{"addr'); // what a crash in the middle of a write leaves
    expect(new FileStore(file).wallets()).toEqual([{ address: A }]);
    mkdirSync(join(file, "..", "snapshots"), { recursive: true });
    writeFileSync(join(file, "..", "snapshots", "notes.txt"), "not a snapshot");
    expect(new FileStore(file).snapshots()).toEqual([]);
    expect(existsSync(file)).toBe(true);
  });
});

describe("a line to whoever runs the service", () => {
  const NTFY = { kind: "ntfy" as const, url: "https://ntfy.sh/operator-topic-123" };
  const setup = (target: typeof NTFY | null = NTFY) => {
    const posts: { url: string; title: string; body: string }[] = [];
    const log: string[] = [];
    const said: Record<string, number> = {};
    let now = T0, saved = 0;
    const answer: { next: () => Promise<{ ok: boolean; status: number }> } = { next: async () => ({ ok: true, status: 200 }) };
    const post: Post = async (url, init) => { posts.push({ url, title: init.headers.Title ?? "", body: init.body }); return answer.next(); };
    const ops = new Ops(target, said, { post, now: () => now, log: (l) => log.push(l), saved: () => { saved += 1; } });
    return { ops, posts, log, said, answer, tick: (s: number) => { now += s; }, saved: () => saved };
  };

  it("is said once in its window, always logged, and remembered across a restart", async () => {
    const s = setup();
    expect(await s.ops.say("Sentinel started: watching 3 wallet(s).", "started", 600)).toBe(true);
    expect(s.posts).toEqual([{ url: NTFY.url, title: "Warden Sentinel: operations", body: "Sentinel started: watching 3 wallet(s)." }]);
    s.tick(60);
    expect(await s.ops.say("Sentinel started: watching 3 wallet(s).", "started", 600)).toBe(false); // falling over and over does not fill the channel
    expect(s.posts).toHaveLength(1);
    expect(s.log).toEqual(["sentinel: Sentinel started: watching 3 wallet(s).", "sentinel: Sentinel started: watching 3 wallet(s)."]);
    s.tick(600);
    expect(await s.ops.say("Sentinel started: watching 3 wallet(s).", "started", 600)).toBe(true);
    expect(s.saved()).toBe(2); // written down each time it was said

    // the record is the store's: a new process with the same store keeps quiet too
    const file = fresh();
    const store = new FileStore(file);
    await new Ops(null, store.said, { now: () => T0, log: () => undefined, saved: () => store.flush() }).say("x", "k");
    const posts: string[] = [];
    const reopened = new FileStore(file);
    expect(await new Ops(NTFY, reopened.said, { post: async (u) => { posts.push(u); return { ok: true, status: 200 }; }, now: () => T0 + 60, log: () => undefined }).say("x", "k")).toBe(false);
    expect(posts).toEqual([]);
  });

  it("without a channel is only logged, and a channel that fails stops nothing", async () => {
    const quiet = setup(null);
    expect(await quiet.ops.say("something")).toBe(false);
    expect(quiet.posts).toEqual([]);
    expect(quiet.log).toEqual(["sentinel: something"]);

    const s = setup();
    s.answer.next = async () => { throw new Error("down"); };
    await expect(s.ops.say("a")).resolves.toBe(false);
    s.answer.next = async () => ({ ok: false, status: 500 });
    await expect(s.ops.say("b")).resolves.toBe(false);
    // what was said long ago is not kept for ever
    s.tick(8 * DAY);
    await s.ops.say("c");
    expect(Object.keys(s.said)).toEqual(["c"]);
  });

  it("hears when wallets go unread for long, once, and when all are read again", async () => {
    const store = new MemoryStore([{ address: A }, { address: B }]);
    const down = new Set<string>();
    const watcher = { passAll: async (only?: (a: string) => boolean) => ({ raised: [], blind: store.wallets().filter((w) => (!only || only(w.address)) && down.has(w.address)).map((w) => ({ wallet: w.address, why: "getSignaturesForAddress: the RPC answered 429" })) }) };
    const said: [string, string, number][] = [];
    const ops = { say: async (sentence: string, key = sentence, every = 0) => { said.push([sentence, key, every]); return true; } };
    const round = watchRound({ watcher, store, notifier: { notify: async () => undefined }, pace: pacer(() => "watch", { watch: 60, pro: 20 }), blindness: new Blindness(), state: { lastPassAt: null, blind: 0 }, log: () => undefined, ops });
    await round(T0);
    down.add(A); down.add(B);
    for (let t = 60; t <= 1020; t += 60) await round(T0 + t);
    expect(said).toEqual([["2 of 2 wallets have gone unread for 15 minutes (getSignaturesForAddress: the RPC answered 429). Their owners were told.", "unread", 3600]]);
    expect(said[0]![0]).not.toContain(A); // no wallet is named
    down.delete(A);
    await round(T0 + 1080);
    expect(said).toHaveLength(1); // one is back, one is not: not yet
    down.delete(B);
    await round(T0 + 1140);
    expect(said[1]).toEqual(["Every wallet is being read again.", "read-again", 3600]);
  });

  it("hears when a webhook Stripe signed could not be applied, and Stripe is still told to send it again", async () => {
    const store = new MemoryStore();
    const accounts = new Accounts(store, Buffer.alloc(32, 9));
    const cfg = { secretKey: "sk_test_x", webhookSecret: "whsec_x", priceFull: "price_full", priceHolder: "price_holder", centsFull: 1500, centsHolder: 1000, holderMint: LAMPORT_MINT, holderMin: 250_000, pageUrl: "https://warden.lamportrobotics.com/sentinel/", checkoutOpen: false };
    const billing = new Billing(cfg, accounts, { call: async () => ({ value: [] }) }, new Stripe(cfg.secretKey, async () => ({ ok: false, status: 503, json: async () => ({ error: { type: "api_error" } }) })));
    const failures: string[] = [];
    const handle = api({ accounts, store, watcher: { ownerSigned: async () => undefined, confirmOwn: async () => true }, nonces: new NonceBook(), origin: "https://warden.lamportrobotics.com", now: () => T0, billing: { api: billing, webhookSecret: cfg.webhookSecret }, webhookFailed: (why) => failures.push(why) });
    const raw = JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });
    const stripeSignature = `t=${T0},v1=${createHmac("sha256", cfg.webhookSecret).update(`${T0}.${raw}`).digest("hex")}`;
    await expect(handle({ method: "POST", path: "/v1/stripe/webhook", bearer: null, body: undefined, ip: "10.0.0.1", raw, stripeSignature })).rejects.toThrow(/stripe GET/);
    expect(failures).toEqual(["stripe GET /subscriptions/sub_1: 503 api_error"]);
    expect(failures[0]).not.toContain("sk_test"); // the key is in no message
    // a forged one is not a failure worth a word: it was never Stripe's
    expect((await handle({ method: "POST", path: "/v1/stripe/webhook", bearer: null, body: undefined, ip: "10.0.0.1", raw, stripeSignature: "t=1,v1=00" })).status).toBe(400);
    expect(failures).toHaveLength(1);
  });

  it("is where it was told to go, or the service does not start; and says when the house is nearly full", () => {
    const base = { SENTINEL_RPC_URL: "https://rpc.example", SENTINEL_DATA_KEY: Buffer.alloc(32, 7).toString("base64") };
    expect(configFrom(base)).toMatchObject({ ok: true, config: { opsChannel: null } });
    expect(configFrom({ ...base, SENTINEL_OPS_CHANNEL: "https://ntfy.sh/operator-topic-123" })).toMatchObject({ ok: true, config: { opsChannel: { kind: "ntfy", url: "https://ntfy.sh/operator-topic-123" } } });
    for (const bad of ["https://evil.example/operator-topic-123", "http://ntfy.sh/operator-topic-123", "https://ntfy.sh/short", "not an address"]) {
      expect(configFrom({ ...base, SENTINEL_OPS_CHANNEL: bad })).toEqual({ ok: false, why: "SENTINEL_OPS_CHANNEL has to be an ntfy topic on an allowed host, or a Discord or Slack webhook." });
    }
    expect(nearlyFull(89, 100)).toBeNull();
    expect(nearlyFull(90, 100)).toBe("Sentinel holds 90 of the 100 wallets it takes from anyone. New owners are turned away when it is full.");
    expect(nearlyFull(72, 80, 100)).toBe("Sentinel holds 72 of the 80 wallets it takes from anyone (20 more places are kept for the paid plan). New owners are turned away when it is full.");
    expect(nearlyFull(71, 80, 100)).toBeNull();
    expect(nearlyOutOfReads(38, 43)).toBeNull();
    expect(nearlyOutOfReads(39, 43)).toBe("The wallets Sentinel watches are promised 39 of the 43 reads a minute it gives to anyone. New owners are turned away when they are all promised; a faster RPC is what makes room.");
    expect(nearlyOutOfReads(33, 35, 43)).toContain("(8 more are kept for the paid plan)");
    expect(nearlyFull(1, 1)).not.toBeNull();
    expect(nearlyFull(0, 5)).toBeNull();
  });
});
