/**
 * Decoy first, in Chromium, with the built extension on an ordinary site, in front of wallets built the way
 * the real ones are: a site that asks the decoy for everything, and one that only asks to be paid.
 *
 *   pnpm test:browser      DECOY_SHOT=/some/folder keeps pictures of what Warden shows in each case
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { Page } from "playwright";
import { Prompt, WALLETS, WARDEN, calls, launch, serve, settled, type Browser, type Site } from "./harness.js";


const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const person = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
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
  const shot = async (page: Page, name: string, wallet: string) => { if (process.env.DECOY_SHOT && wallet === "FixturePhantom" && order[0] === WARDEN) await page.screenshot({ path: join(process.env.DECOY_SHOT, name) }); };

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
    expect(caught?.all).toContain("Your wallet was never connected to this site, and the site has not seen your address.");
    expect(caught?.all).toContain("Nothing was taken: nobody here holds the decoy's key, so nothing it is asked to sign can be signed.");
    // there is nothing to continue to
    expect(caught?.buttons).toEqual(["Close"]);
    await shot(page, "decoy-caught.png", name);
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
    expect(passed?.sentence).toBe(`I showed this site a decoy wallet (${short(DECOY.toBase58())}) before yours, and what it asked the decoy to sign is not a robbery. Continue to connect your own wallet; the site will then ask again, and I will read that request like any other.`);
    expect(await calls(page)).toEqual([]);
    await shot(page, "decoy-passed.png", name);
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

describe("off unless turned on", () => {
  let site: Site, browser: Browser;
  beforeAll(async () => { site = await serve(); browser = await launch([WARDEN, WALLETS]); });
  afterAll(async () => { await browser?.close(); site?.server.close(); });

  it("shows no site a decoy in a new install: the wallet is connected as always, and nothing about the site is kept", async () => {
    const page = await browser.ctx.newPage();
    await page.goto(`${site.origin}/?only=phantom`);
    await page.waitForFunction(() => !!(window as any).__app);
    const door = "standard:FixturePhantom";
    await page.evaluate((d) => (window as any).__app.connect("c", d), door);
    expect(await settled(page, "c", 10_000)).toBe(OWNER.toBase58());
    expect(await page.evaluate((d) => (window as any).__app.accounts(d), door)).toEqual([OWNER.toBase58()]);
    expect(await calls(page)).toEqual([`${door}.connect`]);
    // no decoy was looked up, and no mark of the site was made
    expect(site.holdingsAsked).toEqual([]);
    const worker = browser.ctx.serviceWorkers().find((w) => w.url().endsWith("/background.js"))!;
    expect(await worker.evaluate(() => chrome.storage.local.get(["decoyFirst", "decoyAddress", "decoyPassed", "decoySalt"]))).toEqual({});
    expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
    await page.close();
  });
});
