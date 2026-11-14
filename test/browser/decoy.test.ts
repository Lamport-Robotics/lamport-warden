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
import { Notice, Prompt, WALLETS, WARDEN, calls, launch, serve, settled, type Browser, type Site } from "./harness.js";


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
  const forget = () => browser.ctx.serviceWorkers().find((w) => w.url().endsWith("/background.js"))!.evaluate(() => chrome.storage.local.remove(["decoyPassed", "decoyCaught"]));
  const open = async (only: string): Promise<{ page: Page; prompt: Prompt }> => {
    const page = await browser.ctx.newPage();
    await page.goto(`${site.origin}/?only=${only}&fresh=1`);
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
    expect(caught?.all).toContain("The wallet this site asked was never connected to it: what it was handed is the decoy's address.");
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

  // ---- the older door: the object the wallet puts on the window, which a site (or a thief's script) can call directly
  const OLDER: [string, string, string][] = [["phantom", "solana", "solana"], ["phantom", "phantom.solana", "solana"], ["backpack", "backpack.solana", "backpack"], ["backpack", "backpack", "backpack"]];
  const connectOlder = async (page: Page, door: string, tag: string) => { await page.evaluate(([t, d]) => (window as any).__app.connectOlder(t, d), [tag, door] as const); return settled(page, tag, 10_000); };
  const older = (page: Page, door: string): Promise<{ key: string | null; connected: unknown }> => page.evaluate((d) => (window as any).__app.older(d), door);
  const heard = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__heard ?? []);

  it.each(OLDER)("catches a site that robs the decoy through %s's older door (window.%s), and shuts every door of the page", async (only, door, recorded) => {
    await forget();
    const { page, prompt } = await open(only);
    await page.evaluate((d) => (window as any).__app.listen(d), door);
    // connect answers with the decoy, the provider says the decoy is its account, and the site's listener is told so
    expect(await connectOlder(page, door, "c")).toBe(DECOY.toBase58());
    expect(await older(page, door)).toEqual({ key: DECOY.toBase58(), connected: true });
    expect(await heard(page)).toEqual([`connect:${DECOY.toBase58()}`]);
    expect(await calls(page)).toEqual([]); // the wallet itself was never asked to connect
    // and its Wallet Standard wallet, which follows the provider, was told nothing of a decoy
    const standard = `standard:Fixture${only[0]!.toUpperCase()}${only.slice(1)}`;
    expect(await accounts(page, standard)).toEqual([]);

    await start(page, "rob", door, "tx", everything);
    const caught = await prompt.text(10_000);
    expect(caught?.tag).toBe("Lamport Warden · Blocked");
    expect(caught?.sentence).toBe("This site tried to rob a wallet that is not yours. I showed it a decoy before your own wallet, and it asked the decoy to send out 11.99 SOL, of the 12 SOL it holds and 900 USDC, all it holds.");
    await prompt.click("Close");
    expect(await settled(page, "rob")).toBe("WardenRejected");
    // nothing more, through this door or the wallet's other one
    await start(page, "more", door, "msg", [1, 2, 3]);
    expect(await settled(page, "more")).toBe("WardenRejected");
    expect(await connectOlder(page, door, "c2")).toBe("WardenRejected");
    expect(await connect(page, standard, "c3")).toBe("WardenRejected");
    expect(await prompt.shown()).toBe(false);
    expect(await calls(page)).toEqual([]);
    expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
    expect(recorded).toBeTruthy();
    await page.close();
  });

  it.each(OLDER)("gets out of an ordinary site's way at %s's older door (window.%s): the wallet takes the decoy's place and the site hears its account changed", async (only, door, recorded) => {
    await forget();
    const SHOP = person(70 + OLDER.findIndex((o) => o[1] === door) + (order[0] === WARDEN ? 0 : 20));
    const { page, prompt } = await open(only);
    await page.evaluate((d) => (window as any).__app.listen(d), door);
    expect(await connectOlder(page, door, "c")).toBe(DECOY.toBase58());
    await start(page, "pay", door, "tx", pay(DECOY, SHOP, 500_000_000n));
    const passed = await prompt.text(10_000);
    expect(passed?.tag).toBe("Lamport Warden · Before you sign");
    expect(passed?.sentence).toContain("what it asked the decoy to sign is not a robbery");
    expect(await calls(page)).toEqual([]);
    await prompt.click("Continue to wallet");
    // the wallet is connected now, and the site is told to ask again: what it built was built for the decoy
    expect(await settled(page, "pay")).toBe("WardenRejected");
    expect(await calls(page)).toEqual([`${recorded}.connect`]);
    expect(await older(page, door)).toEqual({ key: OWNER.toBase58(), connected: true });
    expect(await heard(page)).toEqual([`connect:${DECOY.toBase58()}`, `connect:${OWNER.toBase58()}`, `accountChanged:${OWNER.toBase58()}`]);
    await start(page, "again", door, "tx", pay(OWNER, SHOP, 500_000_000n));
    const asked = await prompt.text(10_000);
    expect(asked?.sentence).toContain("0.5 SOL");
    expect(asked?.sentence).not.toContain("decoy");
    await prompt.click("Continue to wallet");
    expect(await settled(page, "again")).toBe("signed");
    expect(await calls(page)).toEqual([`${recorded}.connect`, `${recorded}.signTransaction`]);
    expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
    await page.close();
  });

  // ---- what the owner is told while a decoy shows, and what is remembered of a site

  it("says in a corner of the page that a decoy is showing, and connects the owner's wallet when they press its button", async () => {
    await forget();
    const door = "standard:FixturePhantom";
    const { page, prompt } = await open("phantom");
    const note = await Notice.on(page);
    expect(await note.shown()).toBe(false);
    expect(await connect(page, door, "c")).toBe(DECOY.toBase58());
    const said = await note.text(6000);
    expect(said).toEqual({ text: `This site is being shown a decoy wallet (${short(DECOY.toBase58())}), not yours. If it asks the decoy for anything, I will tell you what.`, warn: false, button: "Use my wallet here" });
    // a site with nothing to ask straight away asks the decoy for nothing: the button is how its visitor goes on
    await note.press();
    await expect.poll(() => accounts(page, door), { timeout: 8000 }).toEqual([OWNER.toBase58()]);
    expect(await calls(page)).toEqual([`${door}.connect`]);
    expect(await note.shown()).toBe(false);
    expect(await prompt.shown()).toBe(false);
    // from here Warden reads what the site asks like any other request
    const SHOP = person(110 + (order[0] === WARDEN ? 0 : 1));
    await start(page, "pay", door, "tx", pay(OWNER, SHOP, 500_000_000n));
    expect((await prompt.text(10_000))?.sentence).toContain("0.5 SOL");
    await prompt.click("Continue to wallet");
    expect(await settled(page, "pay")).toBe("signed");
    await page.close();
    // and the site, gone on with, is not shown a decoy on the next visit
    const next = await open("phantom");
    expect(await connect(next.page, door, "c")).toBe(OWNER.toBase58());
    expect(await (await Notice.on(next.page)).shown()).toBe(false);
    await next.page.close();
  });

  it("asks once about everything in one call, and remembers a site only when the owner goes on with it", async () => {
    await forget();
    const door = "standard:FixturePhantom";
    const SHOP = person(120 + (order[0] === WARDEN ? 0 : 1));
    const two = [pay(DECOY, SHOP, 100_000_000n), pay(DECOY, SHOP, 200_000_000n)];
    // the owner says no to going on: nothing is remembered of the site
    const first = await open("phantom");
    expect(await connect(first.page, door, "c")).toBe(DECOY.toBase58());
    await start(first.page, "both", door, "all", two);
    expect((await first.prompt.text(10_000))?.sentence).toContain("what it asked the decoy to sign is not a robbery");
    await first.prompt.click("Cancel");
    expect(await settled(first.page, "both")).toBe("WardenRejected");
    expect(await accounts(first.page, door)).toEqual([DECOY.toBase58()]);
    expect(await calls(first.page)).toEqual([]);
    await first.page.close();
    // so the next visit is shown the decoy again; this time the owner goes on, with one press for the two requests
    const second = await open("phantom");
    expect(await connect(second.page, door, "c")).toBe(DECOY.toBase58());
    await start(second.page, "both", door, "all", two);
    expect((await second.prompt.text(10_000))?.sentence).toContain("what it asked the decoy to sign is not a robbery");
    await second.prompt.click("Continue to wallet");
    expect(await settled(second.page, "both")).toBe("WardenRejected"); // told to ask again
    await second.page.waitForTimeout(400);
    expect(await second.prompt.shown()).toBe(false); // one question, not two
    expect(await calls(second.page)).toEqual([`${door}.connect`]);
    expect(await accounts(second.page, door)).toEqual([OWNER.toBase58()]);
    await second.page.close();
  });

  it("stays caught when a harmless request is asked beside the robbery, and remembers the site: going on with it later takes typing", async () => {
    await forget();
    const door = "standard:FixturePhantom";
    const { page, prompt } = await open("phantom");
    expect(await connect(page, door, "c")).toBe(DECOY.toBase58());
    // the drain, and a message in the same breath that would pass on its own
    await start(page, "rob", door, "tx", everything);
    await start(page, "words", door, "msg", [1, 2, 3]);
    expect((await prompt.text(10_000))?.tag).toBe("Lamport Warden · Blocked");
    await prompt.click("Close");
    expect(await settled(page, "rob")).toBe("WardenRejected");
    expect(await settled(page, "words")).toBe("WardenRejected");
    await page.waitForTimeout(500);
    expect(await prompt.shown()).toBe(false); // no "this one is all right" after "this is a thief"
    expect(await connect(page, door, "c2")).toBe("WardenRejected");
    expect(await calls(page)).toEqual([]);
    await page.close();

    // the same site again: shown a decoy again, and the owner is told what it did
    const again = await open("phantom");
    expect(await connect(again.page, door, "c")).toBe(DECOY.toBase58());
    const said = await (await Notice.on(again.page)).text(6000);
    expect(said?.warn).toBe(true);
    expect(said?.text).toMatch(/^This site tried to rob a decoy wallet on \d{4}-\d{2}-\d{2}\. It is being shown a decoy \(.+\) again, not your wallet\.$/);
    // this time it asks for something ordinary: that is not gone on with at a press
    const SHOP = person(130 + (order[0] === WARDEN ? 0 : 1));
    await start(again.page, "pay", door, "tx", pay(DECOY, SHOP, 500_000_000n));
    const asked = await again.prompt.text(10_000);
    expect(asked?.tag).toBe("Lamport Warden · Check this carefully");
    expect(asked?.sentence).toMatch(/^This site tried to rob a decoy wallet on \d{4}-\d{2}-\d{2}\. This time what it asked the decoy to sign is not a robbery\. Go on only if you are sure of this site: your own wallet is then connected to it\.$/);
    expect(await again.prompt.canContinue()).toBe(false);
    await again.prompt.type("I understand");
    expect(await again.prompt.canContinue()).toBe(true);
    await again.prompt.click("Cancel");
    expect(await calls(again.page)).toEqual([]);
    await again.page.close();
  });

  it.each(["FixturePhantom", "FixtureSolflare", "FixtureBackpack"])("shows no decoy to a site %s already trusts: that site has its address already", async (name) => {
    await forget();
    const door = `standard:${name}`;
    // (without fresh=1 the stand-in wallets are connected from the start, as a wallet is on a site it trusts)
    const page = await browser.ctx.newPage();
    await page.goto(`${site.origin}/?only=${name.slice(7).toLowerCase()}`);
    await page.waitForFunction(() => !!(window as any).__app);
    expect(await accounts(page, door)).toEqual([OWNER.toBase58()]);
    expect(await connect(page, door, "c")).toBe(OWNER.toBase58());
    expect(await accounts(page, door)).toEqual([OWNER.toBase58()]);
    await page.close();
  });
});

describe("off unless turned on", () => {
  let site: Site, browser: Browser;
  beforeAll(async () => { site = await serve(); browser = await launch([WARDEN, WALLETS]); });
  afterAll(async () => { await browser?.close(); site?.server.close(); });

  it("shows no site a decoy in a new install: the wallet is connected as always, and nothing about the site is kept", async () => {
    const page = await browser.ctx.newPage();
    await page.goto(`${site.origin}/?only=phantom&fresh=1`);
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
