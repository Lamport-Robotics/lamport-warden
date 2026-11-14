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
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import type { Page } from "playwright";
import { Prompt, WARDEN, launch, type Browser } from "./harness.js";
import { USDC_MINT, paymentInstruction } from "../../sentinel/service/src/prepaid.js";
import { Accounts } from "../../sentinel/service/src/accounts.js";
import { Billing, Stripe, type BillingConfig, type StripeFetch } from "../../sentinel/service/src/billing.js";
import { LAMPORT_MINT, telegramLinking } from "../../sentinel/service/src/main.js";
import { PRO_FEATURES, PRO_NOT_YET, WATCH_FEATURES, prepaidTerms, purchaseTerms, renewalTerms } from "../../sentinel/service/src/plans.js";
import type { Rpc } from "../../sentinel/service/src/rpc.js";
import { listen, type ApiDeps } from "../../sentinel/service/src/server.js";
import { LinkCodes, answer, linkedTo } from "../../sentinel/service/src/telegram.js";
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
      // a payment handed to the wallet: what it was given is kept for the test to look at, and nothing is sent anywhere
      "solana:signAndSendTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signAndSendTransaction: async ({ transaction, chain }) => { window.__sent = { bytes: Array.from(transaction), chain }; return [{ signature: new Uint8Array(64) }]; } },
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
  const testsSent: [string, string][] = [];
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
  /** What the service is made of, kept so that a test can give it a Telegram bot part-way through. */
  let apiDeps: ApiDeps;
  /** What the service says of its own watching: the page tells the owner. */
  const healthNow: { lastPassAt: number | null; blind: number; late: number; push: "on" | "down" | "off" } = { lastPassAt: 1, blind: 0, late: 0, push: "off" };
  /** Stripe telling the service something, signed as Stripe signs it. */
  const webhook = async (event: unknown) => {
    const raw = JSON.stringify(event), t = Math.floor(Date.now() / 1000);
    const res = await fetch(`http://127.0.0.1:${apiPort}/v1/stripe/webhook`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${raw}`).digest("hex")}` }, body: raw });
    return res.status;
  };

  beforeAll(async () => {
    apiDeps = { accounts, store, watcher: { ownerSigned: async () => undefined, confirmOwn: async (w, s) => { confirmed.push([w, s]); return true; } }, nonces: new NonceBook(), origin: ARMING, billing: { api: billing, webhookSecret: WHSEC }, testChannel: async (profile, id) => { testsSent.push([profile, id]); return { ok: true }; }, health: () => healthNow };
    back = await listen(apiDeps, { port: 0 });
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
    expect(await page.locator("#pace").innerText()).toBe("Each wallet is read every minute."); // what its plan promises, and nothing the service is not doing
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
    // the owner can try it before they need it
    await page.locator("#channels li").getByRole("button", { name: "Send a test" }).click();
    await expect.poll(() => page.locator("#notice").innerText()).toContain("Sent.");
    expect(testsSent).toEqual([[accounts.profileOf(W1), accounts.channelViews(accounts.profileOf(W1)!)[0]!.id]]);
    // a channel that has stopped taking messages is said on the page, with what it answered; and unsaid when it works again
    const channelId = accounts.channelViews(accounts.profileOf(W1)!)[0]!.id;
    const line = page.locator("#channels li").first().locator(".what span");
    accounts.noteDelivery(channelId, false, "it answered 404", Math.floor(Date.now() / 1000) - 7200);
    await page.reload();
    await expect.poll(() => line.innerText(), { timeout: 10_000 }).toBe("ntfy topic. The last message could not be delivered here: it answered 404, first 2 hours ago. Send a test, or remove it and add one that works.");
    expect(await page.locator("#channels li.failing").count()).toBe(1);
    accounts.noteDelivery(channelId, true, "", Math.floor(Date.now() / 1000) - 30);
    await page.reload();
    await expect.poll(() => line.innerText(), { timeout: 10_000 }).toMatch(/^ntfy topic\. Alerts are sent here\. The last message was delivered \d+ seconds ago\.$/);
    expect(await page.locator("#channels li.failing").count()).toBe(0);
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
    const unheard = { wallet: W2, signature: "", slot: 6, at: Math.floor(Date.now() / 1000) - 10, level: "urgent" as const, signals: ["delegate_replaced" as const], sentence: "Your USDC account's spending permission moved to another wallet.", rescueWorthy: true, id: undefined as string | undefined };
    store.addEvent(unheard);
    store.markUndelivered(unheard.id!); // no channel took this one: the page is the only place it is
    await page.reload();
    await expect.poll(() => page.locator("#events li").count(), { timeout: 10_000 }).toBe(2);
    const rows = page.locator("#events li");
    expect(await rows.nth(0).locator(".what b .tag").innerText()).toMatch(/^urgent$/i);
    expect(await rows.nth(0).locator(".what b").innerText()).toContain("Your USDC account's spending permission moved to another wallet.");
    expect(await rows.nth(1).locator(".what b").innerText()).toContain(hostile);
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    expect(await page.locator("#events img").count()).toBe(0);
    expect(await rows.nth(1).locator(".what > span").innerText()).toContain(short(W1));
    expect(await rows.nth(0).locator(".what > span").innerText()).toContain("not delivered: no channel took it");
    expect(await rows.nth(1).locator(".what > span").innerText()).not.toContain("not delivered");

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
    // the standing advice is on the page for an owner too; SENTINEL_SHOT_REAL=/some/file.png keeps a picture of it
    expect(await page.locator("#real h2").innerText()).toBe("When an alert is real");
    expect(await page.locator("#real ol.steps li").count()).toBe(5);
    if (process.env.SENTINEL_SHOT_REAL) await page.locator("#real").screenshot({ path: process.env.SENTINEL_SHOT_REAL });
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
    // before the button is pressed: what is charged and how often, how it ends, and what changes the price
    const terms = await page.locator("#plans ul.terms li").allInnerTexts();
    expect(terms).toEqual(purchaseTerms(1000, 1500, 1000, 250_000));
    // SENTINEL_SHOT_BUY=/some/file.png keeps a picture of the plans as someone about to pay sees them
    if (process.env.SENTINEL_SHOT_BUY) await page.locator("#plans").screenshot({ path: process.env.SENTINEL_SHOT_BUY });
    expect(terms[0]).toBe("$10 is charged to your card today, and again every month until you cancel. Stripe takes the payment; Sentinel never sees the card.");
    expect(terms[1]).toContain("Cancel any time from this page.");
    expect(terms[2]).toContain("$10 a month while they hold 250,000 $LAMPORT between them, $15 otherwise.");

    // Paying ahead in USDC or SOL is not on the page while the service does not take it
    expect(await page.locator("#plans .ahead").count()).toBe(0);
    // It does: the amount is asked of the service, shown with the address and what paying ahead means, and
    // the wallet in this browser is handed the payment the service built.
    const PAY_TO = "74A7zaiS6xyRTKjFFbVwyViQvG2zHTcX1JjmT9EkUp4A", REFERENCE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const asked: unknown[][] = [];
    let paidUntil: number | null = null;
    // the payment as the service builds one: 30 USDC from this wallet to Lamport's address, naming the quote
    const payment = new Transaction({ feePayer: new PublicKey(W1), recentBlockhash: "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x" })
      .add(paymentInstruction({ payer: new PublicKey(W1), payTo: new PublicKey(PAY_TO), asset: "USDC", units: 30_000_000n, mint: new PublicKey(USDC_MINT), reference: new PublicKey(REFERENCE) }))
      .serialize({ requireAllSignatures: false, verifySignatures: false });
    apiDeps.prepaid = {
      offer: () => ({ payTo: PAY_TO, assets: ["USDC", "SOL"], months: [1, 3, 12] }),
      quote: async (_profile, asset, months) => { asked.push(["quote", asset, months]); return { ok: true, quote: { reference: REFERENCE, payTo: PAY_TO, asset: asset as "USDC", units: "30000000", decimals: 6, mint: null, months: months as number, cents: 3000, expiresAt: Math.floor(Date.now() / 1000) + 600, url: `solana:${PAY_TO}?amount=30&reference=${REFERENCE}` } }; },
      transaction: async (_profile, reference, payer) => { asked.push(["transaction", reference, payer]); return { ok: true, transaction: Buffer.from(payment).toString("base64") }; },
      check: async (_profile, reference) => { asked.push(["check", reference]); return { ok: true, result: paidUntil ? { status: "paid", until: paidUntil } : { status: "waiting" } }; },
    };
    await page.reload();
    const ahead = page.locator("#plans .ahead");
    await expect.poll(() => ahead.count(), { timeout: 10_000 }).toBe(1);
    expect(await ahead.innerText()).toContain("Or pay ahead, with no card, in");
    await ahead.getByLabel("For how long").selectOption("3");
    await ahead.getByRole("button", { name: "Show the amount" }).click();
    await expect.poll(() => ahead.locator(".quote").innerText().catch(() => ""), { timeout: 8000 }).toContain("Send exactly 30 USDC to");
    expect(asked[0]).toEqual(["quote", "USDC", 3]);
    expect(await ahead.locator(".quote code.addr").innerText()).toBe(PAY_TO);
    expect(await ahead.locator(".quote ul.terms li").allInnerTexts()).toEqual(prepaidTerms(3000, 3));
    expect(await ahead.getByLabel("Payment request").inputValue()).toBe(`solana:${PAY_TO}?amount=30&reference=${REFERENCE}`);
    // the wallet pays: it is given exactly what the service built, for mainnet, and the page then asks the service whether it arrived
    paidUntil = Math.floor(Date.UTC(2027, 1, 13, 12) / 1000);
    await ahead.getByRole("button", { name: "Pay with TestWallet" }).click();
    // Warden is in this browser, and Sentinel's own payment gets no pass: it is read and said like any other
    // before the wallet is asked.
    const warden = await Prompt.on(page);
    const held = await warden.text(10_000);
    expect(held?.tag).toBe("Lamport Warden · Before you sign");
    expect(held?.sentence).toContain("30 USDC");
    expect(await page.evaluate(() => (window as any).__sent ?? null)).toBeNull(); // the wallet has not been asked yet
    await warden.click("Continue to wallet");
    await expect.poll(async () => (await page.evaluate(() => (window as any).__sent ?? null)) ?? `not sent; the page says: ${await page.locator("#notice").innerText().catch(() => "")}`, { timeout: 8000 }).toEqual({ bytes: Array.from(payment), chain: "solana:mainnet" });
    expect(asked.find((a) => a[0] === "transaction")).toEqual(["transaction", REFERENCE, W1]);
    await expect.poll(() => page.locator("#notice").innerText(), { timeout: 10_000 }).toBe("Paid. Your plan runs until 13 February 2027.");
    expect(asked.some((a) => a[0] === "check" && a[1] === REFERENCE)).toBe(true);
    // (the stand-in changed nothing: the story goes on with the card)
    delete apiDeps.prepaid;
    await page.reload();
    await expect.poll(() => start.isVisible(), { timeout: 10_000 }).toBe(true);
    expect(await page.locator("#plans .ahead").count()).toBe(0);
    await start.click();
    await page.waitForURL(/^https:\/\/checkout\.stripe\.com\//, { timeout: 10_000 });
    const profile = accounts.profileOf(W1)!;
    expect(stripeCalls.at(-1)).toMatchObject({ path: "/checkout/sessions", params: { mode: "subscription", "line_items[0][price]": "price_holder", client_reference_id: profile } });

    // back from the checkout page, before Stripe has said anything: still Watch. The service is being told of
    // transactions as they happen, and that is not something the free plan has: the page does not say it has.
    Object.assign(healthNow, { push: "on" });
    await page.goto(`${ARMING}/sentinel/?plan=started`);
    await expect.poll(() => page.locator("#notice").innerText(), { timeout: 10_000 }).toContain("Stripe is confirming the payment");
    expect(await page.locator("#pace").innerText()).toBe("Each wallet is read every minute.");
    expect(page.url()).toBe(`${ARMING}/sentinel/`); // the marker is taken out of the address
    await expect.poll(() => page.locator("#plans .plan.mine h3").innerText(), { timeout: 10_000 }).toBe("Watch");
    expect(accounts.profile(profile)!.tier).toBe("watch");

    // Stripe says so, signed: now it is Pro
    subscriptions.set("sub_page", { id: "sub_page", customer: "cus_page", status: "active", metadata: { profile }, items: { data: [{ id: "si_page", price: { id: "price_holder" } }] } });
    expect(await webhook({ type: "checkout.session.completed", data: { object: { mode: "subscription", subscription: "sub_page", client_reference_id: profile } } })).toBe(200);
    // and the service, meanwhile, is running behind
    Object.assign(healthNow, { late: 2 });
    await page.reload();
    await expect.poll(() => page.locator("#plans .plan.mine h3").innerText(), { timeout: 10_000 }).toBe("Pro");
    expect(await page.locator("#walletLimit").innerText()).toBe("2 of 10 wallets on this plan.");
    expect(await page.locator("#pace").innerText()).toBe("Each wallet is read every 20 seconds, and at once when the network reports a transaction in it. Sentinel is behind right now: some wallets are being read later than that.");
    expect(await page.locator("#plans").innerText()).toContain(renewalTerms(1000, 1500, 1000, 250_000));
    expect(renewalTerms(1000, 1500, 1000, 250_000)).toContain("It renews every month at $10 until you cancel");
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

    // Telegram is not offered while the service has no bot to send through
    expect(await page.locator("#addTelegram").isVisible()).toBe(false);
    // it gets one: the page offers it, and says a chat is one of the kinds this plan takes
    const codes = new LinkCodes();
    apiDeps.telegram = { username: "WardenSentinelTestBot", codes };
    await page.reload();
    await expect.poll(() => page.locator("#channelLimit").innerText(), { timeout: 10_000 }).toBe("Up to 5 channels on this plan: ntfy topics, Telegram chats, Discord webhooks and Slack webhooks.");
    expect(await page.locator("#telegramHelp").innerText()).toContain("The bot only delivers alerts: it never sends a link, and never asks you to sign anything or to tell it anything.");
    await page.getByRole("button", { name: "Connect Telegram" }).click();
    const link = page.locator("#telegramLink a");
    await expect.poll(() => link.getAttribute("href"), { timeout: 8000 }).toMatch(/^https:\/\/t\.me\/WardenSentinelTestBot\?start=[A-Za-z0-9_-]{24}$/);
    expect(await link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(await page.locator("#telegramLink").innerText()).toContain("The link works once, for 15 minutes.");
    // nothing is a channel yet. Then the chat presses Start, which sends the bot the code from the link
    expect(accounts.channelsFor(W1).map((c) => c.kind)).toEqual(["ntfy", "discord"]);
    const code = new URL((await link.getAttribute("href"))!).searchParams.get("start")!;
    expect(await answer({ chat: "5550001234", text: `/start ${code}` }, { codes, ...telegramLinking(accounts, async () => undefined) }, Math.floor(Date.now() / 1000))).toBe(linkedTo(accounts.walletsOf(accounts.profileOf(W1)!), false));
    // the page finds it by asking, and says so
    const chat = page.locator("#channels li").filter({ hasText: "Telegram chat …1234" });
    await expect.poll(() => chat.locator(".what span").innerText().catch(() => ""), { timeout: 12_000 }).toBe("Telegram chat. Alerts are sent here.");
    await expect.poll(() => page.locator("#notice").innerText(), { timeout: 8000 }).toBe("Connected. Alerts will be sent to that chat.");
    expect(await page.locator("#telegramLink").isVisible()).toBe(false);
    expect(await page.content()).not.toContain("5550001234"); // the chat's number is not on the page
    // taken out again, and the bot with it, so the rest of this goes as it did
    for (const c of accounts.telegramChannels("5550001234")) accounts.removeChannel(c.profile, c.id);
    delete apiDeps.telegram;
    await page.reload();
    await expect.poll(() => page.locator("#channelLimit").innerText(), { timeout: 10_000 }).toBe("Up to 5 channels on this plan: ntfy topics, Discord webhooks and Slack webhooks.");

    // the card and cancelling are on Stripe's own page
    await page.getByRole("button", { name: "Change card or cancel" }).click();
    await page.waitForURL(/^https:\/\/billing\.stripe\.com\//, { timeout: 10_000 });
    expect(stripeCalls.at(-1)).toMatchObject({ path: "/billing_portal/sessions", params: { customer: "cus_page" } });

    // cancelled there: back on the page the plan is said to be ending on its last day, not renewing
    const lastDay = Math.floor(Date.UTC(2026, 11, 13, 12) / 1000);
    Object.assign(subscriptions.get("sub_page"), { cancel_at_period_end: true, cancel_at: lastDay });
    expect(await webhook({ type: "customer.subscription.updated", data: { object: { id: "sub_page" } } })).toBe(200);
    await page.goto(`${ARMING}/sentinel/`);
    await expect.poll(() => page.locator("#plans").innerText(), { timeout: 10_000 }).toContain("Cancelled. The plan runs until 13 December 2026 and does not renew: nothing more is charged.");
    expect(await page.locator("#plans").innerText()).not.toContain("It renews every month");
    expect(await page.getByRole("button", { name: "Keep the plan, or change card" }).isVisible()).toBe(true);
    expect(await page.locator("#plans .plan.mine h3").innerText()).toBe("Pro"); // still Pro until then

    // its last day comes: back to Watch, with the Discord channel kept and out of use
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
