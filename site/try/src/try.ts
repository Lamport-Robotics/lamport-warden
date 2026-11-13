/**
 * The "Try Warden" page. It makes a practice wallet, puts it on the page the way a real wallet extension
 * does, and then behaves like a site: it asks that wallet to sign the requests in scenarios.ts.
 *
 * The page is both the wallet and the site, so it knows two things no real site knows: whether the wallet
 * was ever asked, and how the request ended. That is what it reports under each button. It never looks
 * inside Warden: with Warden in the browser, the request is stopped or shown before the wallet hears of it,
 * and the page sees only that the wallet was not asked.
 *
 * Nothing is sent anywhere. The key is made here, kept in memory, and gone when the page is.
 */
import "../../../src/polyfill.js"; // first: the Solana library's number encoding expects Node's Buffer to be there
import { getWallets } from "@wallet-standard/app";
import { registerWallet } from "@wallet-standard/wallet";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { PAGE_ASKS, WARDEN_ANSWERS, type PageAnswer } from "../../../src/sentinel-link.js";
import { SCENARIOS, WILL, resultText, type Ask, type Scenario } from "./scenarios.js";

const NAME = "Practice wallet";
const $ = (id: string) => document.getElementById(id)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = ""): HTMLElementTagNameMap[K] => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };

// ---- the practice wallet

const key = Keypair.generate();
const friend = Keypair.generate().publicKey; // whoever the practice payments go to
const address = key.publicKey.toBase58();
const account = Object.freeze({ address, publicKey: key.publicKey.toBytes(), chains: ["solana:mainnet"] as const, features: ["solana:signTransaction", "solana:signMessage", "solana:signIn"] as const });

/** How many requests have reached the wallet. Warden stopping one means this does not move. */
let reached = 0;

/** An ed25519 signature by the practice key, or zeros in a browser that cannot make one: nothing ever checks it. */
async function signBytes(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    const pkcs8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...key.secretKey.slice(0, 32)]);
    const k = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, k, bytes as BufferSource));
  } catch {
    return new Uint8Array(64);
  }
}

const practiceWallet = {
  version: "1.0.0" as const,
  name: NAME,
  // a plain grey disc: this is not any real wallet, and should not look like one
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTQiIGZpbGw9IiM4ODgiLz48L3N2Zz4=" as const,
  chains: ["solana:mainnet"] as const,
  accounts: [account],
  features: {
    "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
    "standard:events": { version: "1.0.0", on: () => () => {} },
    "solana:signTransaction": {
      version: "1.0.0", supportedTransactionVersions: ["legacy", 0],
      signTransaction: async (...inputs: { transaction: Uint8Array }[]) => inputs.map((i) => {
        reached += 1;
        const tx = VersionedTransaction.deserialize(i.transaction);
        tx.sign([key]);
        return { signedTransaction: tx.serialize() };
      }),
    },
    "solana:signMessage": {
      version: "1.0.0",
      signMessage: async (...inputs: { message: Uint8Array }[]) => Promise.all(inputs.map(async (i) => { reached += 1; return { signedMessage: i.message, signature: await signBytes(i.message), signatureType: "ed25519" }; })),
    },
    "solana:signIn": {
      version: "1.0.0",
      signIn: async (...inputs: { domain?: string; statement?: string }[]) => Promise.all(inputs.map(async (i) => {
        reached += 1;
        // the text a wallet writes for a sign-in: the site it names is in the first line
        const signedMessage = new TextEncoder().encode(`${i?.domain ?? location.host} wants you to sign in with your Solana account:\n${address}${i?.statement ? `\n\n${i.statement}` : ""}`);
        return { account, signedMessage, signature: await signBytes(signedMessage), signatureType: "ed25519" };
      })),
    },
  },
};
registerWallet(practiceWallet as never);

// ---- the site: finds the wallet the way any site does, which is where Warden stands

type AnyWallet = { name: string; accounts: readonly unknown[]; features: Record<string, any> };
const registry = getWallets();
const found = (): AnyWallet | undefined => (registry.get() as unknown as AnyWallet[]).find((w) => w.name === NAME);

async function send(ask: Ask): Promise<"signed" | "refused"> {
  const wallet = found();
  if (!wallet) return "refused";
  const acct = wallet.accounts[0];
  try {
    if (ask.kind === "tx") await wallet.features["solana:signTransaction"].signTransaction({ account: acct, chain: "solana:mainnet", transaction: ask.transaction });
    else if (ask.kind === "msg") await wallet.features["solana:signMessage"].signMessage({ account: acct, message: ask.message });
    else await wallet.features["solana:signIn"].signIn({ domain: ask.input.domain, statement: ask.input.statement, address });
    return "signed";
  } catch {
    return "refused";
  }
}

// ---- is Warden here? Asked the way the Sentinel page asks: the extension answers this site, in its top frame

let warden: { version: string } | null = null;
let waiting: ((a: PageAnswer) => void) | null = null;
window.addEventListener("message", (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const a = (e.data as Record<string, unknown> | null)?.[WARDEN_ANSWERS] as PageAnswer | undefined;
  if (a && waiting) { const w = waiting; waiting = null; w(a); }
});
function hello(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiting = null; resolve(); }, 1200);
    waiting = (a) => { clearTimeout(timer); warden = a.ok && a.type === "hello" ? { version: a.version } : null; resolve(); };
    window.postMessage({ [PAGE_ASKS]: { type: "hello" } }, location.origin);
  });
}

// ---- drawing

let paidOnce = false;
const rows = new Map<string, { li: HTMLLIElement; button: HTMLButtonElement; result: HTMLParagraphElement }>();

function unlock(): void {
  for (const s of SCENARIOS) {
    const row = rows.get(s.id)!;
    const locked = !!s.after && !paidOnce;
    row.li.classList.toggle("locked", locked);
    row.button.disabled = locked;
    row.button.title = locked ? "Let the first payment through, then try this." : "";
  }
}

async function run(s: Scenario): Promise<void> {
  const row = rows.get(s.id)!;
  for (const r of rows.values()) r.button.disabled = true;
  row.result.hidden = false;
  row.result.className = "result pending";
  row.result.textContent = warden ? "Asking the practice wallet. If Warden has something to say, it is on the screen now." : "Asking the practice wallet…";
  try {
    const before = reached;
    const ended = await send(s.build(key.publicKey, friend));
    const reachedWallet = reached > before;
    if (s.id === "pay-new" && reachedWallet && ended === "signed") paidOnce = true;
    const said = resultText(s.outcome, reachedWallet, ended, !!warden);
    row.result.className = `result ${said.kind}`;
    row.result.textContent = said.text;
  } catch {
    // the page's own fault, said as such: a button must never be left dead with nothing on the screen
    row.result.className = "result bad";
    row.result.textContent = "This page could not make that request. That is a fault in the page, not in your browser or in Warden.";
  }
  unlock();
}

function draw(): void {
  $("address").textContent = address;
  const list = $("tries");
  for (const s of SCENARIOS) {
    const li = el("li");
    const [head, tail] = WILL[s.outcome];
    const will = el("p", "", `will ${s.outcome}`);
    will.append("Warden: ", el("b", head), ` ${tail}`);
    const button = el("button", "Try it", "solid");
    button.addEventListener("click", () => { void run(s); });
    const result = el("p", "", "result");
    result.hidden = true;
    result.setAttribute("role", "status");
    li.append(el("h3", s.title), el("p", s.about, "about"), will, button, result);
    li.dataset.id = s.id;
    list.append(li);
    rows.set(s.id, { li, button, result });
  }
  unlock();
}

async function start(): Promise<void> {
  draw();
  await hello();
  const n = $("warden");
  if (warden) { n.textContent = `Warden ${(warden as { version: string }).version} is in this browser and is standing in front of the practice wallet.`; n.className = "notice good"; }
  else { n.textContent = "Warden is not in this browser. The buttons still work: you will see what a wallet is asked when nothing stands in front of it."; n.className = "notice care"; }
}

void start();
