/**
 * Decoy first, in Chromium, with the built extension in front of the practice page's pretend sites: one that
 * robs whoever connects, and one that only asks to be paid.
 *
 *   pnpm test:browser      DECOY_SHOT=/some/folder keeps pictures of what Warden shows in each case
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
import { PRACTICE_DECOY } from "../../src/decoy.js";

const here = dirname(fileURLToPath(import.meta.url));
const TRY = join(here, "..", "..", "site", "try", "dist");
const SENTINEL = join(here, "..", "..", "sentinel", "web", "dist");
const SITE = "https://warden.lamportrobotics.com";
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** The site as the web server would serve it: the practice page's build, and the stylesheet it borrows. */
async function serveSite(): Promise<Server> {
  const dir = mkdtempSync(join(tmpdir(), "warden-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "2", "-subj", "/CN=warden.lamportrobotics.com"], { stdio: "ignore" });
  const types: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };
  const server = createHttps({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
    const path = new URL(req.url ?? "/", SITE).pathname;
    const file = path === "/try/thief/" ? join(TRY, "thief", "index.html") : path === "/try/thief/thief.js" ? join(TRY, "thief", "thief.js") : path === "/try/try.css" ? join(TRY, "try.css") : path === "/sentinel/sentinel.css" ? join(SENTINEL, "sentinel.css") : "";
    if (!file || !existsSync(file)) { res.statusCode = 404; res.end(); return; }
    res.setHeader("content-type", types[file.split(".").pop()!] ?? "application/octet-stream");
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

describe.skipIf(!existsSync(join(TRY, "thief", "thief.js")))("a decoy first, in Chromium", () => {
  let site: Server, browser: Browser;
  const errors: string[] = [];
  const open = async (query = ""): Promise<{ page: Page; prompt: Prompt; wallet: string }> => {
    const page = await browser.ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e.message)));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(`${SITE}/try/thief/${query}`);
    await expect.poll(() => page.locator("#address").innerText(), { timeout: 10_000 }).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    return { page, prompt: await Prompt.on(page), wallet: await page.locator("#address").innerText() };
  };
  const shot = async (page: Page, name: string) => { if (process.env.DECOY_SHOT) await page.screenshot({ path: join(process.env.DECOY_SHOT, name) }); };

  beforeAll(async () => {
    site = await serveSite();
    browser = await launch([WARDEN], [`--host-resolver-rules=MAP warden.lamportrobotics.com 127.0.0.1:${(site.address() as { port: number }).port}`, "--ignore-certificate-errors"]);
  });
  afterAll(async () => { await browser?.close(); site?.close(); });

  it("catches a site that robs whoever connects, before the wallet is connected or its address seen", async () => {
    const { page, prompt, wallet } = await open();
    await page.getByRole("button", { name: "Connect, and claim your airdrop" }).click();
    const caught = await prompt.text(10_000);
    // what the site was handed is the decoy, and that is the address it went after
    expect(await page.locator("#victim").innerText()).toBe(`Connected: ${PRACTICE_DECOY.address}`);
    expect(wallet).not.toBe(PRACTICE_DECOY.address);
    expect(caught?.tag).toBe("Lamport Warden · Blocked");
    expect(caught?.sentence).toBe("This site tried to rob a wallet that is not yours. I showed it a decoy before your own wallet, and it asked the decoy to send out 309.99 SOL, of the 310 SOL it holds and 40,000 USDC, all it holds.");
    expect(caught?.all).toContain("Your wallet was never connected to this site, and the site has not seen your address.");
    expect(caught?.all).toContain("Nothing was taken: nobody here holds the decoy's key, so nothing it is asked to sign can be signed.");
    // there is nothing to continue to
    expect(caught?.buttons).toEqual(["Close"]);
    await shot(page, "decoy-caught.png");
    await prompt.click("Close");
    // the page's own account of it: its wallet was never connected and never asked for anything
    await expect.poll(() => page.locator("#result").innerText(), { timeout: 8000 }).toBe(`Stopped. The address this page was handed was a decoy's (${short(PRACTICE_DECOY.address)}), not the practice wallet's. The thief asked the decoy for everything, Warden saw it, and the practice wallet was never connected or asked for anything.`);
    expect(await page.locator("#result").getAttribute("class")).toBe("result good");
    // nowhere on the page is the practice wallet's address anything but the page's own label for it
    expect(await page.locator("#victim").innerText()).not.toContain(wallet);
    await page.close();
  });

  it("gets out of the way of a site that is not a thief: the wallet takes the decoy's place, and the site asks again", async () => {
    const { page, prompt, wallet } = await open("?honest");
    await page.getByRole("button", { name: "Connect, and pay 0.5 SOL" }).click();
    const passed = await prompt.text(10_000);
    expect(passed?.tag).toBe("Lamport Warden · Before you sign");
    expect(passed?.sentence).toBe(`I showed this site a decoy wallet (${short(PRACTICE_DECOY.address)}) before yours, and what it asked the decoy to sign is not a robbery. Continue to connect your own wallet; the site will then ask again, and I will read that request like any other.`);
    expect(await page.locator("#victim").innerText()).toBe(`Connected: ${PRACTICE_DECOY.address}`);
    await shot(page, "decoy-passed.png");
    await prompt.click("Continue to wallet");
    // The practice wallet is connected now, the site asks it for the same half SOL, and Warden reads that
    // request the way it reads any first payment to a new address.
    await expect.poll(() => page.locator("#victim").innerText(), { timeout: 8000 }).toBe(`Connected: ${wallet}`);
    let asked: Awaited<ReturnType<Prompt["text"]>> = null;
    await expect.poll(async () => { asked = await prompt.text(500); return asked?.sentence ?? ""; }, { timeout: 10_000 }).toContain("0.5 SOL");
    expect(asked!.sentence).not.toContain("decoy");
    await prompt.click("Continue to wallet");
    await expect.poll(() => page.locator("#result").innerText(), { timeout: 8000 }).toBe(`Signed by the practice wallet. The site was handed a decoy (${short(PRACTICE_DECOY.address)}) first; what it asked the decoy for was ordinary, so the practice wallet took the decoy's place, the site asked again, and Warden read that request like any other.`);
    expect(await page.locator("#result").getAttribute("class")).toBe("result good");
    await page.close();
  });

  it("shows a decoy only on the practice thief's page while the experiment is off: the practice page itself is connected as always", async () => {
    // the setting is off in a new install; Lamport's own practice thief is the one page that gets a decoy regardless
    const worker = browser.ctx.serviceWorkers().find((w) => w.url().endsWith("/background.js"))!;
    expect(await worker.evaluate(() => chrome.storage.local.get(["decoyFirst", "decoyAddress", "decoyPassed"]))).toEqual({});
    expect(errors).toEqual([]);
  });
});
