/**
 * "This signature was mine", end to end in Chromium: the Sentinel page hands the extension a token, a wallet
 * that really signs is used through Warden, and a stand-in for the Sentinel service records what arrives.
 *
 * The Sentinel page's address is fixed in the extension, so the browser is told to find that name on this
 * machine (a resolver rule and a throwaway certificate). Nothing leaves the machine.
 *
 *   pnpm test:browser
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttps, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import type { Page } from "playwright";
import { Prompt, WARDEN, launch, serve, type Browser, type Site } from "./harness.js";
import { toBase58, signaturesInTransaction } from "../../src/intercept.js";

const SEED = new Uint8Array(32).fill(7);
const owner = Keypair.fromSeed(SEED);
const O = owner.publicKey.toBase58();
const friend = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey;
const BLOCKHASH = "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x";
const TOKEN = "T0ken-for-this-wallet_0123456789abcdefghijk";
const ARMING = "https://warden.lamportrobotics.com";

/** A payment by the owner, unsigned, as a dapp hands it to a wallet; and what the owner's signature over it is. */
function payment(lamports: number) {
  const tx = new Transaction({ feePayer: owner.publicKey, recentBlockhash: BLOCKHASH }).add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: friend, lamports }));
  const wire = Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
  tx.sign(owner);
  return { wire, signature: toBase58(signaturesInTransaction(new Uint8Array(tx.serialize()))[0]!) };
}

// The Sentinel page, as far as this test needs one: it can ask the extension, and it carries a wallet that signs
// with a real key (window.solana, the way an injected provider is found), or lies when told to.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Sentinel (test)</title><h1>Sentinel</h1><script>
window.__answers = [];
addEventListener("message", (e) => { if (e.source === window && e.data && e.data.wardenSentinel) window.__answers.push(e.data.wardenSentinel); });
window.__ask = (ask) => { window.postMessage({ sentinelAsks: ask }, location.origin); };
window.__mode = "honest";
window.__install = async (seedB64, address) => {
  const seed = Uint8Array.from(atob(seedB64), (c) => c.charCodeAt(0));
  const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  window.solana = {
    publicKey: { toBase58: () => address, toString: () => address },
    connect: async () => ({ publicKey: window.solana.publicKey }),
    signTransaction: async (tx) => {
      const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      const message = wire.slice(1 + 64 * wire[0]);
      const signature = window.__mode === "forge" ? crypto.getRandomValues(new Uint8Array(64)) : new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, message));
      const signed = wire.slice();
      signed.set(signature, 1);
      window.__reached = (window.__reached || 0) + 1;
      return { instructions: [], serialize: () => signed };
    },
  };
};
window.__sign = (wireB64) => {
  const wire = Uint8Array.from(atob(wireB64), (c) => c.charCodeAt(0));
  window.__result = "pending";
  window.solana.signTransaction({ instructions: [], serialize: () => wire }).then(() => { window.__result = "signed"; }, (e) => { window.__result = String((e && e.name) || e); });
};
</script>`;

interface Report { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }

describe("telling Sentinel which signatures were the owner's, in Chromium", () => {
  let browser: Browser, site: Site, sentinel: Server;
  const reports: Report[] = [];

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "warden-cert-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "2", "-subj", "/CN=warden.lamportrobotics.com"], { stdio: "ignore" });
    sentinel = createHttps({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
      const url = new URL(req.url ?? "/", ARMING);
      if (url.pathname.startsWith("/sentinel/api/")) {
        // as the service answers a report: any origin, these headers
        res.setHeader("access-control-allow-origin", "*");
        res.setHeader("access-control-allow-headers", "authorization, content-type");
        res.setHeader("access-control-allow-methods", "POST, OPTIONS");
        if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => { reports.push({ method: req.method ?? "", path: url.pathname, headers: req.headers, body }); res.statusCode = 202; res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); });
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(PAGE);
    });
    await new Promise<void>((r) => sentinel.listen(0, "127.0.0.1", r));
    const port = (sentinel.address() as { port: number }).port;
    site = await serve();
    browser = await launch([WARDEN], [`--host-resolver-rules=MAP warden.lamportrobotics.com 127.0.0.1:${port}`, "--ignore-certificate-errors"]);
  });
  afterAll(async () => { await browser?.close(); site?.server.close(); sentinel?.close(); });

  const sentinelPage = async (): Promise<Page> => {
    const page = await browser.ctx.newPage();
    await page.goto(`${ARMING}/sentinel/`);
    await page.evaluate(([seed, address]) => (window as any).__install(seed, address), [Buffer.from(SEED).toString("base64"), O] as const);
    return page;
  };
  const ask = async (page: Page, what: unknown, waitMs = 3000): Promise<any> => {
    const before = await page.evaluate(() => (window as any).__answers.length);
    await page.evaluate((a) => (window as any).__ask(a), what);
    try { await page.waitForFunction((n) => (window as any).__answers.length > n, before, { timeout: waitMs }); } catch { return null; }
    return page.evaluate(() => (window as any).__answers.at(-1));
  };
  /** Signs one payment through Warden, answering its prompt if it shows one. */
  const sign = async (page: Page, wire: string): Promise<string> => {
    await page.waitForTimeout(400); // Warden finds a provider put on the window within a tenth of a second
    await page.evaluate((w) => (window as any).__sign(w), wire);
    const prompt = await Prompt.on(page);
    if (await prompt.text(1500)) await prompt.click("Continue to wallet");
    await page.waitForFunction(() => (window as any).__result !== "pending", undefined, { timeout: 10_000 });
    return page.evaluate(() => (window as any).__result);
  };
  const settle = (page: Page) => page.waitForTimeout(1500);
  const options = async (): Promise<Page> => {
    const page = await browser.ctx.newPage();
    await page.goto(`chrome-extension://${browser.extensionId}/options.html`);
    await page.waitForSelector("#sentinelWallets li");
    return page;
  };

  it("answers the Sentinel page about Sentinel, and no other page", async () => {
    const page = await sentinelPage();
    expect(await ask(page, { type: "hello" })).toEqual({ ok: true, type: "hello", version: expect.stringMatching(/^\d+\.\d+\.\d+$/), reporting: false, linked: [] });
    // something that is not one of the three asks gets no answer at all
    expect(await ask(page, { type: "link", wallet: O, token: "short" }, 700)).toBeNull();
    expect(await ask(page, { type: "everything" }, 700)).toBeNull();

    // any other site: the same message, and nobody is listening
    const elsewhere = await browser.ctx.newPage();
    await elsewhere.goto(`${site.origin}/`);
    await elsewhere.evaluate(() => {
      (window as any).__answers = [];
      addEventListener("message", (e) => { if ((e.data as any)?.wardenSentinel) (window as any).__answers.push((e.data as any).wardenSentinel); });
      (window as any).__ask = (a: unknown) => window.postMessage({ sentinelAsks: a }, location.origin);
    });
    expect(await ask(elsewhere, { type: "hello" }, 1000)).toBeNull();
    expect(await ask(elsewhere, { type: "link", wallet: O, token: TOKEN }, 1000)).toBeNull();
    expect((await ask(page, { type: "hello" })).linked).toEqual([]);
    await elsewhere.close();
    await page.close();
  });

  it("sends nothing until the owner turns it on, then exactly the wallet and the signature", async () => {
    const page = await sentinelPage();
    expect(await ask(page, { type: "link", wallet: O, token: TOKEN })).toEqual({ ok: true, type: "link", wallet: O });
    expect(await ask(page, { type: "hello" })).toMatchObject({ reporting: false, linked: [O] });

    // linked, but the setting is off: the wallet signs and nothing is sent
    const first = payment(10_000_000);
    expect(await sign(page, first.wire)).toBe("signed");
    await settle(page);
    expect(reports).toEqual([]);

    // the settings page says so, and has the one switch
    const opts = await options();
    expect(await opts.locator("#sentinelWallets li").allInnerTexts()).toEqual([expect.stringContaining("linked, but reporting is off")]);
    expect(await opts.locator("#sentinelPage").getAttribute("href")).toBe(`${ARMING}/sentinel/`);
    // the plans are spelled out in the extension itself: what is free, what Pro costs and adds, and what it does not give yet
    const plans = await opts.locator("#sentinelPlans").innerText();
    expect(plans).toContain("Warden is free and stays free.");
    expect(plans).toContain("Pro is $15 a month, or $10 while a wallet in your Sentinel profile holds 250,000 $LAMPORT.");
    expect(plans).toContain("10 wallets watched instead of 3");
    expect(plans).toContain("Rescue is not available yet.");
    expect(plans).toContain("nothing is bought inside this extension");
    expect(await opts.locator("#reportSigned").isChecked()).toBe(false);
    await opts.locator("#reportSigned").check();
    await expect.poll(() => opts.locator("#reportNote").innerText()).toContain("On.");
    expect(await opts.locator("#sentinelWallets li").allInnerTexts()).toEqual([expect.stringContaining("reports its signatures")]);
    await opts.close();
    expect(await ask(page, { type: "hello" })).toMatchObject({ reporting: true, linked: [O] });

    const second = payment(20_000_000);
    expect(await sign(page, second.wire)).toBe("signed");
    await expect.poll(() => reports.length, { timeout: 5000 }).toBe(1);
    const r = reports[0]!;
    expect(r.method).toBe("POST");
    expect(r.path).toBe("/sentinel/api/v1/report");
    expect(JSON.parse(r.body)).toEqual({ wallet: O, signature: second.signature });
    expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // nothing rides along: no cookie, no page address
    expect(r.headers.cookie).toBeUndefined();
    expect(r.headers.referer).toBeUndefined();
    expect(String(r.headers.origin)).toBe(`chrome-extension://${browser.extensionId}`);
    await page.close();
  });

  it("does not report a signature the wallet's answer does not prove", async () => {
    const page = await sentinelPage();
    const before = reports.length;
    await page.evaluate(() => { (window as any).__mode = "forge"; });
    expect(await sign(page, payment(30_000_000).wire)).toBe("signed");
    await settle(page);
    expect(reports).toHaveLength(before);
    // and the honest answer is still reported afterwards
    await page.evaluate(() => { (window as any).__mode = "honest"; });
    const honest = payment(40_000_000);
    expect(await sign(page, honest.wire)).toBe("signed");
    await expect.poll(() => reports.length, { timeout: 5000 }).toBe(before + 1);
    expect(JSON.parse(reports.at(-1)!.body).signature).toBe(honest.signature);
    await page.close();
  });

  it("stops when the wallet is unlinked, from the settings page or from the Sentinel page", async () => {
    const page = await sentinelPage();
    const before = reports.length;
    const opts = await options();
    await opts.locator("#sentinelWallets button", { hasText: "Unlink" }).click();
    await expect.poll(() => opts.locator("#sentinelWallets li").allInnerTexts()).toEqual(["No wallet in this browser is set up with Sentinel."]);
    await opts.close();
    expect(await sign(page, payment(50_000_000).wire)).toBe("signed");
    await settle(page);
    expect(reports).toHaveLength(before);

    expect(await ask(page, { type: "link", wallet: O, token: TOKEN })).toMatchObject({ ok: true });
    expect(await ask(page, { type: "unlink", wallet: O })).toEqual({ ok: true, type: "unlink", wallet: O });
    expect((await ask(page, { type: "hello" })).linked).toEqual([]);
    expect(await sign(page, payment(60_000_000).wire)).toBe("signed");
    await settle(page);
    expect(reports).toHaveLength(before);
    await page.close();
  });
});
