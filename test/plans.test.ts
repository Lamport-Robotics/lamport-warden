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
import { HOLDER_MIN_LAMPORT, HOLDER_PRICE_CENTS, PLANS, PRICE_CENTS, PRO_FEATURES, PRO_NOT_YET, WATCH_FEATURES } from "../sentinel/service/src/plans.js";
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

  it("the definition itself is the one the service runs with", () => {
    expect(PLANS.watch).toEqual({ name: "Watch", wallets: 3, channels: 1, kinds: ["ntfy"], pollSeconds: 60 });
    expect(PLANS.pro).toEqual({ name: "Pro", wallets: 10, channels: 5, kinds: ["ntfy", "discord", "slack"], pollSeconds: 20 });
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
