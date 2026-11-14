/**
 * What is sold is what is described. The plans are defined once (sentinel/service/src/plans.ts), the service
 * enforces that definition, and the pages that describe the plans in fixed text (the Warden site and the
 * store listing) must say the same words. If a number in the definition changes and a page does not, this
 * fails.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOLDER_MIN_LAMPORT, HOLDER_PRICE_CENTS, PLANS, PRICE_CENTS, PRO_FEATURES, PRO_NOT_YET, WATCH_FEATURES, paceText } from "../sentinel/service/src/plans.js";
import { LAMPORT_MINT, configFrom } from "../sentinel/service/src/main.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const flat = (s: string) => s.split(/\s+/).join(" ");
const read = (...p: string[]) => flat(readFileSync(join(root, ...p), "utf8"));

describe("the plans, wherever they are described", () => {
  it.each([["the Warden site", read("site", "index.html")], ["the store listing", read("store", "listing.md")]])("%s says what the definition says", (_name, page) => {
    for (const line of [...WATCH_FEATURES, ...PRO_FEATURES, PRO_NOT_YET]) expect(page, line).toContain(flat(line));
    expect(page).toContain(`$${PRICE_CENTS / 100} a month`);
    expect(page).toContain(`$${HOLDER_PRICE_CENTS / 100}`);
    expect(page).toContain(`${HOLDER_MIN_LAMPORT.toLocaleString("en-US")} $LAMPORT`);
    // rescue is never listed as something Pro gives today
    expect(page).not.toMatch(/Pro (includes|gives you|comes with) rescue/i);
  });

  it("an owner is told how their wallets are being read, as it is right now", () => {
    expect(paceText(PLANS.watch.pollSeconds, null)).toBe("Each wallet is read every minute."); // the service did not say: only the promise
    expect(paceText(PLANS.pro.pollSeconds, { push: false, late: false })).toBe("Each wallet is read every 20 seconds.");
    expect(paceText(PLANS.watch.pollSeconds, { push: true, late: false })).toBe("Each wallet is read every minute, and at once when the network reports a transaction in it.");
    // behind is said, never hidden, and nothing faster is claimed than is happening
    expect(paceText(PLANS.pro.pollSeconds, { push: true, late: true })).toBe("Each wallet is read every 20 seconds, and at once when the network reports a transaction in it. Sentinel is behind right now: some wallets are being read later than that.");
    expect(paceText(PLANS.watch.pollSeconds, { push: false, late: true })).toBe("Each wallet is read every minute. Sentinel is behind right now: some wallets are being read later than that.");
  });

  it("the definition itself is the one the service runs with", () => {
    // "telegram" is a kind on both plans, and is offered only where the service has a bot (telegram-channel.test.ts)
    expect(PLANS.watch).toEqual({ name: "Watch", wallets: 3, channels: 1, kinds: ["ntfy", "telegram"], pollSeconds: 60, push: false, rescue: false });
    expect(PLANS.pro).toEqual({ name: "Pro", wallets: 10, channels: 5, kinds: ["ntfy", "discord", "slack", "telegram"], pollSeconds: 20, push: true, rescue: true });
    // being told as it happens is what the paid plan sells first
    expect(PRO_FEATURES[0]).toBe("Alerts in seconds: a wallet is read as soon as the network reports a transaction in it, without waiting for its turn");
    // Pro is never slower, smaller or narrower than Watch
    expect(PLANS.pro.wallets).toBeGreaterThan(PLANS.watch.wallets);
    expect(PLANS.pro.pollSeconds).toBeLessThan(PLANS.watch.pollSeconds);
    expect(PLANS.pro.channels).toBeGreaterThan(PLANS.watch.channels);
    for (const kind of PLANS.watch.kinds) expect(PLANS.pro.kinds).toContain(kind);
    // the service's own defaults: the same prices, the same token and amount, the same pace
    const base = { SENTINEL_RPC_URL: "https://rpc.example", SENTINEL_DATA_KEY: Buffer.alloc(32, 1).toString("base64") };
    const cfg = configFrom({ ...base, SENTINEL_STRIPE_SECRET_KEY: "sk_test_x", SENTINEL_STRIPE_WEBHOOK_SECRET: "whsec_x", SENTINEL_STRIPE_PRICE_FULL: "price_1", SENTINEL_STRIPE_PRICE_HOLDER: "price_2" });
    expect(cfg).toMatchObject({ ok: true, config: { pollSeconds: PLANS.watch.pollSeconds, proPollSeconds: PLANS.pro.pollSeconds, billing: { centsFull: PRICE_CENTS, centsHolder: HOLDER_PRICE_CENTS, holderMin: HOLDER_MIN_LAMPORT, holderMint: LAMPORT_MINT } } });
  });

  it("the setup script makes the prices the definition names", () => {
    const script = read("scripts", "stripe-sentinel-setup.mjs");
    expect(script).toContain(`opts.centsFull ?? ${PRICE_CENTS}`);
    expect(script).toContain(`opts.centsHolder ?? ${HOLDER_PRICE_CENTS}`);
  });
});
