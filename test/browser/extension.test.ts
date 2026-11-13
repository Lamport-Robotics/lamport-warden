/**
 * The built extension in Chromium, in front of wallets that put themselves on the page the way Phantom,
 * Solflare and Backpack do, with a dapp built on the published Wallet Standard library. Both load orders:
 * which extension's script runs first is not something a user or Warden controls.
 *
 *   pnpm test:browser      (CHROMIUM_PATH=... to use a browser Playwright did not install)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { Page } from "playwright";
import { Prompt, WALLETS, WARDEN, calls, launch, result, serve, settled, type Browser, type Site } from "./harness.js";

const owner = Keypair.fromSeed(new Uint8Array(32).fill(7));
const BLOCKHASH = "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x";
const person = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const pay = (to: PublicKey, sol: number) => [...new Transaction({ feePayer: owner.publicKey, recentBlockhash: BLOCKHASH }).add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: to, lamports: Math.round(sol * 1e9) })).serialize({ requireAllSignatures: false, verifySignatures: false })];
const lookalike = (of: PublicKey) => new PublicKey(Buffer.from((BigInt("0x" + Buffer.from(of.toBytes()).toString("hex")) + 707281n * (1n << 80n)).toString(16).padStart(64, "0"), "hex"));
const text = (s: string) => [...new TextEncoder().encode(s)];

describe.each([["Warden's script first", [WARDEN, WALLETS]], ["the wallet's script first", [WALLETS, WARDEN]]])("in Chromium (%s)", (_name, order) => {
  let site: Site, browser: Browser;
  beforeAll(async () => { site = await serve(); browser = await launch(order); });
  afterAll(async () => { await browser?.close(); site?.server.close(); });

  const open = async (query = ""): Promise<{ page: Page; prompt: Prompt }> => {
    const page = await browser.ctx.newPage();
    await page.goto(`${site.origin}/${query}`);
    await page.waitForFunction(() => !!(window as any).__app);
    return { page, prompt: await Prompt.on(page) };
  };
  const start = (page: Page, tag: string, door: string, kind: string, payload: unknown, versioned = false) =>
    page.evaluate(([t, d, k, p, v]) => (window as any).__app.start(t, d, k, p, v), [tag, door, kind, payload, versioned] as const);

  it("uses the address the stand-in wallets sign as", () => {
    expect(owner.publicKey.toBase58()).toBe("GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB");
  });

  it("puts nothing on a page that has no wallet", async () => {
    const { page } = await open("?none=1");
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => ({ before: (window as any).__before, now: ["solana", "phantom", "solflare", "backpack"].filter((k) => k in window), errors: (window as any).__errors }))).toEqual({ before: { solana: false, phantom: false, solflare: false, backpack: false }, now: [], errors: [] });
    await page.close();
  });

  it("leaves every wallet registered once, as the wallet's own object, with no page error", async () => {
    const { page } = await open();
    expect(await page.evaluate(() => (window as any).__app.names().sort())).toEqual(["FixtureBackpack", "FixturePhantom", "FixtureSolflare"]);
    expect(await page.evaluate(() => ({ same: (window as any).solana === (window as any).phantom.solana, isPhantom: (window as any).solana.isPhantom, errors: (window as any).__errors }))).toEqual({ same: true, isPhantom: true, errors: [] });
    await page.close();
  });

  it("holds a first payment until a person continues, then stays out of the way the second time", async () => {
    const { page, prompt } = await open();
    const friend = person(101 + order.indexOf(WARDEN));
    await start(page, "first", "standard:FixturePhantom", "tx", pay(friend, 0.5));
    const shown = await prompt.text();
    expect(shown?.tag).toBe("Lamport Warden · Before you sign");
    expect(shown?.sentence).toMatch(/Sends 0\.5 SOL to .*You've never paid /);
    expect(shown?.all).toContain(`Asked by ${site.origin}`);
    expect(shown?.buttons).toEqual(["Cancel", "Continue to wallet"]);
    expect(await calls(page)).toEqual([]); // the wallet has not been asked

    // the page tries to answer for the owner: clicks it makes itself are not a person's
    await page.evaluate(() => { for (const e of [document.documentElement, ...document.documentElement.children]) for (const type of ["click", "pointerdown", "mousedown", "mouseup"]) e.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true, clientX: 600, clientY: 430 })); });
    await page.waitForTimeout(200);
    expect(await prompt.shown()).toBe(true);
    expect(await result(page, "first")).toBe("pending");
    // and it cannot look inside
    expect(await page.evaluate(() => [...document.documentElement.children].filter((e) => e.shadowRoot).length)).toBe(0);

    await prompt.click("Continue to wallet");
    expect(await settled(page, "first")).toBe("signed");
    expect(await calls(page)).toEqual(["standard:FixturePhantom.signTransaction"]);
    expect(await prompt.shown()).toBe(false);

    // the same address again, through another wallet's door: nothing to ask
    await page.waitForTimeout(300); // the history is written after the wallet answers
    await start(page, "second", "standard:FixtureBackpack", "send", pay(friend, 0.2));
    expect(await settled(page, "second")).toBe("signed");
    expect(await prompt.shown()).toBe(false);
    expect(await calls(page)).toEqual(["standard:FixturePhantom.signTransaction", "standard:FixtureBackpack.signAndSendTransaction"]);
    await page.close();
  });

  it("blocks a look-alike of an address already paid, with no way to continue", async () => {
    const { page, prompt } = await open();
    const friend = person(111 + order.indexOf(WARDEN));
    await start(page, "real", "solana", "tx", pay(friend, 0.5));
    await prompt.text();
    await prompt.click("Continue to wallet");
    expect(await settled(page, "real")).toBe("signed");
    await page.waitForTimeout(300);

    await start(page, "fake", "phantom.solana", "send", pay(lookalike(friend), 0.5));
    const shown = await prompt.text();
    expect(shown?.tag).toBe("Lamport Warden · Blocked");
    expect(shown?.all).toMatch(/address poisoning/i);
    expect(shown?.buttons).toEqual(["Close"]);
    await prompt.click("Close");
    expect(await settled(page, "fake")).toBe("WardenRejected");
    expect(await calls(page)).toEqual(["solana.signTransaction"]); // the look-alike never reached the wallet
    await page.close();
  });

  it.each([
    ["standard:FixturePhantom", "msg"], ["standard:FixtureSolflare", "msg"], ["standard:FixtureBackpack", "msg"],
    ["solana", "msg"], ["phantom.solana", "msg"], ["backpack", "msg"], ["backpack.solana", "msg"],
  ])("asks before a message reaches the wallet through %s", async (door, kind) => {
    const { page, prompt } = await open();
    await start(page, "m", door, kind, text("Sign in to the test shop\nnonce: 1234"));
    const shown = await prompt.text();
    expect(shown?.sentence).toContain("Sign in to the test shop");
    expect(await calls(page)).toEqual([]);
    await prompt.click("Cancel");
    expect(await settled(page, "m")).toBe("WardenRejected");
    expect(await calls(page)).toEqual([]);
    await page.close();
  });

  it("asks before a transaction sent through the wallet's generic request call", async () => {
    const { page, prompt } = await open();
    const message = new Transaction({ feePayer: owner.publicKey, recentBlockhash: BLOCKHASH }).add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: person(120), lamports: 250_000_000 })).serializeMessage();
    // base58 of the message, as the wallets' request API takes it
    const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let n = BigInt("0x" + message.toString("hex")), encoded = "";
    while (n > 0n) { encoded = A[Number(n % 58n)] + encoded; n /= 58n; }
    for (const x of message) { if (x !== 0) break; encoded = "1" + encoded; }
    await start(page, "r", "solana", "request", encoded);
    const shown = await prompt.text();
    expect(shown?.sentence).toMatch(/Sends 0\.25 SOL to /);
    expect(await calls(page)).toEqual([]);
    await prompt.click("Continue to wallet");
    expect(await settled(page, "r")).toBe("signed");
    expect(await calls(page)).toEqual(["solana.request:signAndSendTransaction"]);
    await page.close();
  });

  it("asks about each transaction of a batch, one prompt at a time", async () => {
    const { page, prompt } = await open();
    await start(page, "batch", "solana", "all", [pay(person(130), 0.1), pay(person(131), 0.2)]);
    expect((await prompt.text())?.sentence).toMatch(/Sends 0\.1 SOL/);
    await prompt.click("Continue to wallet");
    await page.waitForTimeout(250);
    expect((await prompt.text())?.sentence).toMatch(/Sends 0\.2 SOL/);
    expect(await calls(page)).toEqual([]);
    await prompt.click("Cancel"); // one refusal stops the batch
    expect(await settled(page, "batch")).toBe("WardenRejected");
    expect(await calls(page)).toEqual([]);
    await page.close();
  });

  it("guards wallets that arrive after the page has loaded", async () => {
    const { page, prompt } = await open("?late=1");
    await page.waitForFunction(() => (window as any).__app.names().length === 3);
    await page.waitForTimeout(250); // the slow timer's next look
    for (const door of ["standard:FixtureSolflare", "solana"]) {
      await start(page, door, door, "msg", text("Sign in to the test shop\nnonce: 99"));
      expect((await prompt.text())?.sentence).toContain("Sign in to the test shop");
      await prompt.click("Cancel");
      expect(await settled(page, door)).toBe("WardenRejected");
    }
    expect(await calls(page)).toEqual([]);
    await page.close();
  });

  it("known gap: a provider frozen like Solflare's older window.solflare is not guarded", async () => {
    // Solflare freezes that object and its place on the window; its Wallet Standard wallet, which dapps built
    // on wallet-adapter use, is guarded (above). If this starts failing, the gap has closed: update the README.
    const { page, prompt } = await open();
    await start(page, "gap", "solflare", "msg", text("Sign in to the test shop\nnonce: 7"));
    expect(await settled(page, "gap")).toBe("signed");
    expect(await prompt.shown()).toBe(false);
    expect(await calls(page)).toEqual(["solflare.signMessage"]);
    await page.close();
  });

  it("reads a lookup table from the RPC the owner chose, and says so when it is turned off", async () => {
    // the settings page, used as a person would
    const options = await browser.ctx.newPage();
    await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
    await options.fill("#rpcUrl", `${site.origin}/rpc`);
    await options.click("#saveRpc");
    await expect.poll(() => options.textContent("#rpcNote")).toBe("Saved.");

    const TABLE = person(140 + order.indexOf(WARDEN));
    const dest = person(150 + order.indexOf(WARDEN));
    const addresses = [person(141), person(142), dest];
    const data = Buffer.alloc(56 + 32 * addresses.length);
    data.writeUInt32LE(1, 0); data.writeBigUInt64LE(2n ** 64n - 1n, 4); data.writeBigUInt64LE(1n, 12);
    addresses.forEach((a, i) => data.set(a.toBytes(), 56 + 32 * i));
    site.setTable(TABLE.toBase58(), data.toString("base64"));
    const table = new AddressLookupTableAccount({ key: TABLE, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, authority: undefined, addresses } });
    const v0 = (sol: number) => [...new VersionedTransaction(new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: BLOCKHASH, instructions: [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: dest, lamports: Math.round(sol * 1e9) })] }).compileToV0Message([table])).serialize()];

    const { page, prompt } = await open();
    const before = site.rpcCalls.length;
    await start(page, "v0", "standard:FixturePhantom", "tx", v0(0.5));
    const shown = await prompt.text(8000);
    expect(shown?.sentence).toMatch(/Sends 0\.5 SOL to /);
    expect(shown?.sentence).not.toMatch(/could not read/);
    expect(site.rpcCalls.slice(before)).toEqual([[TABLE.toBase58()]]);
    await prompt.click("Cancel");
    await settled(page, "v0");

    // turned off: no call, and the owner is told part of it is hidden
    await options.check('input[name="rpc"][value="off"]');
    await options.click("#saveRpc");
    await expect.poll(() => options.textContent("#rpcNote")).toMatch(/no network calls/);
    const OTHER = person(160 + order.indexOf(WARDEN));
    const table2 = new AddressLookupTableAccount({ key: OTHER, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, authority: undefined, addresses } });
    const hidden = [...new VersionedTransaction(new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: BLOCKHASH, instructions: [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: dest, lamports: 100_000_000 })] }).compileToV0Message([table2])).serialize()];
    const calledBefore = site.rpcCalls.length;
    await start(page, "off", "standard:FixturePhantom", "tx", hidden);
    const unread = await prompt.text(8000);
    expect(unread?.sentence).toMatch(/I could not read all of the accounts it uses\.$/);
    expect(site.rpcCalls.length).toBe(calledBefore);
    await prompt.click("Cancel");
    await settled(page, "off");
    await page.close();
    await options.close();
  });

  it("shows on the settings page what it has learned, and forgets it when asked", async () => {
    const options = await browser.ctx.newPage();
    await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
    await expect.poll(() => options.textContent("#memory summary")).toMatch(/^GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB · \d+ addresses? paid$/);
    options.on("dialog", (d) => void d.accept());
    await options.click("#memory details summary");
    await options.click("#memory details button");
    await expect.poll(() => options.textContent("#memory")).toBe("Nothing yet.");
    await options.close();
  });
});
