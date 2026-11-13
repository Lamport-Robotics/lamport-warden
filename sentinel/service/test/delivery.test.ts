/**
 * An alert that reaches nobody is the failure an alerting service must not hide. These tests are about what
 * an owner can see when a channel stops taking messages: on the page, on their other channels, and on the
 * alert itself.
 */
import "../../../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { Accounts } from "../src/accounts.js";
import { Blindness } from "../src/blindness.js";
import { pacer, watchRound } from "../src/main.js";
import { ChannelNotifier, failingChannelNotice, refusalOf, type Post } from "../src/notify.js";
import { api } from "../src/server.js";
import { NonceBook } from "../src/signin.js";
import { MemoryStore } from "../src/store.js";

const T0 = 1_794_312_000;
const A = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey.toBase58();
const NTFY = "https://ntfy.sh/alice-topic-123";
// made-up, put together here so no line reads as a real webhook to a secret scanner
const DISCORD = ["https://discord.com/api", "webhooks", "123456789012345678", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcd"].join("/");

function setup() {
  const store = new MemoryStore();
  const accounts = new Accounts(store, Buffer.alloc(32, 9));
  const admitted = accounts.admit(A, null, T0);
  const profile = admitted.ok ? admitted.profile : "";
  let now = T0;
  const posts: { url: string; title: string; body: string }[] = [];
  /** What each host answers: a status, or "down" for no answer at all. */
  const answers: Record<string, number | "down"> = {};
  const post: Post = async (url, init) => {
    const host = new URL(url).host, a = answers[host] ?? 200;
    posts.push({ url, title: init.headers.Title ?? "", body: init.body });
    if (a === "down") throw new Error("getaddrinfo ENOTFOUND " + host);
    return { ok: a < 300, status: a };
  };
  const notifier = new ChannelNotifier(accounts, post, { now: () => now });
  const view = () => accounts.channelViews(profile).map(({ kind, lastDeliveredAt, failing }) => ({ kind, lastDeliveredAt, failing }));
  return { store, accounts, profile, notifier, posts, answers, view, tick: (s: number) => { now += s; }, now: () => now };
}

describe("a channel that stops taking messages", () => {
  it("is marked as failing with what it answered, since when, and is whole again when it takes one", async () => {
    const s = setup();
    s.accounts.addChannel(s.profile, NTFY, T0);
    expect(s.view()).toEqual([{ kind: "ntfy", lastDeliveredAt: null, failing: null }]);

    expect(await s.notifier.notify(A, "alert", "one")).toEqual({ delivered: 1, failed: 0 });
    expect(s.view()).toEqual([{ kind: "ntfy", lastDeliveredAt: T0, failing: null }]);

    s.answers["ntfy.sh"] = 404;
    s.tick(100);
    expect(await s.notifier.notify(A, "alert", "two")).toEqual({ delivered: 0, failed: 1 });
    expect(s.view()).toEqual([{ kind: "ntfy", lastDeliveredAt: T0, failing: { since: T0 + 100, why: "it answered 404" } }]);
    s.tick(100);
    await s.notifier.notify(A, "alert", "three");
    expect(s.view()[0]!.failing).toEqual({ since: T0 + 100, why: "it answered 404" }); // since the first time, not the latest

    // no answer at all is said as that, and what went wrong inside is not shown to anyone
    s.answers["ntfy.sh"] = "down";
    await s.notifier.notify(A, "alert", "four");
    expect(s.view()[0]!.failing).toEqual({ since: T0 + 100, why: "it could not be reached" });
    expect(JSON.stringify(s.view())).not.toContain("ENOTFOUND");
    expect(s.notifier.undelivered.at(-1)!.why).toContain("ENOTFOUND"); // that is for the log

    s.answers["ntfy.sh"] = 200;
    s.tick(100);
    await s.notifier.notify(A, "alert", "five");
    expect(s.view()).toEqual([{ kind: "ntfy", lastDeliveredAt: T0 + 300, failing: null }]);
    expect(refusalOf(null)).toBe("it could not be reached");
  });

  it("is said on the profile's other channels, once a day, by a hint and never by its address", async () => {
    const s = setup();
    s.accounts.setTier(s.profile, "pro");
    s.accounts.addChannel(s.profile, NTFY, T0);
    s.accounts.addChannel(s.profile, DISCORD, T0 + 1);
    s.answers["discord.com"] = 404; // the webhook was deleted

    expect(await s.notifier.notify(A, "urgent", "Sent everything to a look-alike.")).toEqual({ delivered: 1, failed: 1 });
    const notice = failingChannelNotice("Discord webhook …abcd", "it answered 404");
    expect(s.posts.map((p) => [new URL(p.url).host, p.title])).toEqual([["ntfy.sh", `Warden Sentinel: urgent (${A.slice(0, 4)}..${A.slice(-4)})`], ["discord.com", ""], ["ntfy.sh", "Warden Sentinel: your profile"]]);
    expect(s.posts[2]!.body).toBe(notice);
    expect(notice).toBe("An alert could not be delivered to another of this profile's channels (Discord webhook …abcd): it answered 404. Send it a test from the Sentinel page, or replace it.");
    expect(notice).not.toContain("discord.com");

    // the next alert the same day goes out without saying it again
    s.posts.length = 0;
    s.tick(3600);
    await s.notifier.notify(A, "alert", "another");
    expect(s.posts.filter((p) => p.title === "Warden Sentinel: your profile")).toEqual([]);
    s.tick(86_400);
    await s.notifier.notify(A, "alert", "a day on");
    expect(s.posts.filter((p) => p.title === "Warden Sentinel: your profile")).toHaveLength(1);
    // when every channel is failing there is nobody to tell, and nothing is sent in circles
    s.answers["ntfy.sh"] = 500;
    s.posts.length = 0;
    s.tick(2 * 86_400);
    expect(await s.notifier.notify(A, "alert", "nobody hears this")).toEqual({ delivered: 0, failed: 2 });
    expect(s.posts).toHaveLength(2);
    // and that did not use up the day's one notice: the moment a channel works again, it hears about the other
    s.answers["ntfy.sh"] = 200;
    s.posts.length = 0;
    s.tick(60);
    await s.notifier.notify(A, "alert", "ntfy is back");
    expect(s.posts.filter((p) => p.title === "Warden Sentinel: your profile").map((p) => new URL(p.url).host)).toEqual(["ntfy.sh"]);
  });

  it("a test that works clears it, and a test that does not sets it, with the same words as before", async () => {
    const s = setup();
    const added = s.accounts.addChannel(s.profile, NTFY, T0);
    const id = added.ok ? added.channel.id : "";
    s.answers["ntfy.sh"] = 404;
    expect(await s.notifier.test(s.profile, id)).toEqual({ ok: false, status: 502, why: "the channel did not take it (it answered 404). Check the address, or remove it and add it again." });
    expect(s.view()[0]!.failing).toEqual({ since: T0, why: "it answered 404" });
    s.answers["ntfy.sh"] = "down";
    expect(await s.notifier.test(s.profile, id)).toEqual({ ok: false, status: 502, why: "the channel could not be reached. Check the address, or try again in a minute." });
    s.answers["ntfy.sh"] = 200;
    s.tick(60);
    expect(await s.notifier.test(s.profile, id)).toEqual({ ok: true });
    expect(s.view()).toEqual([{ kind: "ntfy", lastDeliveredAt: T0 + 60, failing: null }]);
    // a channel removed while a message was on its way is simply not there to mark
    s.accounts.removeChannel(s.profile, id);
    expect(() => s.accounts.noteDelivery(id, false, "it answered 404", T0)).not.toThrow();
    expect(s.view()).toEqual([]);
  });
});

describe("an alert no channel took", () => {
  it("says so on the alert, for a failing channel and for no channel at all; one that was delivered does not", async () => {
    const s = setup();
    const handle = api({ accounts: s.accounts, store: s.store, watcher: { ownerSigned: async () => undefined, confirmOwn: async () => true }, nonces: new NonceBook(), origin: "https://warden.lamportrobotics.com", now: s.now });
    const session = s.accounts.startSession(s.profile, T0);
    const events = async () => ((await handle({ method: "GET", path: "/v1/events", bearer: session, body: undefined, ip: "10.0.0.1" })).body as any).events.map((e: any) => [e.sentence, e.undelivered]);
    // the watching itself going blind is raised the same way an alert is (main.ts), so it is the path used here
    const down = new Set<string>([A]);
    const watcher = { passAll: async (only?: (a: string) => boolean) => ({ raised: [], blind: s.store.wallets().filter((w) => (!only || only(w.address)) && down.has(w.address)).map((w) => ({ wallet: w.address, why: "the RPC answered 503" })) }) };
    const round = watchRound({ watcher, store: s.store, notifier: s.notifier, pace: pacer(() => "watch", { watch: 60, pro: 20 }), blindness: new Blindness(0), state: { lastPassAt: null, blind: 0 }, log: () => undefined });

    await round(T0); // no channel at all
    expect(await events()).toEqual([[expect.stringContaining("has not been able to read this wallet"), true]]);

    s.accounts.addChannel(s.profile, NTFY, T0);
    down.clear();
    await round(T0 + 60); // delivered
    s.answers["ntfy.sh"] = 410;
    down.add(A);
    await round(T0 + 120); // the channel refuses
    expect((await events()).map((e: [string, boolean]) => e[1])).toEqual([true, false, true]);
    // marking twice is once, and an alert that is gone is not marked
    const id = s.store.events(A)[0]!.id!;
    s.store.markUndelivered(id);
    s.store.markUndelivered("no-such-alert");
    expect(s.store.events(A).filter((e) => e.undelivered)).toHaveLength(2);
  });
});
