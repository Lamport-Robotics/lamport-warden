/**
 * The Chrome Web Store screenshots (1280 x 800), taken from the built extension: pnpm shots.
 * Not a test of anything. The page behind the prompt is a plain stand-in for a dapp.
 */
import { afterAll, beforeAll, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Prompt, WALLETS, WARDEN, launch, serve, type Browser, type Site } from "../browser/harness.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "store", "screenshots");
const owner = Keypair.fromSeed(new Uint8Array(32).fill(7));
const me = owner.publicKey.toBase58();
const BLOCKHASH = "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x";
const person = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;
const lookalike = (of: PublicKey) => new PublicKey(Buffer.from((BigInt("0x" + Buffer.from(of.toBytes()).toString("hex")) + 707281n * (1n << 80n)).toString(16).padStart(64, "0"), "hex"));
const pay = (to: PublicKey, sol: number) => [...new Transaction({ feePayer: owner.publicKey, recentBlockhash: BLOCKHASH }).add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: to, lamports: Math.round(sol * 1e9) })).serialize({ requireAllSignatures: false, verifySignatures: false })];

/** A plain dapp-like page behind the prompt, so the screenshot shows where Warden appears. */
const DRESS = `document.body.innerHTML = '<div style="font:16px/1.5 system-ui,sans-serif;color:#d8dbe2;background:#11141b;min-height:100vh;margin:0;padding:28px 40px"><div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:18px">Example Swap</b><span style="border:1px solid #2c3340;border-radius:999px;padding:8px 14px;font-size:13px">GmaD…AEGB</span></div><div style="max-width:440px;margin:90px auto 0;background:#181c26;border:1px solid #262c38;border-radius:18px;padding:22px"><div style="color:#8b93a3;font-size:13px">You pay</div><div style="font-size:30px;margin:4px 0 18px">1.00 SOL</div><div style="color:#8b93a3;font-size:13px">You receive</div><div style="font-size:30px;margin:4px 0 22px">150.00 USDC</div><div style="background:#5b7cfa;color:#fff;border-radius:12px;padding:13px;text-align:center;font-weight:600">Swap</div></div></div>'; document.body.style.margin = "0";`;

let site: Site, browser: Browser;
beforeAll(async () => { mkdirSync(out, { recursive: true }); site = await serve(); browser = await launch([WARDEN, WALLETS]); });
afterAll(async () => { await browser?.close(); site?.server.close(); });

const worker = () => browser.ctx.serviceWorkers().find((w) => w.url().endsWith("/background.js"))!;
/** Writes to the extension's storage, waiting out the moment a just-started worker has no chrome.storage yet. */
async function store(values: Record<string, unknown>) {
  for (let i = 0; ; i++) {
    try { await worker().evaluate((v) => chrome.storage.local.set(v), values); return; } catch (e) { if (i > 20) throw e; await new Promise((r) => setTimeout(r, 250)); }
  }
}
const open = async () => {
  const page = await browser.ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${site.origin}/`);
  await page.waitForFunction(() => !!(window as any).__app);
  await page.evaluate(DRESS);
  return { page, prompt: await Prompt.on(page) };
};

it("1: a look-alike address, blocked", async () => {
  const friend = person(11);
  const address = friend.toBase58();
  await store({ [`memory:${me}`]: { version: 1, counterparties: { [address]: { address, timesPaid: 6, totalLamports: "3200000000", maxLamports: "1000000000", firstSeen: 1790000000, lastSeen: 1794000000 } }, programs: {}, recentLamports: ["500000000", "1000000000", "400000000", "300000000", "500000000", "500000000"] } });
  const { page, prompt } = await open();
  await page.evaluate(([t]) => (window as any).__app.start("s", "standard:FixturePhantom", "tx", t), [pay(lookalike(friend), 0.5)] as const);
  await prompt.text(8000);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, "1-blocked-look-alike.png") });
  await page.close();
});

it("2: a swap, with what a simulation showed", async () => {
  const DEX = person(170), pool = person(171), usdcAccount = person(172);
  const SYSTEM = "11111111111111111111111111111111";
  site.setChain(
    { [me]: { lamports: 3_000_000_000, owner: SYSTEM, data: ["", "base64"] } },
    { [me]: { lamports: 1_997_955_720, owner: SYSTEM, data: ["", "base64"] }, [usdcAccount.toBase58()]: { lamports: 2_039_280, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { program: "spl-token", space: 165, parsed: { type: "account", info: { isNative: false, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: me, state: "initialized", tokenAmount: { amount: "150000000", decimals: 6 } } } } } },
  );
  await store({ rpcUrl: `${site.origin}/rpc`, simulate: true });
  const swap = [...new Transaction({ feePayer: owner.publicKey, recentBlockhash: BLOCKHASH }).add(new TransactionInstruction({ programId: DEX, keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }, { pubkey: pool, isSigner: false, isWritable: true }, { pubkey: usdcAccount, isSigner: false, isWritable: true }], data: Buffer.from([1, 2, 3]) })).serialize({ requireAllSignatures: false, verifySignatures: false })];
  const { page, prompt } = await open();
  await page.evaluate(([t]) => (window as any).__app.start("s", "standard:FixturePhantom", "tx", t), [swap] as const);
  await prompt.text(8000);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, "2-swap-simulated.png") });
  await page.close();
});

it("3: the settings page", async () => {
  await store({ rpcUrl: "https://api.mainnet-beta.solana.com", simulate: false, ringSites: [] });
  const page = await browser.ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`chrome-extension://${browser.extensionId}/options.html`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, "3-settings.png") });
  await page.close();
});

it("4: the practice page, with a request stopped", async () => {
  // The page as it is deployed, so that it is drawn with the site's own type and mark. It needs the network,
  // and the practice page to be up; the other three do not.
  const plain = await launch([WARDEN]);
  try {
    const page = await plain.ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("https://warden.lamportrobotics.com/try/", { waitUntil: "networkidle" });
    await page.locator("#warden.good").waitFor({ timeout: 15_000 });
    const prompt = await Prompt.on(page);
    await page.locator('#tries li[data-id="approve"] button').click();
    await prompt.text(8000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(out, "4-practice-page.png") });
    await page.close();
  } finally {
    await plain.close();
  }
}, 60_000);
