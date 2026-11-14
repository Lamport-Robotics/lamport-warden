/**
 * The practice page's pretend thief: a page that does what a wallet-draining site does, to a wallet that
 * holds nothing, on a page that is connected to no blockchain.
 *
 * A draining site waits for a wallet to connect, looks up what that address holds, and asks it to sign all
 * of it away. This page does the same three things. It cannot look anything up (it has no connection to
 * anything), so it is told one thing in advance: whatever connects holds 310 SOL and 40,000 USDC. That is
 * what Warden's practice decoy "holds", so that there is something for the thief to go after.
 *
 * With Warden's decoy in front, the address this page is handed is the decoy's, the request it builds is
 * built against the decoy, and Warden has caught it before the practice wallet was ever asked for anything.
 *
 * Opened with "?honest" it plays the other kind of site: one that connects and asks to be paid half a SOL.
 * That is what the decoy must not get in the way of. The site passes, the practice wallet is connected in
 * the decoy's place, the site asks again, and Warden reads that request like any other.
 */
import { Buffer } from "buffer"; // a browser has none of its own
import { getWallets } from "@wallet-standard/app";
import { registerWallet } from "@wallet-standard/wallet";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const NAME = "Practice wallet";
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const usdcAccount = (wallet: PublicKey): PublicKey => PublicKey.findProgramAddressSync([wallet.toBytes(), TOKEN.toBytes(), USDC.toBytes()], ASSOCIATED)[0];
const u64 = (n: bigint): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };

// ---- the practice wallet: a real key that holds nothing, made for this visit and forgotten with the tab

const key = Keypair.generate();
const address = key.publicKey.toBase58();
const account = Object.freeze({ address, publicKey: key.publicKey.toBytes(), chains: ["solana:mainnet"], features: ["solana:signTransaction"] });
/** How often the wallet itself was reached: connected, or asked to sign. */
let connected = 0, askedToSign = 0;
let listeners: ((change: { accounts: readonly unknown[] }) => void)[] = [];
const practiceWallet = {
  version: "1.0.0",
  name: NAME,
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iNCIgZmlsbD0iIzg4OCIvPjwvc3ZnPg==",
  chains: ["solana:mainnet"],
  accounts: [] as unknown[],
  features: {
    "standard:connect": {
      version: "1.0.0",
      connect: async () => { connected += 1; practiceWallet.accounts = [account]; for (const l of listeners) l({ accounts: practiceWallet.accounts }); return { accounts: practiceWallet.accounts }; },
    },
    "standard:events": {
      version: "1.0.0",
      on: (_event: string, listener: (change: { accounts: readonly unknown[] }) => void) => { listeners.push(listener); return () => { listeners = listeners.filter((l) => l !== listener); }; },
    },
    "solana:signTransaction": {
      version: "1.0.0",
      supportedTransactionVersions: ["legacy", 0],
      // it holds nothing and this page sends nothing: a signature here goes nowhere
      signTransaction: async (...inputs: { transaction: Uint8Array }[]) => inputs.map((i) => { askedToSign += 1; const tx = Transaction.from(i.transaction); tx.partialSign(key); return { signedTransaction: tx.serialize() }; }),
    },
  },
};
registerWallet(practiceWallet as never);

// ---- the thief: finds the wallet the way any site does, which is where Warden stands

type AnyWallet = { name: string; accounts: readonly { address: string }[]; features: Record<string, any> };
const found = (): AnyWallet | undefined => (getWallets().get() as unknown as AnyWallet[]).find((w) => w.name === NAME);

/** Where the thief keeps what it takes. */
const THIEF = Keypair.generate().publicKey;
/** What the thief believes whoever connects is holding (see the top of this file). */
const HOLDS = { lamports: 310_000_000_000n, usdc: 40_000_000_000n };
// never sent, so any recent-looking blockhash will do
const BLOCKHASH = "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x";

/** Everything the victim holds, to the thief, in one transaction: all but a little of its SOL, and all of its USDC. */
function takeEverything(victim: PublicKey): Uint8Array {
  const transferChecked = new TransactionInstruction({
    programId: TOKEN,
    keys: [
      { pubkey: usdcAccount(victim), isSigner: false, isWritable: true }, { pubkey: USDC, isSigner: false, isWritable: false },
      { pubkey: usdcAccount(THIEF), isSigner: false, isWritable: true }, { pubkey: victim, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(Uint8Array.of(12, ...u64(HOLDS.usdc), 6)),
  });
  const tx = new Transaction({ feePayer: victim, recentBlockhash: BLOCKHASH })
    .add(SystemProgram.transfer({ fromPubkey: victim, toPubkey: THIEF, lamports: HOLDS.lamports - 10_000_000n }), transferChecked);
  return new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

/** What an ordinary site asks for: half a SOL, to its own address. */
const SHOP = Keypair.generate().publicKey;
const payHalf = (payer: PublicKey): Uint8Array => new Uint8Array(new Transaction({ feePayer: payer, recentBlockhash: BLOCKHASH }).add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: SHOP, lamports: 500_000_000n })).serialize({ requireAllSignatures: false, verifySignatures: false }));

function say(text: string, kind: "good" | "bad" | "plain" | "pending"): void {
  const r = $("result");
  r.hidden = false;
  r.className = `result ${kind}`;
  r.textContent = text;
}

async function rob(): Promise<void> {
  const button = $<HTMLButtonElement>("claim");
  button.disabled = true;
  say("Connecting…", "pending");
  /** The address this page was handed when it connected. */
  let handed = "";
  try {
    const wallet = found();
    if (!wallet) { say("This page could not find its own practice wallet. That is a fault in the page.", "bad"); return; }
    const { accounts } = await wallet.features["standard:connect"].connect();
    const victim = accounts[0] as { address: string };
    handed = victim.address;
    $("victim").textContent = `Connected: ${victim.address}`;
    say("Connected. The thief is asking that wallet to sign everything away. If Warden has something to say, it is on the screen now.", "pending");
    await wallet.features["solana:signTransaction"].signTransaction({ account: victim, chain: "solana:mainnet", transaction: takeEverything(new PublicKey(victim.address)) });
    // signed: nothing stood in the way
    say(victim.address === address
      ? "Your practice wallet signed it. On a real site, with a real wallet, 310 SOL and 40,000 USDC would be gone. Nothing stood in front of the wallet."
      : "Something signed it. That should not be possible: tell us.", "bad");
  } catch {
    if (connected === 0 && askedToSign === 0 && handed && handed !== address) say(`Stopped. The address this page was handed was a decoy's (${short(handed)}), not the practice wallet's. The thief asked the decoy for everything, Warden saw it, and the practice wallet was never connected or asked for anything.`, "good");
    else if (askedToSign === 0) say("Stopped before the practice wallet signed anything. The thief did learn the practice wallet's address: a decoy would have kept that from it too.", "plain");
    else say("The request was refused.", "plain");
  } finally {
    button.disabled = connected === 0 && askedToSign === 0; // a page that was caught gets nothing more: reload to try again
    if (button.disabled) $("again").hidden = false;
  }
}

/** The honest site: connect, ask to be paid, and when the wallet's account changes under it, ask again of the one that is there. */
async function shop(): Promise<void> {
  const button = $<HTMLButtonElement>("pay");
  button.disabled = true;
  say("Connecting…", "pending");
  try {
    const wallet = found();
    if (!wallet) { say("This page could not find its own practice wallet. That is a fault in the page.", "bad"); return; }
    const { accounts } = await wallet.features["standard:connect"].connect();
    let payer = accounts[0] as { address: string };
    const first = payer.address;
    $("victim").textContent = `Connected: ${payer.address}`;
    say("Connected. The site is asking that wallet for half a SOL. If Warden has something to say, it is on the screen now.", "pending");
    const ask = () => wallet.features["solana:signTransaction"].signTransaction({ account: payer, chain: "solana:mainnet", transaction: payHalf(new PublicKey(payer.address)) });
    try { await ask(); } catch (e) {
      // the wallet's account changed while the site was asking: what it built was for the old one, so it builds again
      const now = found()?.accounts[0];
      if (!now || now.address === payer.address) throw e;
      payer = now;
      $("victim").textContent = `Connected: ${payer.address}`;
      say("The wallet's account changed. The site is asking the one that is there now.", "pending");
      await ask();
    }
    say(first !== address && payer.address === address
      ? `Signed by the practice wallet. The site was handed a decoy (${short(first)}) first; what it asked the decoy for was ordinary, so the practice wallet took the decoy's place, the site asked again, and Warden read that request like any other.`
      : "Signed by the practice wallet. No decoy was shown first: Warden is not in this browser, or is an older version.", first !== address ? "good" : "plain");
  } catch {
    say(askedToSign === 0 ? "Not signed. The request was stopped, or you chose not to go on." : "The request was refused.", "plain");
  } finally {
    button.disabled = false;
  }
}

$("address").textContent = address;
const honest = new URLSearchParams(location.search).has("honest");
$("thief").hidden = honest;
$("honest").hidden = !honest;
$("claim").addEventListener("click", () => { void rob(); });
$("pay").addEventListener("click", () => { void shop(); });
