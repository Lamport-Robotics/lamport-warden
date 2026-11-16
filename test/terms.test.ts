/**
 * The terms state the paid plan in the same three lines the Sentinel page shows before the button, and a few
 * things the service has to actually do. This fails when the terms and the product part ways.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOLDER_MIN_LAMPORT, HOLDER_PRICE_CENTS, LAMPORT_TERMS, PRICE_CENTS, RESCUE_TERMS, lamportTerms, prepaidTerms, purchaseTerms } from "../sentinel/service/src/plans.js";

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
    expect(prepaid).toContain('const list = await this.listed(intent, "finalized");');
    expect(prepaid).toContain('const tx = await this.readOne(intent, signature, "finalized");');
    expect(prepaid).toContain("if (got < BigInt(intent.units))");
    // ten minutes for a price in SOL, three days' notice before the time is up
    expect(prepaid).toContain("export const SOL_QUOTE_SECONDS = 600;");
    expect(prepaid).toContain("export const REMIND_BEFORE_SECONDS = 3 * 86_400;");
  });

  it("state paying in LAMPORT in the page's own words, with no number of tokens: the page shows that", () => {
    const list = /<ul id="lamport-terms">([\s\S]*?)<\/ul>/.exec(terms)![1]!;
    const lines = [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.trim());
    expect(lines).toEqual([...LAMPORT_TERMS]);
    // the lines that do not depend on the amount are the same for any amount
    expect(lamportTerms(4500, 3).slice(1)).toEqual([...LAMPORT_TERMS]);
    const prepaid = read("sentinel", "service", "src", "prepaid.ts"), price = read("sentinel", "service", "src", "lamportprice.ts");
    // the price in dollars, the holder's included, at the token's price: two sources that agree, and never above the price one hour or six hours before
    expect(text).toContain("It is the same price in dollars, the holder's price included, and the page shows how many tokens that is before you pay.");
    expect(prepaid).toContain("const cents = (holder ? this.selling.centsHolder : this.selling.centsFull) * months;");
    expect(prepaid).toContain("units = lamportFor(cents, await this.opts.lamportPrice!(), token.decimals);");
    expect(price).toContain("return Math.min(now, ...pools.flatMap((a) => a.before.filter(sane)));");
    // read from the token's own pool, by its address
    expect(price).toContain("url: `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}`");
    expect(price).toContain("url: `https://api.dexscreener.com/latest/dex/pairs/solana/${pool}`");
    expect(price).toContain("const now = agreed(answers.map((a) => a.price), LAMPORT_AGREE_WITHIN, LEAST, MOST);");
    // ten minutes, as for SOL, and late after that
    expect(text).toContain("Like an amount in SOL, an amount in $LAMPORT holds for ten minutes, and when the token cannot be priced no amount in it is shown.");
    expect(prepaid).toContain('expiresAt: now + (asset === "USDC" ? USDC_QUOTE_SECONDS : SOL_QUOTE_SECONDS)');
    expect(prepaid).toContain('if (intent.asset !== "USDC" && (tx.blockTime ?? this.now()) > intent.expiresAt + SOL_QUOTE_GRACE_SECONDS)');
    expect(text).toContain("It counts, like a payment in USDC, when the chain has made it final and the amount that arrived at the treasury wallet is at least the amount shown.");
    expect(prepaid).toContain("let got = arrived(tx, intent.payTo ?? this.cfg.payTo, intent.asset, intent.mint ?? this.mint);");
    // at the treasury, which has other business: no more than what its sender sent it plainly
    expect(prepaid).toContain('if (intent.asset === "LAMPORT" && got > 0n) { const plainly = sentPlainly(tx, intent.payTo ?? this.cfg.payTo, intent.mint ?? this.mint); if (plainly < got) got = plainly; }');
    expect(text).toContain("The service looks for a payment while the Sentinel page is open and, by itself, about once an hour for three days after it was last asked about, so it does not depend on the page staying open.");
    expect(prepaid).toContain("SWEEP_SECONDS = 3 * 86_400");
    expect(read("sentinel", "service", "src", "main.ts")).toContain("await prepaid.sweep()");
    // what becomes of the tokens is said, as Lamport's own doing and no promise about the token
    expect(text).toContain("Lamport keeps a part of the LAMPORT it takes in its treasury, locked for the long term, and burns the rest. Lamport does that itself, after the payment; this page does not, and none of it is a promise about what the token is worth.");
    expect(text).toContain("It is not a share in anything, and what Lamport then does with the tokens is not a promise about what the token is worth.");
    // and the service does neither: it has no key, and builds nothing but the payer's own transfer
    expect(prepaid).not.toMatch(/burn/i);
  });

  it("promise only what the service does", () => {
    // cancelling at Stripe ends the plan at the end of the paid month, as the terms say
    expect(read("scripts", "stripe-sentinel-setup.mjs")).toContain("['features[subscription_cancel][mode]', 'at_period_end']");
    // a price that moves with the token is told before the bill
    expect(read("sentinel", "service", "src", "billing.ts")).toContain("this.tell(p.id, priceChangedNotice(");
    // Sentinel moves nothing unless a wallet was set up for rescue, and nothing at all without a key to rescue with
    expect(text).toContain("Sentinel can move nothing of yours unless you set a wallet up for rescue, and then only the tokens you set up, and only into the Lamport Vault you named.");
    const rescue = read("sentinel", "service", "src", "rescue.ts");
    expect(rescue).toContain('if (!this.rescuer) return no(501, "rescue is not switched on here.");');
    expect(rescue).toContain("if (!(await this.available())) return no(501, NOT_ON_CHAIN);");
    // where a rescue goes is the program's rule, not the service's: the destination is worked out from the vault in the owner's own setup
    expect(read("sentinel", "program", "README.md")).toContain("They cannot decide where");
    // each wallet is added on its own signature
    expect(text).toContain("Sentinel asks each one for a signature before it is added.");
  });

  it("state rescue's own terms in the words the page shows before a wallet can be set up, and the page will not set one up before they are agreed to", () => {
    const list = /<ul id="rescue-terms">([\s\S]*?)<\/ul>/.exec(terms)![1]!;
    const lines = [...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.trim());
    expect(lines).toEqual([...RESCUE_TERMS]);
    const page = read("sentinel", "web", "src", "app.ts");
    expect(page).toContain("RESCUE_TERMS.map(");
    expect(page).toContain("setUp.disabled = !agreed.checked");
    // what the terms say of the program is what the program's own notes say
    expect(read("sentinel", "program", "README.md")).toMatch(/not audited/i);
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
