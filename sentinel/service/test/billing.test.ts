/**
 * The paid plan: who gets which price, what moves a profile between tiers, and what a forged or replayed
 * webhook can do (nothing). Stripe is a stand-in that keeps subscriptions the way Stripe does.
 */
import "../../../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { Accounts } from "../src/accounts.js";
import { Billing, Stripe, tokenUnits, verifyStripeSignature, type BillingConfig, type StripeFetch } from "../src/billing.js";
import { LAMPORT_MINT, configFrom } from "../src/main.js";
import { paymentFailedNotice, planEndedNotice, planStartedNotice, priceChangedNotice } from "../src/notices.js";
import { ChannelNotifier } from "../src/notify.js";
import type { Rpc } from "../src/rpc.js";
import { api } from "../src/server.js";
import { NonceBook } from "../src/signin.js";
import { MemoryStore } from "../src/store.js";

const T0 = 1_794_312_000;
const addr = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58();
const A = addr(1), B = addr(2);
const WHSEC = "whsec_test_secret";
const cfg: BillingConfig = { secretKey: "sk_test_x", webhookSecret: WHSEC, priceFull: "price_full", priceHolder: "price_holder", centsFull: 1500, centsHolder: 1000, holderMint: LAMPORT_MINT, holderMin: 250_000, pageUrl: "https://warden.lamportrobotics.com/sentinel/", checkoutOpen: true };

/** Token balances by wallet, in whole tokens; `down` makes every read fail. */
class Chain implements Rpc {
  balances: Record<string, number[]> = {};
  down = false;
  async call(method: string, params: any[]): Promise<any> {
    if (this.down) throw new Error("the RPC answered 503");
    if (method !== "getTokenAccountsByOwner" || params[1]?.mint !== LAMPORT_MINT) throw new Error(`unexpected ${method}`);
    return { value: (this.balances[params[0]] ?? []).map((whole) => ({ account: { data: { parsed: { info: { tokenAmount: { amount: String(BigInt(whole) * 1_000_000n) } } } } } })) };
  }
}

/** Stripe, as far as this uses it. */
class FakeStripe {
  calls: { method: string; path: string; params: Record<string, string> }[] = [];
  subscriptions = new Map<string, any>();
  /** Checkout pages by id: open, expired, or complete (paid). */
  sessions = new Map<string, { status: "open" | "expired" | "complete" }>();
  /** Customers Stripe no longer has. */
  gone = new Set<string>();
  pageSize = 100;
  down = false;
  private n = 0;
  fetch: StripeFetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace("/v1", "");
    const params = Object.fromEntries(new URLSearchParams(init.method === "POST" ? init.body ?? "" : u.search));
    this.calls.push({ method: init.method, path, params });
    const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
    if (this.down) return reply(503, { error: { type: "api_error" } });
    if (init.headers.authorization !== "Bearer sk_test_x") return reply(401, { error: { type: "invalid_request_error" } });
    if (init.method === "POST" && path === "/checkout/sessions") {
      if (params.customer && this.gone.has(params.customer)) return reply(400, { error: { code: "resource_missing" } });
      const id = `cs_${++this.n}`;
      this.sessions.set(id, { status: "open" });
      return reply(200, { id, url: `https://checkout.stripe.com/c/pay/${id}` });
    }
    const cs = /^\/checkout\/sessions\/(cs_\w+?)(\/expire)?$/.exec(path);
    if (cs) {
      const session = this.sessions.get(cs[1]!);
      if (!session) return reply(404, { error: { code: "resource_missing" } });
      if (cs[2]) { if (session.status !== "open") return reply(400, { error: { code: "checkout_session_not_open" } }); session.status = "expired"; }
      return reply(200, { id: cs[1], status: session.status });
    }
    if (init.method === "POST" && path === "/billing_portal/sessions") return reply(200, { url: "https://billing.stripe.com/p/session/x" });
    if (init.method === "GET" && path === "/subscriptions") {
      // Stripe's list: by price and status, a page at a time, each page starting after the last id of the one before
      const all = [...this.subscriptions.values()].filter((x) => x.status === params.status && x.items.data.some((i: any) => i.price.id === params.price));
      const from = params.starting_after ? all.findIndex((x) => x.id === params.starting_after) + 1 : 0;
      const size = Math.min(Number(params.limit ?? 10), this.pageSize);
      return reply(200, { data: all.slice(from, from + size), has_more: from + size < all.length });
    }
    const sub = /^\/subscriptions\/(sub_\w+)$/.exec(path);
    if (sub) {
      const s = this.subscriptions.get(sub[1]!);
      if (!s) return reply(404, { error: { code: "resource_missing" } });
      if (init.method === "POST") { if (params["items[0][id]"] !== s.items.data[0].id) return reply(400, { error: { code: "bad_item" } }); s.items.data[0].price.id = params["items[0][price]"]; }
      return reply(200, s);
    }
    return reply(404, { error: { code: "unknown" } });
  };
  /** What Stripe has after someone pays on the checkout page. */
  start(id: string, profile: string, price: string, customer = "cus_1") {
    this.subscriptions.set(id, { id, customer, status: "active", metadata: { profile }, items: { data: [{ id: `si_${id}`, price: { id: price } }] } });
    return { type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: id, client_reference_id: profile, customer } } };
  }
  changed(id: string, status: string) { const s = this.subscriptions.get(id); s.status = status; return { type: status === "canceled" ? "customer.subscription.deleted" : "customer.subscription.updated", data: { object: { ...s } } }; }
}

function setup(checkoutOpen = true) {
  const store = new MemoryStore();
  const accounts = new Accounts(store, Buffer.alloc(32, 9));
  const chain = new Chain(), stripe = new FakeStripe();
  /** What the owner was told about the plan, and the channels in use at that moment. */
  const said: { profile: string; sentence: string; channels: string[] }[] = [];
  const billing = new Billing({ ...cfg, checkoutOpen }, accounts, chain, new Stripe(cfg.secretKey, stripe.fetch), { now: () => T0, notice: async (profile, sentence) => { said.push({ profile, sentence, channels: accounts.channelsOfProfile(profile).map((c) => c.kind) }); } });
  const admitted = accounts.admit(A, null, T0);
  if (!admitted.ok) throw new Error("setup");
  return { store, accounts, chain, stripe, billing, said, profile: admitted.profile };
}
const sign = (payload: string, t: number, secret = WHSEC) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;

describe("the holder price", () => {
  it("goes to a profile whose wallets hold 250,000 between them, and to nobody on a guess", async () => {
    const { accounts, chain, billing, profile } = setup();
    expect(await billing.holder(profile)).toBe(false);
    chain.balances[A] = [249_999];
    expect(await billing.holder(profile)).toBe(false);
    chain.balances[A] = [100_000, 150_000]; // two token accounts of one wallet
    expect(await billing.holder(profile)).toBe(true);
    chain.balances[A] = [200_000];
    accounts.admit(B, profile, T0 + 1);
    chain.balances[B] = [50_000]; // two wallets of one profile, each proved by its own signature
    expect(await billing.holder(profile)).toBe(true);
    expect(await tokenUnits(chain, A, LAMPORT_MINT)).toBe(200_000_000_000n);
    // the RPC is down: not "no", but "unknown"
    chain.down = true;
    await expect(billing.holder(profile)).rejects.toThrow();
    expect(await billing.quote(profile)).toMatchObject({ holder: false, price: "full", cents: 1500, centsHolder: 1000, holderMin: 250_000 });
    expect(await billing.checkout(profile)).toMatchObject({ ok: false, status: 502 });
  });

  it("decides which price the checkout page charges", async () => {
    const { chain, stripe, billing, profile } = setup();
    expect(await billing.quote(profile)).toMatchObject({ enabled: true, checkoutOpen: true, tier: "watch", subscribed: false, price: "full", cents: 1500, holder: false });
    expect(await billing.checkout(profile)).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_1" });
    expect(stripe.calls.at(-1)).toMatchObject({ method: "POST", path: "/checkout/sessions", params: { mode: "subscription", "line_items[0][price]": "price_full", "line_items[0][quantity]": "1", client_reference_id: profile, "subscription_data[metadata][profile]": profile, success_url: "https://warden.lamportrobotics.com/sentinel/?plan=started" } });
    chain.balances[A] = [300_000];
    expect(await billing.quote(profile)).toMatchObject({ price: "holder", cents: 1000, holder: true });
    await billing.checkout(profile);
    expect(stripe.calls.at(-1)!.params["line_items[0][price]"]).toBe("price_holder");
  });

  it("sells nothing while checkout is closed", async () => {
    const { stripe, billing, profile } = setup(false);
    expect(await billing.checkout(profile)).toEqual({ ok: false, status: 403, why: "the paid plan is not on sale yet." });
    expect(stripe.calls).toEqual([]);
    expect(await billing.quote(profile)).toMatchObject({ checkoutOpen: false });
  });
});

describe("what Stripe says moves the tier", () => {
  it("a paid checkout lifts the profile, and reading more wallets comes with it", async () => {
    const { store, accounts, stripe, billing, profile } = setup();
    for (let i = 0; i < 2; i++) accounts.admit(addr(10 + i), profile, T0 + 1 + i);
    expect(accounts.admit(addr(20), profile, T0 + 9)).toMatchObject({ ok: false, status: 403 }); // three on the free tier

    await billing.onEvent(stripe.start("sub_1", profile, "price_full"));
    expect(accounts.profile(profile)).toMatchObject({ tier: "pro", billing: { customer: "cus_1", subscription: "sub_1", price: "full", status: "active" } });
    expect(await billing.quote(profile)).toMatchObject({ tier: "pro", subscribed: true, status: "active", price: "full" });
    expect(accounts.admit(addr(20), profile, T0 + 10)).toMatchObject({ ok: true });
    expect(store.wallets()).toHaveLength(4);
    // already paying: no second checkout
    expect(await billing.checkout(profile)).toMatchObject({ ok: false, status: 409 });
    expect(await billing.portal(profile)).toEqual({ ok: true, url: "https://billing.stripe.com/p/session/x" });
    expect(stripe.calls.at(-1)).toMatchObject({ path: "/billing_portal/sessions", params: { customer: "cus_1" } });
  });

  it("a card that is failing is not cut off; a cancelled plan pauses the wallets over the free limit and keeps what was learned", async () => {
    const { store, accounts, stripe, billing, profile } = setup();
    await billing.onEvent(stripe.start("sub_1", profile, "price_full"));
    const extra = [addr(10), addr(11), addr(12)];
    extra.forEach((w, i) => accounts.admit(w, profile, T0 + 1 + i));
    store.save(extra[2]!, { ...store.record(extra[2]!), cursor: "sigX", lastSeenAt: T0 });

    await billing.onEvent(stripe.changed("sub_1", "past_due"));
    expect(accounts.profile(profile)!.tier).toBe("pro");
    expect(store.wallets()).toHaveLength(4);

    await billing.onEvent(stripe.changed("sub_1", "canceled"));
    expect(accounts.profile(profile)).toMatchObject({ tier: "watch", billing: { status: "canceled" } });
    expect(store.wallets().map((w) => w.address)).toEqual([A, extra[0], extra[1]]); // the three oldest
    expect(accounts.paused(extra[2]!)).toBe(true);
    expect(store.record(extra[2]!).cursor).toBe("sigX"); // paused, not forgotten
    expect(await billing.quote(profile)).toMatchObject({ tier: "watch", subscribed: false, price: "full" });
    // removing a watched wallet lets the paused one in
    expect(accounts.removeWallet(profile, extra[0]!)).toMatchObject({ ok: true });
    expect(accounts.paused(extra[2]!)).toBe(false);
    expect(store.wallets().map((w) => w.address)).toEqual([A, extra[1], extra[2]]);
    // and paying again is possible
    expect(await billing.checkout(profile)).toMatchObject({ ok: true });
  });

  it("ends in the same place when events repeat, arrive out of order, or name something else", async () => {
    const { accounts, stripe, billing, profile } = setup();
    const started = stripe.start("sub_1", profile, "price_holder");
    await billing.onEvent(started);
    const cancelled = stripe.changed("sub_1", "canceled");
    await billing.onEvent(cancelled);
    await billing.onEvent(started); // the first event, delivered again after the cancellation
    expect(accounts.profile(profile)).toMatchObject({ tier: "watch", billing: { status: "canceled", price: "holder" } });

    // a new subscription, then late news about the old one
    await billing.onEvent(stripe.start("sub_2", profile, "price_full"));
    await billing.onEvent(cancelled);
    expect(accounts.profile(profile)).toMatchObject({ tier: "pro", billing: { subscription: "sub_2", status: "active" } });

    // events that are not about a subscription, or about one nobody here has, change nothing
    const before = JSON.stringify(accounts.profile(profile));
    for (const e of [{ type: "invoice.paid", data: { object: { subscription: "sub_2" } } }, { type: "checkout.session.completed", data: { object: { mode: "payment", subscription: null } } }, { type: "customer.subscription.updated", data: { object: { id: "sub_'; drop" } } }, {}, null, "x"]) await billing.onEvent(e);
    stripe.subscriptions.set("sub_9", { id: "sub_9", customer: "cus_9", status: "active", metadata: { profile: "nobody" }, items: { data: [{ id: "si_9", price: { id: "price_full" } }] } });
    await billing.onEvent({ type: "customer.subscription.updated", data: { object: { id: "sub_9" } } });
    expect(JSON.stringify(accounts.profile(profile))).toBe(before);
    // Stripe being away is an error, so that the webhook is sent again
    stripe.down = true;
    await expect(billing.onEvent(started)).rejects.toThrow(/stripe GET \/subscriptions\/sub_1: 503/);
  });

  it("the last wallet cannot be removed while the plan is running", async () => {
    const { accounts, stripe, billing, profile } = setup();
    await billing.onEvent(stripe.start("sub_1", profile, "price_full"));
    expect(accounts.removeWallet(profile, A)).toMatchObject({ ok: false, status: 409 });
    expect(accounts.profile(profile)).toBeDefined();
    await billing.onEvent(stripe.changed("sub_1", "canceled"));
    expect(accounts.removeWallet(profile, A)).toEqual({ ok: true, profileRemoved: true });
  });
});

describe("the checkout page", () => {
  const sessionCalls = (stripe: FakeStripe) => stripe.calls.filter((c) => c.path.startsWith("/checkout/sessions")).map((c) => `${c.method} ${c.path}`);

  it("is good for half an hour, and there is one at a time: opening another closes the one before", async () => {
    const { stripe, billing, profile } = setup();
    expect(await billing.checkout(profile)).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_1" });
    expect(stripe.calls.at(-1)!.params.expires_at).toBe(String(T0 + 31 * 60));
    expect(stripe.calls.at(-1)!.params.customer).toBeUndefined();

    expect(await billing.checkout(profile)).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_2" });
    expect(sessionCalls(stripe)).toEqual(["POST /checkout/sessions", "POST /checkout/sessions/cs_1/expire", "POST /checkout/sessions"]);
    expect(stripe.sessions.get("cs_1")!.status).toBe("expired"); // paying on the page left open in another tab is no longer possible
    expect(stripe.sessions.get("cs_2")!.status).toBe("open");
  });

  it("is not opened again while a payment just made is being confirmed", async () => {
    const { accounts, stripe, billing, profile } = setup();
    await billing.checkout(profile);
    stripe.sessions.get("cs_1")!.status = "complete"; // paid; Stripe's word has not arrived yet
    expect(await billing.checkout(profile)).toEqual({ ok: false, status: 409, why: "a payment for this profile was just made and is being confirmed. Give it a minute, then load the page again." });
    expect(stripe.sessions.size).toBe(1);
    // Stripe's word arrives: the plan is on, and that page is no longer remembered
    await billing.onEvent(stripe.start("sub_1", profile, "price_full"));
    expect(accounts.profile(profile)!.tier).toBe("pro");
    await billing.onEvent(stripe.changed("sub_1", "canceled"));
    expect(await billing.checkout(profile)).toMatchObject({ ok: true });
    expect(sessionCalls(stripe).filter((c) => c.endsWith("/expire"))).toHaveLength(1); // only the try before the payment was known
  });

  it("an earlier page that already ran out, or that Stripe cannot find, does not stand in the way", async () => {
    const { stripe, billing, profile } = setup();
    await billing.checkout(profile);
    stripe.sessions.get("cs_1")!.status = "expired";
    expect(await billing.checkout(profile)).toMatchObject({ ok: true });
    stripe.sessions.delete("cs_2");
    expect(await billing.checkout(profile)).toMatchObject({ ok: true });
  });

  it("someone coming back is the same Stripe customer, and a customer Stripe no longer has is not a reason to refuse", async () => {
    const { stripe, billing, profile } = setup();
    await billing.onEvent(stripe.start("sub_1", profile, "price_full", "cus_7"));
    await billing.onEvent(stripe.changed("sub_1", "canceled"));
    expect(await billing.checkout(profile)).toMatchObject({ ok: true });
    expect(stripe.calls.at(-1)!.params.customer).toBe("cus_7");

    stripe.gone.add("cus_7");
    expect(await billing.checkout(profile)).toMatchObject({ ok: true });
    expect(stripe.calls.at(-2)!.params.customer).toBe("cus_7");
    expect(stripe.calls.at(-1)!.params.customer).toBeUndefined();
    // any other refusal from Stripe is not papered over
    stripe.down = true;
    await expect(billing.checkout(profile)).rejects.toThrow(/stripe POST \/checkout\/sessions/);
  });
});

describe("a subscription to something else", () => {
  it("is not a payment for this plan, whatever profile it names", async () => {
    const { accounts, stripe, billing, said, profile } = setup();
    // the account sells another subscription, and its checkout names this profile
    await billing.onEvent(stripe.start("sub_other", profile, "price_other"));
    expect(accounts.profile(profile)).toMatchObject({ tier: "watch" });
    expect(accounts.profile(profile)!.billing).toBeUndefined();
    // this plan's price with something else beside it is not this plan either
    const event = stripe.start("sub_two", profile, "price_full");
    stripe.subscriptions.get("sub_two").items.data.push({ id: "si_extra", price: { id: "price_other" } });
    await billing.onEvent(event);
    expect(accounts.profile(profile)!.tier).toBe("watch");
    expect(said).toEqual([]);

    // and a name every object answers to is not a profile
    for (const name of ["__proto__", "constructor", "__defineGetter__"]) await billing.onEvent(stripe.start(`sub_${name.replace(/_/g, "")}`, name, "price_full"));
    expect(({} as any).billing).toBeUndefined();
    expect(({} as any).tier).toBeUndefined();
    expect(accounts.profile(profile)!.billing).toBeUndefined();
  });
});

describe("what the owner is told about the plan", () => {
  it("that it started, that a payment failed (once), and that it ended, on the channels it paid for", async () => {
    const { accounts, stripe, billing, said, profile } = setup();
    accounts.addChannel(profile, "https://ntfy.sh/alice-topic-123", T0);
    await billing.onEvent(stripe.start("sub_1", profile, "price_full"));
    expect(said).toEqual([{ profile, sentence: planStartedNotice(10, 20), channels: ["ntfy"] }]);
    expect(said[0]!.sentence).toBe("This profile's Sentinel plan has started: up to 10 wallets, each read every 20 seconds.");
    // the same news twice is said once
    await billing.onEvent(stripe.start("sub_1", profile, "price_full"));
    expect(said).toHaveLength(1);

    accounts.addChannel(profile, ["https://discord.com/api", "webhooks", "123456789012345678", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcd"].join("/"), T0 + 1);
    for (let i = 0; i < 4; i++) accounts.admit(addr(30 + i), profile, T0 + 2 + i);

    await billing.onEvent(stripe.changed("sub_1", "past_due"));
    await billing.onEvent(stripe.changed("sub_1", "past_due"));
    expect(said.slice(1)).toEqual([{ profile, sentence: paymentFailedNotice(), channels: ["ntfy", "discord"] }]);

    await billing.onEvent(stripe.changed("sub_1", "canceled"));
    // five wallets, three watched on the free plan; and Discord still hears it, though it is about to go quiet
    expect(said[2]).toEqual({ profile, sentence: planEndedNotice(3, 2), channels: ["ntfy", "discord"] });
    expect(said[2]!.sentence).toBe("This profile's Sentinel plan has ended, so it is on the free plan again: 3 wallets, read every minute, alerts to one ntfy channel. 2 of its wallets are no longer watched.");
    expect(accounts.channelsOfProfile(profile).map((c) => c.kind)).toEqual(["ntfy"]);
    expect(planEndedNotice(3, 0)).not.toContain("no longer watched");
    expect(planEndedNotice(3, 1)).toContain("1 of its wallets is no longer watched.");
  });

  it("that the price is about to change, before the bill that carries it", async () => {
    const { chain, stripe, billing, said, profile } = setup();
    chain.balances[A] = [300_000];
    await billing.onEvent(stripe.start("sub_1", profile, "price_holder"));
    said.length = 0;
    chain.balances[A] = [10];
    expect(await billing.reprice()).toEqual({ moved: 1, failed: 0 });
    expect(said.map((x) => x.sentence)).toEqual([priceChangedNotice("full", 1500, 250_000)]);
    expect(said[0]!.sentence).toBe("From its next bill, this profile's Sentinel plan is $15 a month: its wallets no longer hold 250,000 $LAMPORT between them.");
    chain.balances[A] = [250_000];
    await billing.reprice();
    expect(said[1]!.sentence).toBe("From its next bill, this profile's Sentinel plan is $10 a month: its wallets hold 250,000 $LAMPORT between them.");
    // nothing moved, nothing said; a balance that could not be read is not news either
    await billing.reprice();
    chain.down = true;
    await billing.reprice();
    expect(said).toHaveLength(2);
    expect(priceChangedNotice("full", 1250, 250_000)).toContain("$12.50 a month");
  });

  it("through the real notifier: the plan's end reaches the Discord channel that is about to stop being used", async () => {
    const store = new MemoryStore();
    const accounts = new Accounts(store, Buffer.alloc(32, 9));
    const stripe = new FakeStripe();
    const posts: string[] = [];
    const notifier = new ChannelNotifier(accounts, async (url) => { posts.push(new URL(url).host); return { ok: true, status: 200 }; });
    const billing = new Billing(cfg, accounts, new Chain(), new Stripe(cfg.secretKey, stripe.fetch), { notice: (p, s) => notifier.notice(p, s) });
    const admitted = accounts.admit(A, null, T0);
    const profile = admitted.ok ? admitted.profile : "";
    await billing.onEvent(stripe.start("sub_1", profile, "price_full"));
    accounts.addChannel(profile, ["https://discord.com/api", "webhooks", "123456789012345678", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcd"].join("/"), T0);
    posts.length = 0;
    await billing.onEvent(stripe.changed("sub_1", "canceled"));
    expect(posts).toEqual(["discord.com"]);
    expect(accounts.channelsOfProfile(profile)).toEqual([]); // and from now on it is not used
  });
});

describe("the daily look at Stripe's side", () => {
  it("lifts a profile that paid and was never told so, and says so to its owner", async () => {
    const { accounts, stripe, billing, said, profile } = setup();
    stripe.start("sub_1", profile, "price_holder"); // paid at Stripe; the webhook never arrived
    expect(accounts.profile(profile)!.tier).toBe("watch");
    expect(await billing.reconcile()).toEqual({ healed: 1, failed: 0, orphans: [] });
    expect(accounts.profile(profile)).toMatchObject({ tier: "pro", billing: { subscription: "sub_1", price: "holder", status: "active" } });
    expect(said.map((x) => x.sentence)).toEqual([planStartedNotice(10, 20)]);
    // in line already: nothing is changed and nothing more is said
    expect(await billing.reconcile()).toEqual({ healed: 0, failed: 0, orphans: [] });
    expect(said).toHaveLength(1);
  });

  it("puts back a profile whose plan ended at Stripe without a word arriving", async () => {
    const { accounts, stripe, billing, said, profile } = setup();
    await billing.onEvent(stripe.start("sub_1", profile, "price_full"));
    stripe.subscriptions.get("sub_1").status = "canceled"; // cancelled at Stripe; the webhook never arrived
    said.length = 0;
    expect(await billing.reconcile()).toEqual({ healed: 1, failed: 0, orphans: [] });
    expect(accounts.profile(profile)).toMatchObject({ tier: "watch", billing: { status: "canceled" } });
    expect(said.map((x) => x.sentence)).toEqual([planEndedNotice(3, 0)]);
    // a card that is failing is learned of the same way, and the plan stays on
    const other = setup();
    await other.billing.onEvent(other.stripe.start("sub_2", other.profile, "price_full"));
    other.stripe.subscriptions.get("sub_2").status = "past_due";
    expect(await other.billing.reconcile()).toMatchObject({ healed: 1, failed: 0 });
    expect(other.accounts.profile(other.profile)).toMatchObject({ tier: "pro", billing: { status: "past_due" } });
  });

  it("reports a subscription that is being paid and belongs to no profile here, and changes nothing for it", async () => {
    const { accounts, stripe, billing, profile } = setup();
    stripe.start("sub_lost", "a-profile-that-is-gone", "price_full");
    stripe.start("sub_nameless", "", "price_holder");
    stripe.subscriptions.get("sub_nameless").metadata = {};
    stripe.start("sub_other_product", profile, "price_other"); // something else the account sells: not this plan's business
    expect(await billing.reconcile()).toEqual({ healed: 0, failed: 0, orphans: [{ subscription: "sub_lost", profile: "a-profile-that-is-gone" }, { subscription: "sub_nameless", profile: null }] });
    expect(accounts.profile(profile)!.tier).toBe("watch");
    // a name every object answers to is not a profile here either
    stripe.start("sub_proto", "__proto__", "price_full");
    expect((await billing.reconcile()).orphans.map((o) => o.subscription)).toContain("sub_proto");
    expect(({} as any).tier).toBeUndefined();
  });

  it("reads every page of the list, and concludes nothing from a list it could not finish", async () => {
    const { accounts, stripe, billing, profile } = setup();
    stripe.pageSize = 2;
    for (let i = 0; i < 5; i++) stripe.start(`sub_x${i}`, `gone-${i}`, "price_full");
    stripe.start("sub_mine", profile, "price_full"); // the last one on the last page
    const result = await billing.reconcile();
    expect(result.orphans).toHaveLength(5);
    expect(result.healed).toBe(1);
    expect(accounts.profile(profile)!.tier).toBe("pro");
    expect(stripe.calls.filter((c) => c.method === "GET" && c.path === "/subscriptions" && c.params.price === "price_full")).toHaveLength(3);

    stripe.down = true;
    expect(await billing.reconcile()).toEqual({ healed: 0, failed: 1, orphans: [] });
    expect(accounts.profile(profile)!.tier).toBe("pro"); // not being able to ask is not a cancellation
  });
});

describe("the daily look at who holds the token", () => {
  it("moves a subscription to the price its wallets earn, from the next bill, and leaves it alone when unsure", async () => {
    const { accounts, chain, stripe, billing, profile } = setup();
    chain.balances[A] = [300_000];
    await billing.onEvent(stripe.start("sub_1", profile, "price_holder"));
    stripe.calls = [];
    expect(await billing.reprice()).toEqual({ moved: 0, failed: 0 });
    expect(stripe.calls).toEqual([]); // still holding: Stripe is not even asked

    chain.balances[A] = [10];
    expect(await billing.reprice()).toEqual({ moved: 1, failed: 0 });
    expect(stripe.calls.at(-1)).toEqual({ method: "POST", path: "/subscriptions/sub_1", params: { "items[0][id]": "si_sub_1", "items[0][price]": "price_full", proration_behavior: "none" } });
    expect(accounts.profile(profile)!.billing).toMatchObject({ price: "full", status: "active" });
    expect(accounts.profile(profile)!.tier).toBe("pro");

    chain.balances[A] = [250_000];
    expect(await billing.reprice()).toEqual({ moved: 1, failed: 0 });
    expect(accounts.profile(profile)!.billing!.price).toBe("holder");

    // the RPC is down: nobody is moved to the full price for it
    chain.down = true;
    expect(await billing.reprice()).toEqual({ moved: 0, failed: 1 });
    expect(accounts.profile(profile)!.billing!.price).toBe("holder");
    // a cancelled plan is not touched
    chain.down = false; chain.balances[A] = [];
    await billing.onEvent(stripe.changed("sub_1", "canceled"));
    stripe.calls = [];
    expect(await billing.reprice()).toEqual({ moved: 0, failed: 0 });
    expect(stripe.calls).toEqual([]);
  });
});

describe("a webhook", () => {
  const body = JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });

  it("is believed only with Stripe's signature over the exact body, and not long after", () => {
    expect(verifyStripeSignature(body, sign(body, T0), WHSEC, T0)).toBe(true);
    expect(verifyStripeSignature(body, sign(body, T0), WHSEC, T0 + 299)).toBe(true);
    expect(verifyStripeSignature(body, `${sign(body, T0)},v1=${"0".repeat(64)}`, WHSEC, T0)).toBe(true); // Stripe sends two while a secret rolls
    for (const [why, payload, header, now] of [
      ["another secret", body, sign(body, T0, "whsec_other"), T0],
      ["a changed body", body.replace("sub_1", "sub_2"), sign(body, T0), T0],
      ["an old one, replayed", body, sign(body, T0), T0 + 301],
      ["a time moved forward without re-signing", body, sign(body, T0).replace(`t=${T0}`, `t=${T0 + 600}`), T0 + 600],
      ["no signature", body, undefined, T0],
      ["a header that is not one", body, "v1=abc", T0],
      ["not hex", body, `t=${T0},v1=zz`, T0],
    ] as const) expect(verifyStripeSignature(payload, header, WHSEC, now), why).toBe(false);
    expect(verifyStripeSignature(body, sign(body, T0, ""), "", T0)).toBe(false);
  });

  it("over the API: a forged one changes nothing, a real one does, and the page's return from checkout is not proof", async () => {
    const { store, accounts, stripe, billing, profile } = setup();
    const handle = api({ accounts, store, watcher: { ownerSigned: async () => undefined, confirmOwn: async () => true }, nonces: new NonceBook(), origin: "https://warden.lamportrobotics.com", now: () => T0, billing: { api: billing, webhookSecret: WHSEC } });
    const hook = (raw: string, stripeSignature?: string) => handle({ method: "POST", path: "/v1/stripe/webhook", bearer: null, body: undefined, ip: "1.1.1.1", raw, stripeSignature });
    const event = JSON.stringify(stripe.start("sub_1", profile, "price_full"));

    expect(await hook(event, sign(event, T0, "whsec_guess"))).toMatchObject({ status: 400 });
    expect(await hook(event)).toMatchObject({ status: 400 });
    expect(accounts.profile(profile)!.tier).toBe("watch");

    expect(await hook(event, sign(event, T0))).toEqual({ status: 200, body: { received: true } });
    expect(accounts.profile(profile)!.tier).toBe("pro");

    const session = accounts.startSession(profile, T0);
    const get = (path: string, method = "GET") => handle({ method, path, bearer: session, body: undefined, ip: "1.1.1.1" });
    expect((await get("/v1/billing")).body).toMatchObject({ enabled: true, tier: "pro", subscribed: true, cents: 1500 });
    expect((await get("/v1/billing/portal", "POST")).body).toEqual({ url: "https://billing.stripe.com/p/session/x" });
    expect(await get("/v1/billing/checkout", "POST")).toMatchObject({ status: 409 });
    expect((await get("/v1/me")).body).toMatchObject({ profile: { tier: "pro" }, limits: { wallets: 10 } });
    expect((await handle({ method: "GET", path: "/v1/billing", bearer: null, body: undefined, ip: "1.1.1.1" })).status).toBe(401);

    // no paid plan configured: the page is told so, and there is no webhook to post to
    const bare = api({ accounts, store, watcher: { ownerSigned: async () => undefined, confirmOwn: async () => true }, nonces: new NonceBook(), origin: "https://warden.lamportrobotics.com", now: () => T0 });
    expect((await bare({ method: "GET", path: "/v1/billing", bearer: session, body: undefined, ip: "1.1.1.1" })).body).toEqual({ enabled: false });
    expect((await bare({ method: "POST", path: "/v1/stripe/webhook", bearer: null, body: undefined, ip: "1.1.1.1", raw: event, stripeSignature: sign(event, T0) })).status).toBe(404);
    expect((await bare({ method: "POST", path: "/v1/billing/checkout", bearer: session, body: undefined, ip: "1.1.1.1" })).status).toBe(404);
  });
});

describe("the paid plan's settings", () => {
  const base = { SENTINEL_RPC_URL: "https://rpc.example", SENTINEL_DATA_KEY: Buffer.alloc(32, 1).toString("base64") };
  const stripe = { SENTINEL_STRIPE_SECRET_KEY: "sk_test_x", SENTINEL_STRIPE_WEBHOOK_SECRET: "whsec_x", SENTINEL_STRIPE_PRICE_FULL: "price_1", SENTINEL_STRIPE_PRICE_HOLDER: "price_2" };

  it("are all or nothing, and checkout stays closed unless it is opened", () => {
    expect(configFrom(base)).toMatchObject({ ok: true, config: { billing: null } });
    const set = configFrom({ ...base, ...stripe });
    expect(set).toMatchObject({ ok: true, config: { billing: { centsFull: 1500, centsHolder: 1000, holderMin: 250_000, holderMint: LAMPORT_MINT, checkoutOpen: false, pageUrl: "https://warden.lamportrobotics.com/sentinel/", holderRpcUrl: "https://rpc.example" } } });
    expect(configFrom({ ...base, ...stripe, SENTINEL_CHECKOUT: "open", SENTINEL_HOLDER_RPC_URL: "https://mainnet.example" })).toMatchObject({ ok: true, config: { billing: { checkoutOpen: true, holderRpcUrl: "https://mainnet.example" } } });
    expect(configFrom({ ...base, ...stripe, SENTINEL_STRIPE_WEBHOOK_SECRET: "" })).toEqual({ ok: false, why: expect.stringContaining("missing SENTINEL_STRIPE_WEBHOOK_SECRET") });
    expect(configFrom({ ...base, ...stripe, SENTINEL_STRIPE_PRICE_HOLDER: "price_1" })).toMatchObject({ ok: false });
    expect(configFrom({ ...base, ...stripe, SENTINEL_STRIPE_PRICE_FULL: "prod_1" })).toMatchObject({ ok: false });
    expect(configFrom({ ...base, ...stripe, SENTINEL_PRICE_CENTS: "-5" })).toMatchObject({ ok: false });
  });
});
