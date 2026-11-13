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

export interface Quote { enabled: true; checkoutOpen: boolean; tier: Profile["tier"]; subscribed: boolean; status: string | null; price: "full" | "holder"; cents: number; centsFull: number; centsHolder: number; holder: boolean; holderMin: number }

export class Billing {
  constructor(private cfg: BillingConfig, private accounts: Accounts, private rpc: Rpc, private stripe: Stripe) {}

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
    return {
      enabled: true, checkoutOpen: this.cfg.checkoutOpen, tier: p.tier, subscribed: !!p.billing && PAID.has(p.billing.status), status: p.billing?.status ?? null,
      price, cents: price === "holder" ? this.cfg.centsHolder : this.cfg.centsFull, centsFull: this.cfg.centsFull, centsHolder: this.cfg.centsHolder, holder, holderMin: this.cfg.holderMin,
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
    const session = await this.stripe.call("POST", "/checkout/sessions", {
      mode: "subscription",
      "line_items[0][price]": holder ? this.cfg.priceHolder : this.cfg.priceFull,
      "line_items[0][quantity]": "1",
      client_reference_id: profile,
      "metadata[profile]": profile,
      "metadata[price]": holder ? "holder" : "full",
      "subscription_data[metadata][profile]": profile,
      success_url: `${this.cfg.pageUrl}?plan=started`,
      cancel_url: `${this.cfg.pageUrl}?plan=cancelled`,
    });
    if (typeof session?.url !== "string" || !session.url.startsWith("https://")) throw new Error("stripe returned no checkout address");
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

  /** Takes a subscription as Stripe describes it and makes the profile match. */
  private apply(profile: string, subscription: any): void {
    const p = this.accounts.profile(profile);
    if (!p || typeof subscription?.id !== "string" || typeof subscription?.customer !== "string") return;
    const status = String(subscription.status ?? "");
    // a profile has one subscription: news about an old one must not undo the current one
    if (p.billing && p.billing.subscription !== subscription.id && PAID.has(p.billing.status)) return;
    this.accounts.setBilling(profile, { customer: subscription.customer, subscription: subscription.id, price: this.priceOf(subscription), status });
    this.accounts.setTier(profile, PAID.has(status) ? "pro" : "watch");
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
        moved += 1;
      } catch {
        failed += 1; // tried again tomorrow; the owner keeps the price they have
      }
    }
    return { moved, failed };
  }
}
