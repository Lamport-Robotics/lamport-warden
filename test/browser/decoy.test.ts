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
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { Page } from "playwright";
import { Prompt, WALLETS, WARDEN, calls, launch, serve, settled, type Browser, type Site } from "./harness.js";
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

// ---- on any site, with a decoy the owner named, in front of wallets built the way the real ones are

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const person = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
/** The decoy of these tests. (Here its key could be worked out; a decoy somebody uses must be an address they have no key to.) */
const DECOY = person(33), THIEF = person(34);
/** The address the stand-in wallets hold (test/browser/fixtures/wallet-ext). */
const OWNER = new PublicKey("GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB");
const ata = (owner: PublicKey) => PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN.toBytes(), USDC.toBytes()], ASSOCIATED)[0];
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const bytesOf = (payer: PublicKey, ...ix: TransactionInstruction[]) => [...new Transaction({ feePayer: payer, recentBlockhash: "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x" }).add(...ix).serialize({ requireAllSignatures: false, verifySignatures: false })];
const pay = (from: PublicKey, to: PublicKey, lamports: bigint) => bytesOf(from, SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports }));
/** What a thief that looked the decoy up would ask it for: nearly all of its 12 SOL, and all of its 900 USDC. */
const everything = bytesOf(DECOY,
  SystemProgram.transfer({ fromPubkey: DECOY, toPubkey: THIEF, lamports: 11_990_000_000n }),
  new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: ata(DECOY), isSigner: false, isWritable: true }, { pubkey: USDC, isSigner: false, isWritable: false }, { pubkey: ata(THIEF), isSigner: false, isWritable: true }, { pubkey: DECOY, isSigner: true, isWritable: false }], data: Buffer.concat([Buffer.from([12]), u64(900_000_000n), Buffer.from([6])]) }));

describe.each([["Warden's script first", [WARDEN, WALLETS]], ["the wallet's script first", [WALLETS, WARDEN]]])("a decoy the owner named, on any site (%s)", (_name, order) => {
  let site: Site, browser: Browser;
  const forget = () => browser.ctx.serviceWorkers().find((w) => w.url().endsWith("/background.js"))!.evaluate(() => chrome.storage.local.remove("decoyPassed"));
  const open = async (only: string): Promise<{ page: Page; prompt: Prompt }> => {
    const page = await browser.ctx.newPage();
    await page.goto(`${site.origin}/?only=${only}`);
    await page.waitForFunction(() => !!(window as any).__app);
    return { page, prompt: await Prompt.on(page) };
  };
  const connect = async (page: Page, door: string, tag: string) => { await page.evaluate(([t, d]) => (window as any).__app.connect(t, d), [tag, door] as const); return settled(page, tag, 10_000); };
  const accounts = (page: Page, door: string): Promise<string[]> => page.evaluate((d) => (window as any).__app.accounts(d), door);
  const start = (page: Page, tag: string, door: string, kind: string, payload: unknown) => page.evaluate(([t, d, k, p]) => (window as any).__app.start(t, d, k, p), [tag, door, kind, payload] as const);

  beforeAll(async () => {
    site = await serve();
    site.setHoldings(DECOY.toBase58(), 12_000_000_000, [{ account: ata(DECOY).toBase58(), mint: USDC.toBase58(), amount: "900000000", decimals: 6 }]);
    browser = await launch(order);
    // the owner turned the experiment on and named a decoy; what it holds is asked of their RPC
    const worker = browser.ctx.serviceWorkers().find((w) => w.url().endsWith("/background.js"))!;
    await worker.evaluate(([rpcUrl, decoyAddress]) => chrome.storage.local.set({ decoyFirst: true, decoyAddress, rpcUrl }), [`${site.origin}/rpc`, DECOY.toBase58()] as const);
  });
  afterAll(async () => { await browser?.close(); site?.server.close(); });

  it.each(["FixturePhantom", "FixtureSolflare", "FixtureBackpack"])("catches a site that asks the decoy for everything, in front of %s", async (name) => {
    await forget();
    const door = `standard:${name}`;
    const { page, prompt } = await open(name.slice(7).toLowerCase());
    // the site connects, and is handed the decoy: by connect, and in the wallet's own list of accounts
    expect(await connect(page, door, "c")).toBe(DECOY.toBase58());
    expect(await accounts(page, door)).toEqual([DECOY.toBase58()]);
    expect(await calls(page)).toEqual([]); // the wallet itself was never asked to connect
    // the RPC was asked what the decoy holds, and nothing about the owner
    expect(site.holdingsAsked).toContain(DECOY.toBase58());
    expect(site.holdingsAsked).not.toContain(OWNER.toBase58());

    await start(page, "rob", door, "tx", everything);
    const caught = await prompt.text(10_000);
    expect(caught?.tag).toBe("Lamport Warden · Blocked");
    expect(caught?.sentence).toBe("This site tried to rob a wallet that is not yours. I showed it a decoy before your own wallet, and it asked the decoy to send out 11.99 SOL, of the 12 SOL it holds and 900 USDC, all it holds.");
    expect(caught?.buttons).toEqual(["Close"]);
    await prompt.click("Close");
    expect(await settled(page, "rob")).toBe("WardenRejected");
    // a page that was caught gets nothing more: not a message, not a connect, and no prompt to talk the owner round with
    await start(page, "more", door, "msg", [1, 2, 3]);
    expect(await settled(page, "more")).toBe("WardenRejected");
    expect(await connect(page, door, "c2")).toBe("WardenRejected");
    expect(await prompt.shown()).toBe(false);
    expect(await calls(page)).toEqual([]);
    expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
    await page.close();
  });

  it.each(["FixturePhantom", "FixtureSolflare", "FixtureBackpack"])("gets out of an ordinary site's way in front of %s, and does not show that site a decoy again", async (name) => {
    await forget();
    const door = `standard:${name}`;
    // a shop this wallet has never paid: Warden remembers who a wallet has paid, and says nothing of a payment it has seen before
    const SHOP = person(40 + ["FixturePhantom", "FixtureSolflare", "FixtureBackpack"].indexOf(name) + (order[0] === WARDEN ? 0 : 20));
    const { page, prompt } = await open(name.slice(7).toLowerCase());
    expect(await connect(page, door, "c")).toBe(DECOY.toBase58());
    // half a SOL of twelve: a payment somebody chose
    await start(page, "pay", door, "tx", pay(DECOY, SHOP, 500_000_000n));
    const passed = await prompt.text(10_000);
    expect(passed?.tag).toBe("Lamport Warden · Before you sign");
    expect(passed?.sentence).toContain("what it asked the decoy to sign is not a robbery");
    expect(await calls(page)).toEqual([]);
    await prompt.click("Continue to wallet");
    // the wallet is connected now, and the site is told to ask again: what it built was built for the decoy
    expect(await settled(page, "pay")).toBe("WardenRejected");
    expect(await calls(page)).toEqual([`${door}.connect`]);
    expect(await accounts(page, door)).toEqual([OWNER.toBase58()]);
    // it asks the wallet that is there now, and Warden reads that like any first payment to a new address
    await start(page, "again", door, "tx", pay(OWNER, SHOP, 500_000_000n));
    const asked = await prompt.text(10_000);
    expect(asked?.sentence).toContain("0.5 SOL");
    expect(asked?.sentence).not.toContain("decoy");
    await prompt.click("Continue to wallet");
    expect(await settled(page, "again")).toBe("signed");
    expect(await calls(page)).toEqual([`${door}.connect`, `${door}.signTransaction`]);
    expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
    await page.close();

    // the site passed: the next visit is connected to the wallet as always
    const next = await open(name.slice(7).toLowerCase());
    expect(await connect(next.page, door, "c")).toBe(OWNER.toBase58());
    expect(await calls(next.page)).toEqual([`${door}.connect`]);
    await next.page.close();
  });
});
