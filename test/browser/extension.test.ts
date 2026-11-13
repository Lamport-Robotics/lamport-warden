/**
 * The built extension in Chromium, in front of wallets that put themselves on the page the way Phantom,
 * Solflare and Backpack do, with a dapp built on the published Wallet Standard library. Both load orders:
 * which extension's script runs first is not something a user or Warden controls.
 *
 *   pnpm test:browser      (CHROMIUM_PATH=... to use a browser Playwright did not install)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
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

  it("simulates a call to a program it does not read, only once the owner turns that on", async () => {
    const options = await browser.ctx.newPage();
    await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
    await options.fill("#rpcUrl", `${site.origin}/rpc`);
    await options.click("#saveRpc");
    await expect.poll(() => options.textContent("#rpcNote")).toBe("Saved.");

    // a swap on a program the decoder has no reading of: 1 SOL goes, 150 USDC arrive in a new account
    const DEX = person(170), pool = person(171), usdcAccount = person(172 + order.indexOf(WARDEN));
    const swap = [...new Transaction({ feePayer: owner.publicKey, recentBlockhash: BLOCKHASH }).add(new TransactionInstruction({ programId: DEX, keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }, { pubkey: pool, isSigner: false, isWritable: true }, { pubkey: usdcAccount, isSigner: false, isWritable: true }], data: Buffer.from([1, 2, 3]) })).serialize({ requireAllSignatures: false, verifySignatures: false })];
    const SYSTEM = "11111111111111111111111111111111";
    const me = owner.publicKey.toBase58();
    site.setChain(
      { [me]: { lamports: 3_000_000_000, owner: SYSTEM, data: ["", "base64"] } },
      { [me]: { lamports: 1_997_955_720, owner: SYSTEM, data: ["", "base64"] }, [usdcAccount.toBase58()]: { lamports: 2_039_280, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { program: "spl-token", space: 165, parsed: { type: "account", info: { isNative: false, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: me, state: "initialized", tokenAmount: { amount: "150000000", decimals: 6 } } } } } },
    );

    const { page, prompt } = await open();
    const sent = site.simulated.length;
    await start(page, "off", "standard:FixturePhantom", "tx", swap);
    const plain = await prompt.text(8000);
    expect(plain?.sentence).not.toMatch(/simulat/i);
    expect(site.simulated.length).toBe(sent); // off: the transaction went nowhere
    await prompt.click("Cancel");
    await settled(page, "off");

    await options.check("#simulate");
    await expect.poll(() => options.textContent("#simNote")).toMatch(/^On\./);
    await start(page, "on", "standard:FixturePhantom", "tx", swap);
    const shown = await prompt.text(8000);
    expect(shown?.sentence).toMatch(/In a simulation just now, your wallet lost 1\.002 SOL \(fee included\) and gained 150 USDC\.$/);
    expect(site.simulated.length).toBe(sent + 1);
    expect(Buffer.from(site.simulated.at(-1)!, "base64")).toEqual(Buffer.from(swap));
    await prompt.click("Continue to wallet");
    expect(await settled(page, "on")).toBe("signed");
    await page.waitForTimeout(300);
    expect(site.simulated.length).toBe(sent + 1); // recording the signed send does not run it again

    await options.uncheck("#simulate");
    await expect.poll(() => options.textContent("#simNote")).toMatch(/^Off\./);
    await page.close();
    await options.close();
  });

  it("lets a sign-in to the site itself through, and blocks one that would sign the owner in somewhere else", async () => {
    const { page, prompt } = await open();
    const here = new URL(site.origin).host;
    // to this site, by name and with no name at all: nothing to stop for
    await start(page, "named", "standard:FixturePhantom", "signin", { domain: here, statement: "Sign in to the test shop" });
    expect(await settled(page, "named")).toBe("signed");
    await start(page, "bare", "standard:FixtureSolflare", "signin", null);
    expect(await settled(page, "bare")).toBe("signed");
    expect(await prompt.shown()).toBe(false);
    // a relay: this page collects a sign-in for another site, through each kind of door
    for (const door of ["standard:FixtureBackpack", "solana"]) {
      await start(page, door, door, "signin", { domain: "app.realbank.example", statement: "Sign in" });
      const shown = await prompt.text();
      expect(shown?.tag).toBe("Lamport Warden · Blocked");
      expect(shown?.sentence).toBe(`${here} asks you to sign in, but the signature would sign you in to app.realbank.example, a different site.`);
      expect(shown?.buttons).toEqual(["Close"]);
      await prompt.click("Close");
      expect(await settled(page, door)).toBe("WardenRejected");
    }
    expect(await calls(page)).toEqual(["standard:FixturePhantom.signIn", "standard:FixtureSolflare.signIn"]);
    await page.close();
  });

  it.each([
    ["a layer with the highest z-index, added after the prompt", `const d = document.createElement("div"); d.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#fff;pointer-events:none"; d.textContent = "Click to claim"; document.documentElement.append(d);`],
    ["a popover in the browser's top layer, raised again and again", `const d = document.createElement("div"); d.popover = "manual"; d.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;border:0;background:#fff;pointer-events:none"; d.textContent = "Click to claim"; document.documentElement.append(d); d.showPopover(); setInterval(() => { d.hidePopover(); d.showPopover(); }, 30);`],
    ["a stylesheet that makes the prompt transparent", `const s = document.createElement("style"); s.textContent = "html > div { opacity: 0 !important }"; document.documentElement.append(s);`],
    ["its own inline style on the prompt's element, kept there", `setInterval(() => { for (const e of document.documentElement.children) if (e.tagName === "DIV") e.style.setProperty("opacity", "0", "important"); }, 20);`],
    ["a transform that slides the prompt off the screen", `setInterval(() => { for (const e of document.documentElement.children) if (e.tagName === "DIV") e.style.setProperty("transform", "translateX(-200vw)", "important"); }, 20);`],
    ["a transparent copy of itself under a bait the page draws", `setInterval(() => { for (const e of document.documentElement.children) if (e.tagName === "DIV") e.style.setProperty("opacity", "0.02", "important"); }, 20); const b = document.createElement("div"); b.style.cssText = "position:fixed;inset:0;background:#fff;pointer-events:none;z-index:1"; b.textContent = "Click to claim"; document.body.append(b);`],
  ])("is never approved unseen: the page tries %s", async (what, attack) => {
    const { page, prompt } = await open();
    await start(page, "cover", "standard:FixturePhantom", "tx", pay(Keypair.generate().publicKey, 0.3)); // an address never paid: the prompt must come up
    expect((await prompt.text())?.buttons).toEqual(["Cancel", "Continue to wallet"]);
    await page.evaluate(attack);
    await page.waitForTimeout(900);
    // Either the prompt held its ground and is what is painted there, or the click does nothing. What must never
    // happen is an approval from a click on a button the person could not see.
    const painted = await prompt.continueIsPainted();
    await prompt.click("Continue to wallet").catch(() => undefined); // where the button is, as a person aiming at the bait would click
    await page.waitForTimeout(400);
    const approved = (await result(page, "cover")) === "signed";
    // approved only if it was there to be seen; a page that fights the prompt may also simply get no approval
    if (approved) expect({ what, painted }).toEqual({ what, painted: true });
    else expect(await calls(page)).toEqual([]);
    await page.close();
  });

  it.each([
    ["inverts its colours with a filter on the whole document, as dark-mode extensions do", `document.documentElement.style.filter = "invert(1) hue-rotate(180deg)";`],
    ["is zoomed with a transform on the whole document", `document.documentElement.style.transform = "scale(0.9)"; document.documentElement.style.transformOrigin = "0 0";`],
    ["dims its body and scrolls", `document.body.style.opacity = "0.5"; document.body.style.height = "4000px"; window.scrollTo(0, 900);`],
  ])("still lets a person continue on a page that %s", async (_what, setup) => {
    const { page, prompt } = await open();
    await page.evaluate(setup);
    await start(page, "styled", "standard:FixturePhantom", "tx", pay(Keypair.generate().publicKey, 0.3));
    expect((await prompt.text())?.buttons).toEqual(["Cancel", "Continue to wallet"]);
    await prompt.click("Continue to wallet");
    expect(await settled(page, "styled")).toBe("signed");
    await page.close();
  });

  it("treats a prompt the page removed as a refusal, not as silence", async () => {
    const { page, prompt } = await open();
    await start(page, "gone", "standard:FixturePhantom", "tx", pay(person(230 + order.indexOf(WARDEN)), 0.3));
    expect(await prompt.text()).not.toBeNull();
    await page.evaluate(() => { for (const e of [...document.documentElement.children]) if (e.tagName === "DIV") e.remove(); });
    expect(await settled(page, "gone")).toBe("WardenRejected");
    expect(await calls(page)).toEqual([]);
    await page.close();
  });

  it("lists on the settings page a wallet door it could not guard", async () => {
    const { page } = await open(); // the stand-in for Solflare's frozen window.solflare is on this page
    await page.waitForTimeout(500);
    const options = await browser.ctx.newPage();
    await options.goto(`chrome-extension://${browser.extensionId}/options.html`);
    await expect.poll(() => options.isVisible("#doors")).toBe(true);
    expect(await options.textContent("#doorList")).toMatch(/^window\.solflarelast seen \d{4}-\d{2}-\d{2}$/);
    await options.close();
    await page.close();
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
