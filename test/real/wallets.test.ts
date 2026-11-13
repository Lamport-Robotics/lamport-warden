/**
 * Warden in front of the real Phantom, Solflare and Backpack extensions, as the Chrome Web Store ships them
 * today. Not part of CI: it downloads the wallets (about 80 MB) and their code changes without notice, which
 * is the reason to run it before every release.
 *
 *   pnpm test:wallets
 *   WALLETS_DIR=/some/dir pnpm test:wallets     keeps the downloads there and reuses them
 *
 * No wallet is set up and nothing is signed. Each door is asked to sign a message; Warden's prompt must come
 * up first, and it is cancelled, so the request never reaches the wallet.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { Prompt, WARDEN, launch, serve, settled, type Browser, type Site } from "../browser/harness.js";

const dir = process.env.WALLETS_DIR || mkdtempSync(join(tmpdir(), "warden-wallets-"));

/** Downloads an extension from the Chrome Web Store and unpacks it. */
async function fetchWallet(name: string, id: string): Promise<string> {
  const out = join(dir, name);
  if (existsSync(join(out, "manifest.json"))) return out;
  mkdirSync(out, { recursive: true });
  const res = await fetch(`https://clients2.google.com/service/update2/crx?response=redirect&prodversion=141.0&acceptformat=crx2,crx3&x=id%3D${id}%26uc`);
  if (!res.ok) throw new Error(`could not download ${name}: ${res.status}`);
  const crx = Buffer.from(await res.arrayBuffer());
  // CRX3: "Cr24", a version, the header's length, the header, then an ordinary zip
  if (crx.subarray(0, 4).toString() !== "Cr24") throw new Error(`${name}: not an extension package`);
  const zip = join(dir, `${name}.zip`);
  writeFileSync(zip, crx.subarray(12 + crx.readUInt32LE(8)));
  execFileSync("unzip", ["-qo", zip, "-d", out]);
  return out;
}

const WALLETS: { name: string; id: string; guarded: string[]; gap: string[] }[] = [
  { name: "phantom", id: "bfnaelmomeimhlpmgjnjophhpkkoljpa", guarded: ["standard:Phantom", "solana", "phantom.solana"], gap: [] },
  // window.solflare is frozen, and so is its place on the window: Warden cannot get in front of it
  { name: "solflare", id: "bhhhlbepdkbapadjdnnojkbgioiodbic", guarded: ["standard:Solflare"], gap: ["solflare"] },
  { name: "backpack", id: "aflkmfhebedbjioipglgcbcmnbpgliof", guarded: ["standard:Backpack", "backpack", "backpack.solana"], gap: [] },
];
const text = [...new TextEncoder().encode("Sign in to the test shop\nnonce: 1234")];

describe.each(WALLETS)("Warden in front of the real $name", (wallet) => {
  describe.each([["Warden loaded first", true], ["the wallet loaded first", false]])("%s", (_order, wardenFirst) => {
    let site: Site, browser: Browser, page: Page, prompt: Prompt, version = "";
    beforeAll(async () => {
      const path = await fetchWallet(wallet.name, wallet.id);
      version = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")).version;
      site = await serve();
      browser = await launch(wardenFirst ? [WARDEN, path] : [path, WARDEN]);
      await new Promise((r) => setTimeout(r, 2500)); // the wallet's own worker starts
      page = await browser.ctx.newPage();
      await page.goto(`${site.origin}/`);
      await page.waitForFunction(() => !!(window as any).__app);
      await page.waitForTimeout(3000); // wallets that load their script from a tag
      prompt = await Prompt.on(page);
    }, 180_000);
    afterAll(async () => { await browser?.close(); site?.server.close(); });

    it("registers once and breaks nothing on the page", async () => {
      const label = wallet.guarded[0]!.slice(9);
      console.log(`${wallet.name} ${version}`);
      expect(await page.evaluate((n) => (window as any).__app.names().includes(n), label)).toBe(true);
      expect(await page.evaluate(() => (window as any).__errors)).toEqual([]);
    });

    it.each(wallet.guarded)("asks before a message reaches the wallet through %s", async (door) => {
      await page.evaluate(([d, t]) => (window as any).__app.start(d, d, "msg", t), [door, text] as const);
      const shown = await prompt.text(6000);
      expect(shown?.sentence).toContain("Sign in to the test shop");
      await prompt.click("Cancel");
      expect(await settled(page, door)).toBe("WardenRejected");
    });

    it("blocks a sign-in for another site before it reaches the wallet", async () => {
      const door = wallet.guarded[0]!; // the Wallet Standard door
      const has = await page.evaluate((n) => (window as any).__app.names().includes(n), door.slice(9));
      expect(has).toBe(true);
      await page.evaluate((d) => (window as any).__app.start("signin", d, "signin", { domain: "app.realbank.example", statement: "Sign in" }), door);
      const shown = await prompt.text(6000);
      expect(shown?.tag).toBe("Lamport Warden · Blocked");
      expect(shown?.sentence).toMatch(/would sign you in to app\.realbank\.example, a different site\.$/);
      await prompt.click("Close");
      expect(await settled(page, "signin")).toBe("WardenRejected");
    });

    it("hands an approved request on to the wallet's own code", async () => {
      // No wallet is set up, so the wallet will refuse or open its own window: either way the answer is the
      // wallet's, not Warden's, which shows the call went through the guarded method intact.
      const door = wallet.guarded[0]!;
      await page.evaluate(([d, t]) => (window as any).__app.start("through", d, "msg", t), [door, text] as const);
      expect((await prompt.text(6000))?.sentence).toContain("Sign in to the test shop");
      await prompt.click("Continue to wallet");
      await page.waitForTimeout(2500);
      const outcome = await page.evaluate(() => (window as any).__results.through);
      console.log(`${wallet.name}: after Continue the wallet answered "${outcome}"`);
      expect(outcome).not.toBe("WardenRejected");
      expect(await prompt.shown()).toBe(false);
    });

    it.each(wallet.gap)("known gap: %s goes to the wallet without Warden", async (door) => {
      await page.evaluate(([d, t]) => (window as any).__app.start(d, d, "msg", t), [door, text] as const);
      expect(await prompt.text(2000)).toBeNull(); // when this fails the gap has closed: move the door to `guarded`
    });
  });
});
