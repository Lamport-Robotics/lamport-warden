/**
 * The paid plan against Stripe itself, in test mode. Skipped unless SENTINEL_STRIPE_TEST_KEY holds a test key:
 *
 *   SENTINEL_STRIPE_TEST_KEY=sk_test_... pnpm vitest run sentinel/service/test/stripe.real.test.ts
 *
 * It refuses a live key. It makes the product and prices if they are missing (scripts/stripe-sentinel-setup.mjs),
 * a customer with Stripe's test card, and a subscription, and removes the customer afterwards.
 */
import "../../../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { Accounts } from "../src/accounts.js";
import { Billing, Stripe, type BillingConfig } from "../src/billing.js";
import { LAMPORT_MINT } from "../src/main.js";
import type { Rpc } from "../src/rpc.js";
import { MemoryStore } from "../src/store.js";
// @ts-expect-error a plain script, shared with the command line
import { setup, stripeCaller } from "../../../scripts/stripe-sentinel-setup.mjs";

const key = process.env.SENTINEL_STRIPE_TEST_KEY ?? "";
const usable = /^(sk|rk)_test_/.test(key);

describe.skipIf(!usable)("the paid plan against Stripe in test mode", () => {
  it("makes a checkout page, follows a subscription up, across prices, and down", async () => {
    const call = stripeCaller(key) as (method: string, path: string, pairs?: string[][]) => Promise<any>;
    const made = await setup(call);
    expect(made.priceFull).toMatch(/^price_/);
    expect(made.priceHolder).toMatch(/^price_/);
    expect(await setup(call)).toMatchObject({ priceFull: made.priceFull, priceHolder: made.priceHolder, portalConfiguration: made.portalConfiguration }); // again: nothing new

    const wallet = Keypair.generate().publicKey.toBase58();
    const balances: Record<string, number> = {};
    const chain: Rpc = { call: async (_m, params: any[]) => ({ value: balances[params[0]] ? [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(BigInt(balances[params[0]]!) * 1_000_000n) } } } } } }] : [] }) };
    const store = new MemoryStore();
    const accounts = new Accounts(store, Buffer.alloc(32, 3));
    const admitted = accounts.admit(wallet, null, Math.floor(Date.now() / 1000));
    if (!admitted.ok) throw new Error("setup");
    const profile = admitted.profile;
    const cfg: BillingConfig = { secretKey: key, webhookSecret: "unused", priceFull: made.priceFull, priceHolder: made.priceHolder, centsFull: 1500, centsHolder: 1000, holderMint: LAMPORT_MINT, holderMin: 250_000, pageUrl: "https://warden.lamportrobotics.com/sentinel/", checkoutOpen: true, portalConfiguration: made.portalConfiguration };
    const billing = new Billing(cfg, accounts, chain, new Stripe(key));

    // Stripe accepts the checkout request as built, at either price
    const full = await billing.checkout(profile);
    expect(full).toMatchObject({ ok: true, url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//) });
    balances[wallet] = 250_000;
    expect(await billing.checkout(profile)).toMatchObject({ ok: true, url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//) });

    // what Stripe has after someone pays: a customer with a card and an active subscription at the holder price
    const customer = await call("POST", "/customers", [["description", "Warden Sentinel integration test"], ["payment_method", "pm_card_visa"], ["invoice_settings[default_payment_method]", "pm_card_visa"]]);
    try {
      const sub = await call("POST", "/subscriptions", [["customer", customer.id], ["items[0][price]", made.priceHolder], ["metadata[profile]", profile]]);
      expect(sub.status).toBe("active");
      await billing.onEvent({ type: "customer.subscription.created", data: { object: { id: sub.id } } });
      expect(accounts.profile(profile)).toMatchObject({ tier: "pro", billing: { customer: customer.id, subscription: sub.id, price: "holder", status: "active" } });
      expect(await billing.quote(profile)).toMatchObject({ subscribed: true, price: "holder", cents: 1000 });

      // the tokens are sold: the next bill is at the full price, and Stripe says so itself
      balances[wallet] = 0;
      expect(await billing.reprice()).toEqual({ moved: 1, failed: 0 });
      expect((await call("GET", `/subscriptions/${sub.id}`)).items.data[0].price.id).toBe(made.priceFull);
      expect(accounts.profile(profile)!.billing!.price).toBe("full");
      // nothing was charged for the change
      const invoices = await call("GET", "/invoices", [["subscription", sub.id], ["limit", "10"]]);
      expect(invoices.data.map((i: any) => i.amount_paid)).toEqual([1000]);

      // Stripe's own page for the card and for cancelling
      expect(await billing.portal(profile)).toMatchObject({ ok: true, url: expect.stringMatching(/^https:\/\/billing\.stripe\.com\//) });

      // cancelled: the profile goes back to the free tier
      await fetch(`https://api.stripe.com/v1/subscriptions/${sub.id}`, { method: "DELETE", headers: { authorization: `Bearer ${key}` } });
      await billing.onEvent({ type: "customer.subscription.deleted", data: { object: { id: sub.id } } });
      expect(accounts.profile(profile)).toMatchObject({ tier: "watch", billing: { status: "canceled" } });
    } finally {
      await fetch(`https://api.stripe.com/v1/customers/${customer.id}`, { method: "DELETE", headers: { authorization: `Bearer ${key}` } });
    }
  }, 120_000);
});
