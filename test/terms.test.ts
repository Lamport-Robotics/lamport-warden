/**
 * The terms state the paid plan in the same three lines the Sentinel page shows before the button, and a few
 * things the service has to actually do. This fails when the terms and the product part ways.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOLDER_MIN_LAMPORT, HOLDER_PRICE_CENTS, PRICE_CENTS, prepaidTerms, purchaseTerms } from "../sentinel/service/src/plans.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const terms = read("site", "terms", "index.html");
const text = terms.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the terms", () => {
  it("state the plan in the page's own words, at the full price", () => {
    const list = /<ul id="plan-terms">([\s\S]*?)<\/ul>/.exec(terms)![1]!;
    const lines = [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.trim());
    expect(lines).toEqual(purchaseTerms(PRICE_CENTS, PRICE_CENTS, HOLDER_PRICE_CENTS, HOLDER_MIN_LAMPORT));
  });

  it("state paying ahead in the page's own words too, and what the service does with a payment that is short or late", () => {
    const list = /<ul id="prepaid-terms">([\s\S]*?)<\/ul>/.exec(terms)![1]!;
    const lines = [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.trim());
    expect(lines).toEqual(prepaidTerms(PRICE_CENTS, 1));
    const prepaid = read("sentinel", "service", "src", "prepaid.ts");
    // final, and at least the amount: both are what the code checks
    expect(text).toContain("A payment counts when the chain has made it final and the amount that arrived is at least the amount shown.");
    expect(prepaid).toContain('commitment: "finalized"');
    expect(prepaid).toContain("if (got < BigInt(intent.units))");
    // ten minutes for a price in SOL, three days' notice before the time is up
    expect(prepaid).toContain("export const SOL_QUOTE_SECONDS = 600;");
    expect(prepaid).toContain("export const REMIND_BEFORE_SECONDS = 3 * 86_400;");
  });

  it("promise only what the service does", () => {
    // cancelling at Stripe ends the plan at the end of the paid month, as the terms say
    expect(read("scripts", "stripe-sentinel-setup.mjs")).toContain("['features[subscription_cancel][mode]', 'at_period_end']");
    // a price that moves with the token is told before the bill
    expect(read("sentinel", "service", "src", "billing.ts")).toContain("this.tell(p.id, priceChangedNotice(");
    // rescue is not something Sentinel can do today
    expect(text).toContain("Sentinel cannot move anything today.");
    expect(read("sentinel", "service", "src", "server.ts")).toContain('if (answer === "rescue") return no(501, "rescue is not switched on yet.");');
    // each wallet is added on its own signature
    expect(text).toContain("Sentinel asks each one for a signature before it is added.");
  });

  it("are linked from where someone pays, and from every page's foot", () => {
    expect(read("sentinel", "web", "src", "app.ts")).toContain('link.href = "/terms/";');
    for (const page of [read("site", "index.html"), read("sentinel", "web", "index.html"), read("site", "try", "index.html"), read("site", "privacy", "index.html")]) expect(page).toContain('href="/terms/"');
    expect(terms).toContain('href="/privacy/"');
    expect(read("site", "deploy.sh")).toContain("terms/index.html");
    // and say since when they hold
    expect(text).toMatch(/In force from \d{1,2} [A-Z][a-z]+ 20\d\d\./);
    // no script, no tracker: the page is text
    expect(terms).not.toMatch(/<script/i);
  });
});
