/**
 * The paid tier: one monthly subscription through Stripe, at one of two prices. A profile with a wallet that
 * holds enough $LAMPORT pays the holder price; the wallets in a profile each proved themselves with a
 * signature, so "this profile holds it" is something the service knows, not something a page claims.
 *
 * Stripe holds the card and the email. Here there are only the ids of the customer and the subscription.
 *
 * What moves a profile between tiers is Stripe saying so, in a webhook whose signature is checked, never the
 * owner's browser coming back from a checkout page. The holder price is looked at again every day: holding
 * the tokens at checkout and selling them the next morning moves the next bill to the full price, and buying
 * them moves it down.
 *
 * No Stripe library: four calls and one signature check.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Accounts } from "./accounts.js";
import { paymentFailedNotice, planCancelledNotice, planEndedNotice, planResumedNotice, planStartedNotice, priceChangedNotice } from "./notices.js";
import { PLANS } from "./plans.js";
import type { Rpc } from "./rpc.js";
import type { Profile } from "./store.js";

export interface BillingConfig {
  secretKey: string;
  webhookSecret: string;
  /** Stripe price ids for the two monthly prices. */
  priceFull: string;
  priceHolder: string;
  /** What each costs, in cents, for the page to show. */
  centsFull: number;
  centsHolder: number;
  /** The token that earns the holder price, and how much of it, in whole tokens. */
  holderMint: string;
  holderMin: number;
  /** Where Stripe sends the owner back to. */
  pageUrl: string;
  /** Checkout can be closed while the rest keeps working: existing subscriptions are still honoured. */
  checkoutOpen: boolean;
  /** The customer portal set up for this plan (the setup script makes it). Absent: the account's default. */
  portalConfiguration?: string;
}

export type StripeFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/** The few Stripe calls this needs, form-encoded as Stripe wants them. */
export class Stripe {
  constructor(private secretKey: string, private fetchImpl: StripeFetch = (u, i) => fetch(u, i)) {}

  async call(method: "GET" | "POST", path: string, params: Record<string, string> = {}): Promise<any> {
    const body = new URLSearchParams(params).toString();
    const res = await this.fetchImpl(`https://api.stripe.com/v1${path}${method === "GET" && body ? `?${body}` : ""}`, {
      method,
      headers: { authorization: `Bearer ${this.secretKey}`, ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      ...(method === "POST" ? { body } : {}),
    });
    const json = await res.json().catch(() => null);
    // Stripe's own message can name a card or a customer: it goes to the log, not to the page
    if (!res.ok) throw new Error(`stripe ${method} ${path}: ${res.status} ${String(json?.error?.code ?? json?.error?.type ?? "")}`.trim());
    return json;
  }
}

/**
 * Stripe signs each webhook: `t=<time>,v1=<hmac of "<time>.<body>">`. The body has to be the bytes as they
 * arrived, and an old one is refused, so a captured webhook cannot be played again later.
 */
export function verifyStripeSignature(payload: string, header: string | undefined, secret: string, now: number, toleranceSeconds = 300): boolean {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sent = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!t || !/^\d+$/.test(t) || sent.length === 0 || Math.abs(now - Number(t)) > toleranceSeconds) return false;
  const want = createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest();
  return sent.some((v) => { const got = Buffer.from(v, "hex"); return got.length === want.length && timingSafeEqual(got, want); });
}

/** How much of a token a wallet holds, in the token's smallest units, across all its accounts for that mint. */
export async function tokenUnits(rpc: Rpc, wallet: string, mint: string): Promise<bigint> {
  const res = await rpc.call("getTokenAccountsByOwner", [wallet, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  let total = 0n;
  for (const entry of res?.value ?? []) {
    const amount = entry?.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (typeof amount === "string" && /^\d+$/.test(amount)) total += BigInt(amount);
  }
  return total;
}

/** A subscription in one of these states is paid for. Past due is Stripe still trying the card: not cut off yet. */
const PAID = new Set(["active", "trialing", "past_due"]);
const HOLDER_DECIMALS = 6;

export interface Quote {
  enabled: true; checkoutOpen: boolean; tier: Profile["tier"]; subscribed: boolean; status: string | null; price: "full" | "holder"; cents: number; centsFull: number; centsHolder: number; holder: boolean; holderMin: number;
  /** For a running plan: when the next bill is due, or null when it was cancelled or Stripe did not say. */
  renewsAt: number | null;
  /** For a plan the owner cancelled: its last day. */
  endsAt: number | null;
}

const when = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

export class Billing {
  /** The checkout page last opened for each profile and not yet paid: there is one at a time. */
  private open = new Map<string, string>();

  /**
   * @param opts.notice tells the profile's owner, through its channels, what the plan now is (notices.ts);
   *                    the addresses are taken as it is called
   */
  constructor(private cfg: BillingConfig, private accounts: Accounts, private rpc: Rpc, private stripe: Stripe, private opts: { now?: () => number; notice?: (profile: string, sentence: string) => Promise<void> } = {}) {}

  private now(): number { return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000); }
  private tell(profile: string, sentence: string): void { void this.opts.notice?.(profile, sentence).catch(() => undefined); }

  /**
   * True when the wallets of this profile hold enough of the token between them. Throws when a wallet could
   * not be read: "the RPC was down" must never be taken for "sold the tokens".
   */
  async holder(profile: string): Promise<boolean> {
    const min = BigInt(this.cfg.holderMin) * 10n ** BigInt(HOLDER_DECIMALS);
    let total = 0n;
    for (const wallet of this.accounts.walletsOf(profile)) {
      total += await tokenUnits(this.rpc, wallet, this.cfg.holderMint);
      if (total >= min) return true;
    }
    return false;
  }

  async quote(profile: string): Promise<Quote> {
    const p = this.accounts.profile(profile)!;
    // shown as not holding when the balance cannot be read; checkout itself refuses rather than guess
    const holder = await this.holder(profile).catch(() => false);
    const price = p.billing && PAID.has(p.billing.status) ? p.billing.price : holder ? "holder" : "full";
    const subscribed = !!p.billing && PAID.has(p.billing.status);
    return {
      enabled: true, checkoutOpen: this.cfg.checkoutOpen, tier: p.tier, subscribed, status: p.billing?.status ?? null,
      price, cents: price === "holder" ? this.cfg.centsHolder : this.cfg.centsFull, centsFull: this.cfg.centsFull, centsHolder: this.cfg.centsHolder, holder, holderMin: this.cfg.holderMin,
      renewsAt: subscribed && !p.billing!.endsAt ? p.billing!.periodEnd ?? null : null,
      endsAt: subscribed ? p.billing!.endsAt ?? null : null,
    };
  }

  /** A Stripe Checkout page for this profile, at the price its wallets earn right now. */
  async checkout(profile: string): Promise<{ ok: true; url: string } | { ok: false; status: number; why: string }> {
    const p = this.accounts.profile(profile);
    if (!p) return { ok: false, status: 401, why: "sign in again." };
    if (!this.cfg.checkoutOpen) return { ok: false, status: 403, why: "the paid plan is not on sale yet." };
    if (p.billing && PAID.has(p.billing.status)) return { ok: false, status: 409, why: "this profile already has the paid plan." };
    let holder: boolean;
    try { holder = await this.holder(profile); } catch { return { ok: false, status: 502, why: "I could not read your wallet's balance just now, so I can't tell which price is yours. Try again in a minute." }; }
    // One checkout page at a time. An older page left open in another tab is closed before a new one is made,
    // so paying on both, and so being charged twice a month, cannot happen. If the older one was just paid,
    // nothing new is opened: the plan is on its way.
    const earlier = this.open.get(profile);
    if (earlier) {
      const state = await this.stripe.call("POST", `/checkout/sessions/${earlier}/expire`).then(() => "expired", async () => String((await this.stripe.call("GET", `/checkout/sessions/${earlier}`).catch(() => null))?.status ?? "unknown"));
      if (state === "complete") return { ok: false, status: 409, why: "a payment for this profile was just made and is being confirmed. Give it a minute, then load the page again." };
      this.open.delete(profile);
    }
    const params: Record<string, string> = {
      mode: "subscription",
      "line_items[0][price]": holder ? this.cfg.priceHolder : this.cfg.priceFull,
      "line_items[0][quantity]": "1",
      client_reference_id: profile,
      "metadata[profile]": profile,
      "metadata[price]": holder ? "holder" : "full",
      "subscription_data[metadata][profile]": profile,
      success_url: `${this.cfg.pageUrl}?plan=started`,
      cancel_url: `${this.cfg.pageUrl}?plan=cancelled`,
      // the price was worked out just now, so the page is good for half an hour (Stripe's shortest), not a day
      expires_at: String(this.now() + 31 * 60),
    };
    // someone who had the plan before comes back as the same Stripe customer: one history, one portal
    const customer = p.billing?.customer;
    let session: any;
    try {
      session = await this.stripe.call("POST", "/checkout/sessions", customer ? { ...params, customer } : params);
    } catch (e) {
      // a customer Stripe no longer has is not a reason to refuse a sale
      if (!customer || !/resource_missing/.test(String((e as Error).message ?? e))) throw e;
      session = await this.stripe.call("POST", "/checkout/sessions", params);
    }
    if (typeof session?.url !== "string" || !session.url.startsWith("https://")) throw new Error("stripe returned no checkout address");
    if (typeof session.id === "string" && /^cs_[A-Za-z0-9_]+$/.test(session.id)) this.open.set(profile, session.id);
    return { ok: true, url: session.url };
  }

  /** Stripe's own page for changing the card or cancelling. */
  async portal(profile: string): Promise<{ ok: true; url: string } | { ok: false; status: number; why: string }> {
    const p = this.accounts.profile(profile);
    if (!p?.billing) return { ok: false, status: 404, why: "this profile has no subscription." };
    const session = await this.stripe.call("POST", "/billing_portal/sessions", { customer: p.billing.customer, return_url: this.cfg.pageUrl, ...(this.cfg.portalConfiguration ? { configuration: this.cfg.portalConfiguration } : {}) });
    if (typeof session?.url !== "string" || !session.url.startsWith("https://")) throw new Error("stripe returned no portal address");
    return { ok: true, url: session.url };
  }

  private priceOf(subscription: any): "full" | "holder" {
    return subscription?.items?.data?.[0]?.price?.id === this.cfg.priceHolder ? "holder" : "full";
  }

  /**
   * True for a subscription to this plan and nothing else. The Stripe account can sell other things, and a
   * subscription to one of them, whatever it names as its profile, is not a payment for this.
   */
  private ours(subscription: any): boolean {
    const items = subscription?.items?.data;
    const price = Array.isArray(items) && items.length === 1 ? items[0]?.price?.id : null;
    return price === this.cfg.priceFull || price === this.cfg.priceHolder;
  }

  /** Takes a subscription as Stripe describes it and makes the profile match. The owner hears what changed. */
  private apply(profile: string, subscription: any): void {
    const p = this.accounts.profile(profile);
    if (!p || typeof subscription?.id !== "string" || typeof subscription?.customer !== "string" || !this.ours(subscription)) return;
    const status = String(subscription.status ?? "");
    // a profile has one subscription: news about an old one must not undo the current one
    if (p.billing && p.billing.subscription !== subscription.id && PAID.has(p.billing.status)) return;
    const was = { tier: p.tier, status: p.billing?.status ?? null, endsAt: p.billing && p.billing.subscription === subscription.id ? p.billing.endsAt : undefined };
    const tier = PAID.has(status) ? "pro" : "watch";
    // Stripe moved the period's dates from the subscription to its item; either is read
    const periodEnd = when(subscription.items?.data?.[0]?.current_period_end) ?? when(subscription.current_period_end);
    // cancelled by its owner: it runs to the end of what was paid for, and does not renew
    const endsAt = tier === "pro" && (subscription.cancel_at_period_end === true || when(subscription.cancel_at)) ? when(subscription.cancel_at) ?? periodEnd : undefined;
    // said before the plan's channels and wallets go, so it reaches the channels the plan paid for
    if (was.tier === "pro" && tier === "watch") this.tell(profile, planEndedNotice(PLANS.watch.wallets, Math.max(0, this.accounts.walletsOf(profile).length - PLANS.watch.wallets)));
    this.accounts.setBilling(profile, { customer: subscription.customer, subscription: subscription.id, price: this.priceOf(subscription), status, ...(periodEnd ? { periodEnd } : {}), ...(endsAt ? { endsAt } : {}) });
    this.accounts.setTier(profile, tier);
    if (tier === "pro") this.open.delete(profile);
    if (was.tier === "watch" && tier === "pro") this.tell(profile, planStartedNotice(PLANS.pro.wallets, PLANS.pro.pollSeconds));
    else if (status === "past_due" && was.status !== "past_due") this.tell(profile, paymentFailedNotice());
    // cancelling is something a thief with a key could do from the profile's page: the owner hears of it, and of its undoing
    if (tier === "pro" && was.tier === "pro" && endsAt && !was.endsAt) this.tell(profile, planCancelledNotice(endsAt));
    else if (tier === "pro" && was.tier === "pro" && !endsAt && was.endsAt) this.tell(profile, planResumedNotice());
  }

  /**
   * One webhook from Stripe, already checked for its signature. The event is only a prompt: the subscription
   * is read from Stripe again, so events arriving twice or out of order end in the same place.
   */
  async onEvent(event: any): Promise<void> {
    const object = event?.data?.object;
    let subscriptionId: string | null = null;
    let profile: string | null = null;
    if (event?.type === "checkout.session.completed" && object?.mode === "subscription") {
      subscriptionId = typeof object.subscription === "string" ? object.subscription : null;
      profile = typeof object.client_reference_id === "string" ? object.client_reference_id : null;
    } else if (typeof event?.type === "string" && event.type.startsWith("customer.subscription.")) {
      subscriptionId = typeof object?.id === "string" ? object.id : null;
    } else {
      return;
    }
    if (!subscriptionId || !/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) return;
    const subscription = await this.stripe.call("GET", `/subscriptions/${subscriptionId}`);
    profile = this.accounts.profileBySubscription(subscriptionId)?.id ?? profile ?? (typeof subscription?.metadata?.profile === "string" ? subscription.metadata.profile : null);
    if (profile) this.apply(profile, subscription);
  }

  /**
   * The daily look at Stripe's side of things. Webhooks are how news arrives, and a webhook can be missed
   * (the service was down for longer than Stripe keeps trying, or the endpoint was changed). So once a day
   * every paid subscription to this plan is read from Stripe and each profile is made to match: one that
   * paid and was never lifted is lifted, one whose plan ended and was never told is put back. A subscription
   * that is being paid and belongs to no profile here is returned, for whoever runs the service: somebody is
   * being charged for nothing.
   */
  async reconcile(): Promise<{ healed: number; failed: number; orphans: { subscription: string; profile: string | null }[] }> {
    let healed = 0, failed = 0;
    const orphans: { subscription: string; profile: string | null }[] = [];
    const seen = new Set<string>();
    const before = (id: string) => { const p = this.accounts.profile(id); return p ? `${p.tier}/${p.billing?.subscription ?? ""}/${p.billing?.status ?? ""}/${p.billing?.price ?? ""}/${p.billing?.endsAt ?? ""}` : ""; };
    const sync = (profile: string, subscription: any) => { const was = before(profile); this.apply(profile, subscription); if (before(profile) !== was) healed += 1; };
    try {
      for (const price of [this.cfg.priceFull, this.cfg.priceHolder]) {
        let after: string | undefined;
        for (let page = 0; page < 50; page++) {
          const res = await this.stripe.call("GET", "/subscriptions", { price, status: "active", limit: "100", ...(after ? { starting_after: after } : {}) });
          const data: any[] = Array.isArray(res?.data) ? res.data : [];
          for (const s of data) {
            if (typeof s?.id !== "string" || !this.ours(s)) continue;
            seen.add(s.id);
            const named = typeof s.metadata?.profile === "string" ? s.metadata.profile : null;
            const profile = this.accounts.profileBySubscription(s.id)?.id ?? (named && this.accounts.profile(named) ? named : null);
            if (profile) sync(profile, s); else orphans.push({ subscription: s.id, profile: named });
          }
          if (!res?.has_more || data.length === 0) break;
          after = String(data[data.length - 1].id);
        }
      }
    } catch {
      // Stripe could not be asked: nothing is concluded from a list that was cut short
      return { healed, failed: failed + 1, orphans: [] };
    }
    // a profile that believes it is paid, whose subscription is no longer among the active ones: ask about that one
    for (const p of this.accounts.profiles()) {
      if (!p.billing || !PAID.has(p.billing.status) || seen.has(p.billing.subscription)) continue;
      try { sync(p.id, await this.stripe.call("GET", `/subscriptions/${p.billing.subscription}`)); } catch { failed += 1; }
    }
    return { healed, failed, orphans };
  }

  /**
   * The daily look at who holds the token. A subscription on the wrong price is moved to the right one from
   * its next bill on, with nothing charged or refunded for the days already paid.
   */
  async reprice(): Promise<{ moved: number; failed: number }> {
    let moved = 0, failed = 0;
    for (const p of this.accounts.profiles()) {
      if (!p.billing || !PAID.has(p.billing.status)) continue;
      try {
        const want = (await this.holder(p.id)) ? "holder" : "full";
        if (want === p.billing.price) continue;
        const subscription = await this.stripe.call("GET", `/subscriptions/${p.billing.subscription}`);
        const item = subscription?.items?.data?.[0]?.id;
        if (typeof item !== "string") throw new Error("the subscription has no item");
        const updated = await this.stripe.call("POST", `/subscriptions/${p.billing.subscription}`, { "items[0][id]": item, "items[0][price]": want === "holder" ? this.cfg.priceHolder : this.cfg.priceFull, proration_behavior: "none" });
        this.apply(p.id, updated);
        // a price that changes is said before the bill that carries it, not found on a statement
        this.tell(p.id, priceChangedNotice(want, want === "holder" ? this.cfg.centsHolder : this.cfg.centsFull, this.cfg.holderMin));
        moved += 1;
      } catch {
        failed += 1; // tried again tomorrow; the owner keeps the price they have
      }
    }
    return { moved, failed };
  }
}
