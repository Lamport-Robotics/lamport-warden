/**
 * The practice page (site/try) in Chromium, at the site's real address, twice: with the built extension, where
 * every request has to end the way the page says it will, and with no extension, where the page has to say
 * plainly that nothing stood in front of the wallet.
 *
 * The page is served with its own Content-Security-Policy, which allows no inline style and no script but
 * its own: Warden's prompt has to appear on it all the same.
 *
 * TRY_LIVE=1 runs the same steps against the page as it is deployed, instead of the build in this folder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttps, type Server } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { Prompt, WARDEN, launch, type Browser } from "./harness.js";
import { SCENARIOS } from "../../site/try/src/scenarios.js";

const here = dirname(fileURLToPath(import.meta.url));
const TRY = join(here, "..", "..", "site", "try", "dist");
const SENTINEL = join(here, "..", "..", "sentinel", "web", "dist");
const SITE = "https://warden.lamportrobotics.com";

/** The site as the web server serves it: /try/ from the practice page's build, the stylesheet it borrows from the Sentinel page's. */
async function serveSite(): Promise<Server> {
  const dir = mkdtempSync(join(tmpdir(), "warden-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "2", "-subj", "/CN=warden.lamportrobotics.com"], { stdio: "ignore" });
  const types: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };
  const server = createHttps({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
    const path = new URL(req.url ?? "/", SITE).pathname;
    const file = path === "/try/" ? join(TRY, "index.html") : /^\/try\/[a-z.]+$/.test(path) ? join(TRY, path.slice(5)) : path === "/sentinel/sentinel.css" ? join(SENTINEL, "sentinel.css") : "";
    if (!file || !existsSync(file)) { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-type", types[file.split(".").pop()!] ?? "application/octet-stream");
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

const LIVE = process.env.TRY_LIVE === "1";
const mapTo = (server: Server | null) => server === null ? [] : [`--host-resolver-rules=MAP warden.lamportrobotics.com 127.0.0.1:${(server.address() as { port: number }).port}`, "--ignore-certificate-errors"];
const row = (page: Page, id: string) => page.locator(`#tries li[data-id="${id}"]`);
const resultOf = async (page: Page, id: string) => { const r = row(page, id).locator(".result"); await expect.poll(async () => (await r.getAttribute("class")) ?? "", { timeout: 10_000 }).toMatch(/^result (good|bad|plain)$/); return { cls: (await r.getAttribute("class"))!, text: await r.innerText() }; };

describe.skipIf(!existsSync(join(TRY, "try.js")))("the practice page, with Warden in the browser", () => {
  let site: Server | null, browser: Browser, page: Page, prompt: Prompt;
  const errors: string[] = [];

  beforeAll(async () => {
    site = LIVE ? null : await serveSite();
    browser = await launch([WARDEN], mapTo(site));
    page = await browser.ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e.message)));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(`${SITE}/try/`);
    prompt = await Prompt.on(page);
  });
  afterAll(async () => { await browser?.close(); site?.close(); });

  /** Presses a request's button and waits until its line says something is under way. */
  const press = async (id: string) => { await row(page, id).getByRole("button", { name: "Try it" }).click(); };

  it("finds Warden, shows the practice wallet, and offers every request with what Warden will do", async () => {
    await expect.poll(() => page.locator("#warden").innerText(), { timeout: 10_000 }).toMatch(/^Warden \d+\.\d+\.\d+ is in this browser and is standing in front of the practice wallet\.$/);
    expect(await page.locator("#address").innerText()).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(await page.locator("#tries li").count()).toBe(SCENARIOS.length);
    for (const s of SCENARIOS) {
      expect(await row(page, s.id).locator("h3").innerText()).toBe(s.title);
      expect(await row(page, s.id).locator(".will").innerText()).toMatch(s.outcome === "stops" ? /^Warden: Stops it\./ : s.outcome === "asks" ? /^Warden: Asks first\./ : /^Warden: Says nothing\./);
      // what depends on a first payment waits for one
      expect(await row(page, s.id).getByRole("button").isDisabled(), s.id).toBe(!!s.after);
    }
  });

  it("a first payment is held with one sentence; cancelled, the wallet is never asked", async () => {
    await press("pay-new");
    const shown = await prompt.text();
    expect(shown?.tag).toBe("Lamport Warden · Before you sign");
    expect(shown?.sentence).toMatch(/Sends 0\.5 SOL to .*You've never paid /);
    expect(shown?.buttons).toEqual(["Cancel", "Continue to wallet"]);
    await prompt.click("Cancel");
    expect(await resultOf(page, "pay-new")).toEqual({ cls: "result good", text: "You cancelled, so the practice wallet was never asked." });
    expect(await row(page, "pay-again").getByRole("button").isDisabled()).toBe(true); // nothing was paid
  });

  it("continued, the wallet signs, and the same payment again goes through without a word", async () => {
    await press("pay-new");
    expect((await prompt.text())?.sentence).toMatch(/Sends 0\.5 SOL/);
    await prompt.click("Continue to wallet");
    expect((await resultOf(page, "pay-new")).text).toBe("You read Warden's sentence and continued, so the practice wallet was asked, and it signed. Nothing was sent.");
    await expect.poll(() => row(page, "pay-again").getByRole("button").isDisabled(), { timeout: 5000 }).toBe(false);

    await press("pay-again");
    expect(await resultOf(page, "pay-again")).toEqual({ cls: "result good", text: "Warden read it, had nothing to say, and passed it on. The practice wallet signed. Nothing was sent." });
    expect(await prompt.shown()).toBe(false);
  });

  it("stops the look-alike, the unlimited approval, the handover, the sign-in for another site and the disguised payment", async () => {
    const said: Record<string, RegExp> = {
      // twice by now: the first payment and the one that went through without a word
      lookalike: /looks like an address you have paid 2 times, but it is a different address\. This is address poisoning\./,
      approve: /unlimited permission to spend your tokens/,
      handover: /hands over control of your token account/,
      "signin-relay": /would sign you in to app\.example-exchange\.com, a different site/,
      "tx-as-message": /I only pass on what you can read/,
    };
    for (const [id, sentence] of Object.entries(said)) {
      await press(id);
      const shown = await prompt.text();
      expect(shown?.sentence, id).toMatch(sentence);
      expect(shown?.buttons, id).not.toContain("Continue to wallet"); // there is no way through
      // TRY_SHOT_PROMPT=/some/file.png keeps a picture of the page with Warden's prompt on it
      if (id === "approve" && process.env.TRY_SHOT_PROMPT) await page.screenshot({ path: process.env.TRY_SHOT_PROMPT });
      await prompt.click(shown!.buttons[0]!);
      expect(await resultOf(page, id), id).toEqual({ cls: "result good", text: "Stopped. The practice wallet was never asked." });
      await expect.poll(() => prompt.shown(), { timeout: 5000 }).toBe(false);
    }
  });

  it("shows an ordinary message before the wallet does, and nothing went wrong on the page", async () => {
    await press("plain-message");
    const shown = await prompt.text();
    expect(shown?.sentence).toContain("asks you to sign a message. It says: \"I am the owner of this wallet. Signed for the Warden practice page.\"");
    await prompt.click("Continue to wallet");
    expect((await resultOf(page, "plain-message")).cls).toBe("result good");
    // every request ended the way the page said it would, and the page's own policy was never broken
    expect(await page.locator("#tries .result.bad").count()).toBe(0);
    expect(errors).toEqual([]);
    // TRY_SHOT=/some/file.png keeps a picture of the whole page after every request was tried
    if (process.env.TRY_SHOT) await page.screenshot({ path: process.env.TRY_SHOT, fullPage: true });
  });
});

describe.skipIf(!existsSync(join(TRY, "try.js")))("the practice page, with no Warden", () => {
  let site: Server | null, browser: Browser, page: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    site = LIVE ? null : await serveSite();
    // the same browser with a different extension in it: the stand-in wallets of the other tests, which are not Warden
    const { chromium } = await import("playwright");
    const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "warden-plain-")), { channel: process.env.CHROMIUM_PATH ? undefined : "chromium", executablePath: process.env.CHROMIUM_PATH || undefined, headless: true, args: mapTo(site), viewport: { width: 1000, height: 760 } });
    browser = { ctx, extensionId: "", close: () => ctx.close() };
    page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e.message)));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(`${SITE}/try/`);
  });
  afterAll(async () => { await browser?.close(); site?.close(); });

  it("says Warden is not there, and that the wallet signed what Warden would have stopped", async () => {
    await expect.poll(() => page.locator("#warden").innerText(), { timeout: 10_000 }).toBe("Warden is not in this browser. The buttons still work: you will see what a wallet is asked when nothing stands in front of it.");

    await row(page, "approve").getByRole("button", { name: "Try it" }).click();
    const approve = await resultOf(page, "approve");
    expect(approve.cls).toBe("result bad");
    expect(approve.text).toContain("The practice wallet was asked, and it signed. Nothing stood in between: Warden is not in this browser.");
    expect(approve.text).toContain("With Warden it is stopped before the wallet hears of it.");

    await row(page, "pay-new").getByRole("button", { name: "Try it" }).click();
    expect((await resultOf(page, "pay-new")).text).toContain("With Warden you would have read one sentence about it first.");
    // the wallet signed the first payment, so what follows from it can be tried too
    await expect.poll(() => row(page, "lookalike").getByRole("button").isDisabled(), { timeout: 5000 }).toBe(false);
    await row(page, "lookalike").getByRole("button", { name: "Try it" }).click();
    expect((await resultOf(page, "lookalike")).cls).toBe("result bad");
    await row(page, "pay-again").getByRole("button", { name: "Try it" }).click();
    expect((await resultOf(page, "pay-again")).text).toContain("Warden would not have interrupted this one either.");
    await row(page, "signin-relay").getByRole("button", { name: "Try it" }).click();
    expect((await resultOf(page, "signin-relay")).cls).toBe("result bad");
    await row(page, "tx-as-message").getByRole("button", { name: "Try it" }).click();
    expect((await resultOf(page, "tx-as-message")).cls).toBe("result bad");
    expect(errors).toEqual([]);
  });
});
