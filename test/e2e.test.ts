/**
 * The three parts together, as they load: the page-world script wraps a wallet, the isolated-world script
 * prompts, the background worker judges and keeps the history, and the first two find each other through the
 * handshake. Runs in Node with a window, a storage area, a message bus and just enough of a document for the
 * prompt. test/browser runs the built extension in Chromium.
 */
import "../src/polyfill.js";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { OwnerMemory } from "../pincer1/daemon/src/warden/index.js";

const owner = Keypair.fromSeed(new Uint8Array(32).fill(7));
const friend = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey;
const stranger = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;
const OWNER = owner.publicKey.toBase58();
const account = { address: OWNER };
const pay = (to: PublicKey, sol: number) => new Transaction({ feePayer: owner.publicKey, recentBlockhash: "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x" })
  .add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: to, lamports: Math.round(sol * 1e9) })).serialize({ requireAllSignatures: false, verifySignatures: false });

/** Enough of an element for the prompt: it remembers its children and its listeners. */
function el(): any {
  const e: any = { className: "", textContent: "", value: "", disabled: false, children: [] as any[], listeners: {} as Record<string, Function[]>, removed: false };
  e.append = (...c: any[]) => { e.children.push(...c); };
  e.addEventListener = (t: string, f: Function) => { (e.listeners[t] ??= []).push(f); };
  e.setAttribute = () => {};
  e.attachShadow = () => e;
  e.remove = () => { e.removed = true; };
  e.focus = () => {};
  return e;
}
const all = (root: any): any[] => [root, ...root.children.flatMap((c: any) => all(c))];

let storage: Record<string, unknown>;
let root: any;

function world() {
  storage = {};
  root = el();
  const win = new EventTarget() as any;
  win.CustomEvent = CustomEvent;
  vi.stubGlobal("window", win);
  vi.stubGlobal("location", { origin: "https://shop.example" });
  vi.stubGlobal("document", { createElement: () => el(), documentElement: root });
  // chrome.runtime as far as the two halves use it: a message from the page's tab, answered now or later
  const listeners: ((m: unknown, sender: unknown, respond: (r: unknown) => void) => unknown)[] = [];
  const sender = { id: "warden", tab: { id: 1 }, origin: "https://shop.example" };
  vi.stubGlobal("chrome", {
    runtime: {
      id: "warden",
      onMessage: { addListener: (f: (typeof listeners)[number]) => { listeners.push(f); } },
      sendMessage: (m: unknown) => new Promise((resolve) => {
        let later = false;
        for (const l of listeners) if (l(structuredClone(m), sender, resolve) === true) later = true;
        if (!later) resolve(undefined);
      }),
      openOptionsPage: async () => {},
    },
    storage: { local: {
      get: async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in storage).map((x) => [x, storage[x]])),
      set: async (o: Record<string, unknown>) => { Object.assign(storage, o); },
    } },
  });
  return win;
}

/** A wallet and an app meeting through the Wallet Standard events, after the extension has loaded. */
function connect(win: any) {
  const calls: Uint8Array[] = [];
  const wallet = { name: "Fake", accounts: [account], features: { "solana:signTransaction": { version: "1.0.0", signTransaction: async (...inputs: any[]) => { calls.push(...inputs.map((i) => i.transaction)); return inputs.map((i) => ({ signedTransaction: i.transaction })); } } } };
  let seen: any;
  win.addEventListener("wallet-standard:register-wallet", (e: any) => e.detail({ register: (w: any) => { seen = w; return () => {}; } }));
  win.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api: any) => api.register(wallet) }));
  return { calls, wallet: seen as typeof wallet, raw: wallet };
}

const tick = (n = 6) => new Promise<void>((r) => { let i = 0; const go = () => (++i >= n ? r() : setTimeout(go, 0)); go(); });
const prompts = () => all(root).filter((e) => e.className === "card" && !all(root).some((h) => h.removed && all(h).includes(e)));
const button = (text: string) => all(root).filter((e) => e.textContent === text).at(-1);
const trusted = { isTrusted: true }, scripted = { isTrusted: false };

async function knownFriend() {
  const m = new OwnerMemory();
  m.recordConfirmedSend({ destinations: [friend.toBase58()], lamports: 500_000_000n, solDest: friend.toBase58(), programs: [], at: 1 });
  storage[`memory:${OWNER}`] = m.toJSON();
}

describe.each([["content script first", ["background", "content", "inpage"]], ["page script first", ["background", "inpage", "content"]]])("the extension in a page (%s)", (_name, order) => {
  let win: any;
  beforeEach(async () => {
    vi.resetModules();
    win = world();
    for (const m of order) await import(`../src/${m}.ts`);
  });

  it("wraps the wallet, lets a familiar payment through silently, and remembers it once signed", async () => {
    await knownFriend();
    const { calls, wallet, raw } = connect(win);
    expect(wallet).toBe(raw); // the wallet's own object, guarded where it stands
    const out = await wallet.features["solana:signTransaction"].signTransaction({ account, transaction: pay(friend, 0.2) });
    expect(out).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(prompts()).toHaveLength(0);
    await tick();
    expect((storage[`memory:${OWNER}`] as any).counterparties[friend.toBase58()].timesPaid).toBe(2);
  });

  it("holds a first payment until a person continues, and a scripted click does not count", async () => {
    const { calls, wallet } = connect(win);
    const signing = wallet.features["solana:signTransaction"].signTransaction({ account, transaction: pay(stranger, 0.1) });
    await tick();
    expect(calls).toHaveLength(0);
    const go = button("Continue to wallet");
    expect(go).toBeDefined();
    expect(all(root).some((e) => /You've never paid/.test(e.textContent))).toBe(true);
    go.listeners.click[0](scripted);
    await tick();
    expect(calls).toHaveLength(0); // the page clicking for the owner changes nothing
    go.listeners.click[0](trusted);
    await signing;
    expect(calls).toHaveLength(1);
    await tick();
    expect((storage[`memory:${OWNER}`] as any).counterparties[stranger.toBase58()].timesPaid).toBe(1);
  });

  it("never passes a blocked request to the wallet and offers no way to continue", async () => {
    await knownFriend();
    const fake = new PublicKey(Buffer.from((BigInt("0x" + Buffer.from(friend.toBytes()).toString("hex")) + 707281n * (1n << 80n)).toString(16).padStart(64, "0"), "hex"));
    const { calls, wallet } = connect(win);
    const signing = wallet.features["solana:signTransaction"].signTransaction({ account, transaction: pay(fake, 0.2) });
    const failed = signing.then(() => "signed", (e: Error) => e.name);
    await tick();
    expect(button("Continue to wallet")).toBeUndefined();
    expect(all(root).some((e) => /address poisoning/.test(e.textContent))).toBe(true);
    button("Close").listeners.click[0](trusted);
    expect(await failed).toBe("WardenRejected");
    expect(calls).toHaveLength(0);
    await tick();
    expect((storage[`memory:${OWNER}`] as any).counterparties[fake.toBase58()]).toBeUndefined();
  });

  it("cannot be answered by the page: a forged reply or a forged 'signed' is not heard", async () => {
    const { calls, wallet } = connect(win);
    const heard: string[] = [];
    // a page can listen for the public handshake names and say hello itself; the secret is not repeated
    win.addEventListener("lamport-warden:handshake", (e: any) => heard.push(String(e.detail)));
    win.addEventListener("lamport-warden:handshake", (e: any) => heard.push(String(e.detail)), true);
    win.dispatchEvent(new CustomEvent("lamport-warden:hello"));
    const signing = wallet.features["solana:signTransaction"].signTransaction({ account, transaction: pay(stranger, 0.1) });
    await tick();
    for (const name of ["lw:reply", "lw::r", "lamport-warden:reply"]) win.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify({ id: "x", ok: true }) }));
    for (const name of ["lw:done", "lw::d"]) win.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify({ id: "x", signed: true }) }));
    await tick();
    expect(calls).toHaveLength(0);
    expect(storage[`memory:${OWNER}`]).toBeUndefined();
    expect(heard).toEqual([]);
    button("Cancel").listeners.click[0](trusted);
    await expect(signing).rejects.toMatchObject({ name: "WardenRejected" });
  });
});
