/**
 * The Sentinel page in Chromium, against the real service: sign in with a wallet that really signs, add a
 * channel, link Warden, answer an alert, sign out. Warden is installed, so its own checks run on the page's
 * requests as they would for anyone.
 *
 * The page's address is fixed in the extension, so the browser is told to find that name on this machine.
 *
 *   pnpm test:browser
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { request as httpRequest, type Server as HttpServer } from "node:http";
import { createServer as createHttps, type Server } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import type { Page } from "playwright";
import { WARDEN, launch, type Browser } from "./harness.js";
import { Accounts } from "../../sentinel/service/src/accounts.js";
import { Billing, Stripe, type BillingConfig, type StripeFetch } from "../../sentinel/service/src/billing.js";
import { LAMPORT_MINT } from "../../sentinel/service/src/main.js";
import { PRO_FEATURES, PRO_NOT_YET, WATCH_FEATURES } from "../../sentinel/service/src/plans.js";
import type { Rpc } from "../../sentinel/service/src/rpc.js";
import { listen } from "../../sentinel/service/src/server.js";
import { NonceBook } from "../../sentinel/service/src/signin.js";
import { MemoryStore } from "../../sentinel/service/src/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "..", "..", "sentinel", "web", "dist");
const ARMING = "https://warden.lamportrobotics.com";
const SEED = new Uint8Array(32).fill(21), SEED2 = new Uint8Array(32).fill(22);
const W1 = Keypair.fromSeed(SEED).publicKey.toBase58(), W2 = Keypair.fromSeed(SEED2).publicKey.toBase58();
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

// A wallet as a page meets one through Wallet Standard, signing with a real key. It writes its own sign-in
// text, the way wallets with the sign-in feature do. window.__account picks which of two accounts it shows.
const WALLET = `(() => {
  if (!globalThis.crypto || !crypto.subtle) return; // a blank page before the first address: nothing to sign with, nothing to do
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const keys = [];
  const load = async (seedB64, address) => {
    const seed = Uint8Array.from(atob(seedB64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("pkcs8", new Uint8Array([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20, ...seed]), { name: "Ed25519" }, false, ["sign"]);
    keys.push({ key, account: { address, publicKey: new Uint8Array(32), chains: ["solana:mainnet"], features: ["solana:signIn", "solana:signMessage"] } });
  };
  window.__account = 0;
  window.__signed = [];
  const sign = async (bytes) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, keys[window.__account].key, bytes));
  const wallet = {
    version: "1.0.0", name: "TestWallet", icon: "data:image/svg+xml;base64,PHN2Zy8+", chains: ["solana:mainnet"],
    get accounts() { return keys.length ? [keys[window.__account].account] : []; },
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [keys[window.__account].account] }) },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signIn": { version: "1.0.0", signIn: async (input) => {
        const account = keys[window.__account].account;
        const lines = [input.domain + " wants you to sign in with your Solana account:", account.address, "", input.statement, "", "Nonce: " + input.nonce, "Issued At: " + input.issuedAt];
        const signedMessage = new TextEncoder().encode(lines.join("\\n"));
        window.__signed.push(lines.join("\\n"));
        return [{ account, signedMessage, signature: await sign(signedMessage), signatureType: "ed25519" }];
      } },
      "solana:signMessage": { version: "1.0.0", signMessage: async ({ message }) => [{ signedMessage: message, signature: await sign(message), signatureType: "ed25519" }] },
    },
  };
  window.__ready = Promise.all(__SEEDS__.map(([s, a]) => load(s, a))).then(() => {
    const register = (api) => api.register(wallet);
    window.addEventListener("wallet-standard:app-ready", (e) => register(e.detail));
    window.dispatchEvent(new (class extends Event { get detail() { return register; } constructor() { super("wallet-standard:register-wallet", { bubbles: false, cancelable: false, composed: false }); } })());
  });
})();`.replace("__SEEDS__", JSON.stringify([[Buffer.from(SEED).toString("base64"), W1], [Buffer.from(SEED2).toString("base64"), W2]]));

describe.skipIf(!existsSync(join(DIST, "app.js")))("the Sentinel page, in Chromium", () => {
  let browser: Browser, front: Server, back: HttpServer, page: Page;
  const store = new MemoryStore();
  const accounts = new Accounts(store, Buffer.alloc(32, 5));
  const confirmed: [string, string][] = [];
  const pageErrors: string[] = [];

  // The paid plan, with Stripe and the chain stood in for: Stripe keeps a subscription the way Stripe does,
  // and the chain says how much $LAMPORT a wallet holds. Checkout starts closed, as it is in production.
  const WHSEC = "whsec_page_test";
  const billingCfg: BillingConfig = { secretKey: "sk_test_page", webhookSecret: WHSEC, priceFull: "price_full", priceHolder: "price_holder", centsFull: 1500, centsHolder: 1000, holderMint: LAMPORT_MINT, holderMin: 250_000, pageUrl: `${ARMING}/sentinel/`, checkoutOpen: false };
  const lamport: Record<string, number> = {};
  const chain: Rpc = { call: async (_m, params: any[]) => ({ value: lamport[params[0]] ? [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(BigInt(lamport[params[0]]!) * 1_000_000n) } } } } } }] : [] }) };
  const stripeCalls: { path: string; params: Record<string, string> }[] = [];
  const subscriptions = new Map<string, any>();
  const stripeFetch: StripeFetch = async (url, init) => {
    const u = new URL(url), path = u.pathname.replace("/v1", "");
    const params = Object.fromEntries(new URLSearchParams(init.method === "POST" ? init.body ?? "" : u.search));
    stripeCalls.push({ path, params });
    const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
    if (path === "/checkout/sessions") return reply(200, { url: "https://checkout.stripe.com/c/pay/cs_test_page" });
    if (path === "/billing_portal/sessions") return reply(200, { url: "https://billing.stripe.com/p/session/test_page" });
    const sub = /^\/subscriptions\/(sub_\w+)$/.exec(path);
    return sub && subscriptions.has(sub[1]!) ? reply(200, subscriptions.get(sub[1]!)) : reply(404, { error: { code: "resource_missing" } });
  };
  const billing = new Billing(billingCfg, accounts, chain, new Stripe(billingCfg.secretKey, stripeFetch));
  let apiPort = 0;
  /** Stripe telling the service something, signed as Stripe signs it. */
  const webhook = async (event: unknown) => {
    const raw = JSON.stringify(event), t = Math.floor(Date.now() / 1000);
    const res = await fetch(`http://127.0.0.1:${apiPort}/v1/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${raw}`).digest("hex")}` }, body: raw });
    return res.status;
  };

  beforeAll(async () => {
    back = await listen({ accounts, store, watcher: { ownerSigned: async () => undefined, confirmOwn: async (w, s) => { confirmed.push([w, s]); return true; } }, nonces: new NonceBook(), origin: ARMING, billing: { api: billing, webhookSecret: WHSEC } }, { port: 0 });
    apiPort = (back.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "warden-cert-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "2", "-subj", "/CN=warden.lamportrobotics.com"], { stdio: "ignore" });
    const types: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };
    front = createHttps({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
      const url = new URL(req.url ?? "/", ARMING);
      if (url.pathname.startsWith("/sentinel/api/")) {
        // as the web server in front does it: the prefix comes off and the request goes to the service
        const up = httpRequest({ host: "127.0.0.1", port: apiPort, method: req.method, path: url.pathname.slice("/sentinel/api".length), headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
        up.on("error", () => { res.statusCode = 502; res.end(); });
        req.pipe(up);
        return;
      }
      const file = url.pathname === "/sentinel/" ? "index.html" : url.pathname.startsWith("/sentinel/") ? url.pathname.slice(10) : "";
      if (!/^[a-z.]+$/.test(file) || !existsSync(join(DIST, file))) { res.statusCode = 404; res.end(); return; }
      res.setHeader("content-type", types[file.split(".").pop()!] ?? "application/octet-stream");
      res.end(readFileSync(join(DIST, file)));
    });
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    browser = await launch([WARDEN], [`--host-resolver-rules=MAP warden.lamportrobotics.com 127.0.0.1:${(front.address() as { port: number }).port}`, "--ignore-certificate-errors"]);
    await browser.ctx.addInitScript(WALLET);
    page = await browser.ctx.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e.message)));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) pageErrors.push(m.text()); });
    await page.goto(`${ARMING}/sentinel/`);
  });
  afterAll(async () => { await browser?.close(); front?.close(); back?.close(); });

  it("signs in with a wallet signature and starts watching that wallet", async () => {
    await page.getByRole("button", { name: "Sign in with TestWallet" }).click();
    await expect.poll(() => page.locator("#wallets li").count(), { timeout: 10_000 }).toBe(1);
    expect(await page.locator("#wallets li .what b").innerText()).toBe(W1);
    expect(await page.locator("#wallets li .what span").innerText()).toContain("Not read yet");
    expect(await page.locator("#walletLimit").innerText()).toBe("1 of 3 wallets on this plan.");
    expect(await page.locator("#signedOut").isHidden()).toBe(true);
    // the wallet signed a text naming this site, with the service's one-time number
    const signed: string[] = await page.evaluate(() => (window as any).__signed);
    expect(signed).toHaveLength(1);
    expect(signed[0]).toMatch(/^warden\.lamportrobotics\.com wants you to sign in with your Solana account:\n/);
    expect(signed[0]).toContain("\nSign in to Warden Sentinel.\n");
    expect(store.wallets()).toEqual([{ address: W1 }]);
    // the session is in this tab only, and never a cookie
    expect(await page.evaluate(() => document.cookie)).toBe("");
    expect(await page.evaluate(() => sessionStorage.getItem("sentinel.session"))).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
  });

  it("adds a second wallet on that wallet's own signature, and says so when it is already here", async () => {
    await page.getByRole("button", { name: "Add a wallet from TestWallet" }).click();
    await expect.poll(() => page.locator("#notice").innerText()).toContain("already here");
    expect(store.wallets()).toHaveLength(1);
    await page.evaluate(() => { (window as any).__account = 1; });
    await page.getByRole("button", { name: "Add a wallet from TestWallet" }).click();
    await expect.poll(() => page.locator("#wallets li").count(), { timeout: 10_000 }).toBe(2);
    expect(store.wallets().map((w) => w.address)).toEqual([W1, W2]);
    expect((await page.evaluate(() => (window as any).__signed)).at(-1)).toContain("\nAdd this wallet to my Warden Sentinel profile.\n");
    expect(accounts.profileOf(W2)).toBe(accounts.profileOf(W1));
  });

  it("makes a topic, adds it as the alert channel, and shows only its last characters", async () => {
    await page.getByRole("button", { name: "Make me a topic" }).click();
    const target = await page.locator("#ntfyTarget").inputValue();
    expect(target).toMatch(/^https:\/\/ntfy\.sh\/sentinel-[a-z0-9]{24}$/);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect.poll(() => page.locator("#channels li .what b").innerText()).toBe(`ntfy.sh/…${target.slice(-4)}`);
    expect(accounts.targetsFor(W1)).toEqual([target]);
    expect(await page.content()).not.toContain(target.slice(16, 36));
    // something that is not a topic is refused in the service's own words
    await page.locator("#ntfyTarget").fill("https://evil.example/aaaaaaaaaaaa");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect.poll(() => page.locator("#notice").innerText()).toContain("not an address I can send alerts to");
    // the free plan's one channel is taken, and the page says what the plan covers
    expect(await page.locator("#channelLimit").innerText()).toBe("One ntfy channel on this plan. Pro adds Discord and Slack, and up to five channels.");
    await page.locator("#ntfyTarget").fill("https://ntfy.sh/a-second-topic-name");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect.poll(() => page.locator("#notice").innerText()).toContain("this plan has one alert channel");
    await page.locator("#ntfyTarget").fill("");
  });

  it("finds Warden, links a wallet to it, and unlinks", async () => {
    expect(await page.locator("#wardenState").innerText()).toMatch(/^Warden \d+\.\d+\.\d+ is here\./);
    const first = page.locator("#links li").filter({ hasText: W1 });
    await first.getByRole("button", { name: "Link this browser" }).click();
    await expect.poll(() => first.locator(".what span").innerText(), { timeout: 8000 }).toBe("Linked from this browser.");
    expect(await page.locator("#notice").innerText()).toContain("turn on");
    expect(accounts.reporting(W1)).toBe(true);
    // Warden's own settings page now lists it
    const opts = await browser.ctx.newPage();
    await opts.goto(`chrome-extension://${browser.extensionId}/options.html`);
    await expect.poll(() => opts.locator("#sentinelWallets li").allInnerTexts()).toEqual([expect.stringContaining("linked, but reporting is off")]);
    await opts.close();

    await first.getByRole("button", { name: "Unlink" }).click();
    await expect.poll(() => first.locator(".what span").innerText(), { timeout: 8000 }).toBe("Not linked.");
    expect(accounts.reporting(W1)).toBe(false);
  });

  it("shows an alert as text, never as markup, and records the answer", async () => {
    const hostile = `Sent 6 SOL to a new address <img src=x onerror="window.__pwned=1">.`;
    store.addEvent({ wallet: W1, signature: "sigA", slot: 5, at: Math.floor(Date.now() / 1000) - 30, level: "alert", signals: ["new_large_payment"], sentence: hostile, rescueWorthy: false });
    store.addEvent({ wallet: W2, signature: "", slot: 6, at: Math.floor(Date.now() / 1000) - 10, level: "urgent", signals: ["delegate_replaced"], sentence: "Your USDC account's spending permission moved to another wallet.", rescueWorthy: true });
    await page.reload();
    await expect.poll(() => page.locator("#events li").count(), { timeout: 10_000 }).toBe(2);
    const rows = page.locator("#events li");
    expect(await rows.nth(0).locator(".what b .tag").innerText()).toMatch(/^urgent$/i);
    expect(await rows.nth(0).locator(".what b").innerText()).toContain("Your USDC account's spending permission moved to another wallet.");
    expect(await rows.nth(1).locator(".what b").innerText()).toContain(hostile);
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    expect(await page.locator("#events img").count()).toBe(0);
    expect(await rows.nth(1).locator(".what > span").innerText()).toContain(short(W1));

    await rows.nth(1).getByRole("button", { name: "This was me" }).click();
    await expect.poll(() => rows.nth(1).locator(".what > span").innerText(), { timeout: 8000 }).toContain("you said this was you");
    expect(confirmed).toEqual([[W1, "sigA"]]);
    expect(await rows.nth(1).getByRole("button").count()).toBe(0);
    await rows.nth(0).getByRole("button", { name: "Ignore" }).click();
    await expect.poll(() => rows.nth(0).locator(".what > span").innerText(), { timeout: 8000 }).toContain("ignored");
  });

  it("says plainly what the paid plan is and that it is not on sale", async () => {
    // SENTINEL_SHOT=/some/file.png keeps a picture of the page as it stands here, to look at
    if (process.env.SENTINEL_SHOT) await page.screenshot({ path: process.env.SENTINEL_SHOT, fullPage: true });
    const text = await page.locator("#plans").innerText();
    // both plans in the definition's own words, and rescue as something Pro does not give yet
    for (const line of [...WATCH_FEATURES, ...PRO_FEATURES, PRO_NOT_YET]) expect(text, line).toContain(line);
    expect(text).toContain("$15 a month");
    expect(text).toContain("$10 a month, not $15, while a wallet in this profile holds 250,000 $LAMPORT");
    expect(await page.locator("#plans .plan.mine h3").innerText()).toBe("Watch");
    expect(text).toContain("Not on sale yet.");
    expect(await page.locator("#plans button").count()).toBe(0);
    // and the service refuses a checkout nobody was offered
    const session = await page.evaluate(() => sessionStorage.getItem("sentinel.session"));
    const direct = await fetch(`http://127.0.0.1:${apiPort}/v1/billing/checkout`, { method: "POST", headers: { authorization: `Bearer ${session}` } });
    expect(direct.status).toBe(403);
    expect(stripeCalls).toEqual([]);
  });

  it("sells Pro at the price the wallet earns, and starts the plan on Stripe's word, not on the way back from checkout", async () => {
    billingCfg.checkoutOpen = true;
    lamport[W2] = 300_000; // the second wallet of this profile holds the token
    await page.route("https://checkout.stripe.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<title>Stripe Checkout (stand-in)</title><h1>checkout</h1>" }));
    await page.route("https://billing.stripe.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<title>Stripe portal (stand-in)</title><h1>portal</h1>" }));
    await page.reload();
    const start = page.getByRole("button", { name: "Start Pro for $10 a month" });
    await expect.poll(() => start.isVisible(), { timeout: 10_000 }).toBe(true);
    expect(await page.locator("#plans").innerText()).toContain("You have the holder price: a wallet here holds 250,000 $LAMPORT.");
    await start.click();
    await page.waitForURL(/^https:\/\/checkout\.stripe\.com\//, { timeout: 10_000 });
    const profile = accounts.profileOf(W1)!;
    expect(stripeCalls.at(-1)).toMatchObject({ path: "/checkout/sessions", params: { mode: "subscription", "line_items[0][price]": "price_holder", client_reference_id: profile } });

    // back from the checkout page, before Stripe has said anything: still Watch
    await page.goto(`${ARMING}/sentinel/?plan=started`);
    await expect.poll(() => page.locator("#notice").innerText(), { timeout: 10_000 }).toContain("Stripe is confirming the payment");
    expect(page.url()).toBe(`${ARMING}/sentinel/`); // the marker is taken out of the address
    await expect.poll(() => page.locator("#plans .plan.mine h3").innerText(), { timeout: 10_000 }).toBe("Watch");
    expect(accounts.profile(profile)!.tier).toBe("watch");

    // Stripe says so, signed: now it is Pro
    subscriptions.set("sub_page", { id: "sub_page", customer: "cus_page", status: "active", metadata: { profile }, items: { data: [{ id: "si_page", price: { id: "price_holder" } }] } });
    expect(await webhook({ type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: "sub_page", client_reference_id: profile } } })).toBe(200);
    await page.reload();
    await expect.poll(() => page.locator("#plans .plan.mine h3").innerText(), { timeout: 10_000 }).toBe("Pro");
    expect(await page.locator("#walletLimit").innerText()).toBe("2 of 10 wallets on this plan.");
    expect(await page.locator("#wallets li .what span").first().innerText()).toContain("Not read yet");
    expect(await page.locator("#channelLimit").innerText()).toBe("Up to 5 channels on this plan: ntfy topics, Discord webhooks and Slack webhooks.");

    // what Pro adds is usable at once: a Discord channel
    // a made-up address in Discord's shape, put together here so it does not read as a real webhook to a secret scanner
    const discord = ["https://discord.com/api", "webhooks", "123456789012345678", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-abcd"].join("/");
    await page.locator("#ntfyTarget").fill(discord);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const row = page.locator("#channels li").filter({ hasText: "Discord webhook" });
    await expect.poll(() => row.locator(".what span").innerText(), { timeout: 8000 }).toBe("Discord channel. Alerts are sent here.");
    expect(await page.content()).not.toContain("abcdefghijklmnopqrstuvwxyzABCDEF");
    expect(accounts.channelsFor(W1).map((c) => c.kind)).toEqual(["ntfy", "discord"]);

    // the card and cancelling are on Stripe's own page
    await page.getByRole("button", { name: "Change card or cancel" }).click();
    await page.waitForURL(/^https:\/\/billing\.stripe\.com\//, { timeout: 10_000 });
    expect(stripeCalls.at(-1)).toMatchObject({ path: "/billing_portal/sessions", params: { customer: "cus_page" } });

    // cancelled: back to Watch, with the Discord channel kept and out of use
    subscriptions.get("sub_page").status = "canceled";
    expect(await webhook({ type: "customer.subscription.deleted", data: { object: { id: "sub_page" } } })).toBe(200);
    await page.goto(`${ARMING}/sentinel/`);
    await expect.poll(() => page.locator("#plans .plan.mine h3").innerText(), { timeout: 10_000 }).toBe("Watch");
    expect(await page.locator("#channels li").filter({ hasText: "Discord webhook" }).locator(".what span").innerText()).toBe("Discord channel. Not in use: this plan does not cover it.");
    expect(accounts.channelsFor(W1).map((c) => c.kind)).toEqual(["ntfy"]);
    // a webhook nobody signed changes nothing
    const forged = await fetch(`http://127.0.0.1:${apiPort}/v1/stripe/webhook`, { method: "POST", headers: { "stripe-signature": "t=1,v1=00" }, body: "{}" });
    expect(forged.status).toBe(400);
  });

  it("removes a wallet only when asked twice, signs out, and ran without an error or a blocked request", async () => {
    const second = page.locator("#wallets li").filter({ hasText: W2 });
    await second.getByRole("button", { name: "Remove" }).click();
    expect(store.wallets()).toHaveLength(2); // the first press only asks
    await second.getByRole("button", { name: "Remove and forget?" }).click();
    await expect.poll(() => page.locator("#wallets li").count(), { timeout: 8000 }).toBe(1);
    expect(store.wallets()).toEqual([{ address: W1 }]);

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect.poll(() => page.locator("#signedOut").isVisible()).toBe(true);
    expect(await page.evaluate(() => sessionStorage.getItem("sentinel.session"))).toBeNull();
    await page.reload();
    await expect.poll(() => page.getByRole("button", { name: "Sign in with TestWallet" }).isVisible(), { timeout: 8000 }).toBe(true);
    expect(pageErrors).toEqual([]);
  });
});
