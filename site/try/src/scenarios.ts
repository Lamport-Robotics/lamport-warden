/**
 * The requests the "Try Warden" page makes of its practice wallet. Each is the kind of thing a real site
 * asks a real wallet to sign, built exactly as that site would build it, and none is ever sent anywhere.
 *
 * Nothing here but the building of bytes, so that a test can hand every one to the engine and check that
 * what the page promises ("Warden stops this") is what Warden does.
 */
import { Buffer } from "buffer"; // a browser has none of its own
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

/** What the page says Warden will do. */
export type Outcome =
  /** Nothing is shown: the request goes straight to the wallet. */
  | "quiet"
  /** One sentence and two buttons before the wallet is asked. */
  | "asks"
  /** Stopped, with the reason. The wallet is never asked. */
  | "stops";

export type Ask =
  | { kind: "tx"; transaction: Uint8Array }
  | { kind: "msg"; message: Uint8Array }
  | { kind: "signin"; input: { domain: string; statement: string } };

export interface Scenario {
  id: string;
  title: string;
  /** What a site would be doing, in one or two sentences. */
  about: string;
  outcome: Outcome;
  /** Offered only after the first payment was let through: it depends on the wallet having paid someone. */
  after?: "pay-new";
  build(wallet: PublicKey, friend: PublicKey): Ask;
}

// never sent, so any recent-looking blockhash will do
const BLOCKHASH = "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x";
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const LAMPORTS = 1_000_000_000;

const serialize = (wallet: PublicKey, ...instructions: TransactionInstruction[]): Uint8Array =>
  new Uint8Array(new Transaction({ feePayer: wallet, recentBlockhash: BLOCKHASH }).add(...instructions).serialize({ requireAllSignatures: false, verifySignatures: false }));
const pay = (wallet: PublicKey, to: PublicKey, sol: number): Uint8Array => serialize(wallet, SystemProgram.transfer({ fromPubkey: wallet, toPubkey: to, lamports: Math.round(sol * LAMPORTS) }));
/** The wallet's own USDC account: where its USDC would be. */
const usdcAccount = (wallet: PublicKey): PublicKey => PublicKey.findProgramAddressSync([wallet.toBytes(), TOKEN.toBytes(), USDC.toBytes()], ASSOCIATED)[0];
const u64 = (n: bigint): Uint8Array => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };

/**
 * An address that starts and ends like `of` and differs in the middle: what "address poisoning" plants in a
 * wallet's history, hoping the owner copies it by its first and last characters.
 */
export function lookalike(of: PublicKey): PublicKey {
  const n = BigInt(`0x${[...of.toBytes()].map((b) => b.toString(16).padStart(2, "0")).join("")}`) + 707281n * (1n << 80n);
  const hex = (n % (1n << 256n)).toString(16).padStart(64, "0");
  return new PublicKey(Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16))));
}

/** Someone the page makes up, different for each scenario: a site's address, a stranger's wallet. */
const stranger = (n: number): PublicKey => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i * 31 + n * 97 + 11) % 256));

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "pay-new",
    title: "Pay someone for the first time",
    about: "A site asks the wallet to send 0.5 SOL to an address it has never paid.",
    outcome: "asks",
    build: (wallet, friend) => ({ kind: "tx", transaction: pay(wallet, friend, 0.5) }),
  },
  {
    id: "pay-again",
    title: "Pay the same address again",
    about: "The same payment, to the address you just let through. This is most of what a wallet signs.",
    outcome: "quiet",
    after: "pay-new",
    build: (wallet, friend) => ({ kind: "tx", transaction: pay(wallet, friend, 0.5) }),
  },
  {
    id: "lookalike",
    title: "Pay an address that only looks like it",
    about: "An address that starts and ends like the one you paid, and is someone else's. Thieves plant these in a wallet's history and wait for a copy and paste.",
    outcome: "stops",
    after: "pay-new",
    build: (wallet, friend) => ({ kind: "tx", transaction: pay(wallet, lookalike(friend), 0.5) }),
  },
  {
    id: "approve",
    title: "Let a stranger spend your USDC",
    about: "A site asks for an approval with no limit over the wallet's USDC account. Signing it moves nothing today and lets the stranger take everything later.",
    outcome: "stops",
    build: (wallet) => ({
      kind: "tx",
      transaction: serialize(wallet, new TransactionInstruction({
        programId: TOKEN,
        keys: [{ pubkey: usdcAccount(wallet), isSigner: false, isWritable: true }, { pubkey: stranger(1), isSigner: false, isWritable: false }, { pubkey: wallet, isSigner: true, isWritable: false }],
        data: Buffer.from([4, ...u64((1n << 64n) - 1n)]), // Approve, every unit there could ever be
      })),
    }),
  },
  {
    id: "handover",
    title: "Hand your USDC account to someone else",
    about: "One instruction that makes a stranger the owner of the wallet's USDC account. Wallets show it as a line of program names.",
    outcome: "stops",
    build: (wallet) => ({
      kind: "tx",
      transaction: serialize(wallet, new TransactionInstruction({
        programId: TOKEN,
        keys: [{ pubkey: usdcAccount(wallet), isSigner: false, isWritable: true }, { pubkey: wallet, isSigner: true, isWritable: false }],
        data: Buffer.from([6, 2, 1, ...stranger(2).toBytes()]), // SetAuthority, AccountOwner, to the stranger
      })),
    }),
  },
  {
    id: "signin-relay",
    title: "Sign in to a site you are not on",
    about: "This page asks for a sign-in signature that names another site. Whoever collects it can sign in there as you.",
    outcome: "stops",
    build: () => ({ kind: "signin", input: { domain: "app.example-exchange.com", statement: "Sign in to continue." } }),
  },
  {
    id: "tx-as-message",
    title: "A payment dressed up as a message",
    about: "A site asks the wallet to sign a \"message\" whose bytes are a transaction that sends 2 SOL to a stranger. A message signature costs nothing to ask for and looks harmless.",
    outcome: "stops",
    build: (wallet) => ({ kind: "msg", message: new Uint8Array(Transaction.from(pay(wallet, stranger(3), 2)).serializeMessage()) }),
  },
  {
    id: "plain-message",
    title: "An ordinary message",
    about: "A site asks the wallet to sign a line of text to prove the wallet is yours. Nothing is wrong with it, and Warden shows you the words first.",
    outcome: "asks",
    build: () => ({ kind: "msg", message: new TextEncoder().encode("I am the owner of this wallet. Signed for the Warden practice page.") }),
  },
];

/** What the page says Warden will do, beside each button: a short verdict and what it means. */
export const WILL: Record<Outcome, [string, string]> = {
  quiet: ["Says nothing.", "It goes straight to the wallet."],
  asks: ["Asks first.", "One sentence and two buttons before the wallet is asked."],
  stops: ["Stops it.", "The wallet is never asked."],
};

/** What happened, in a sentence, and whether that is what should have happened. */
export function resultText(outcome: Outcome, reachedWallet: boolean, ended: "signed" | "refused", withWarden: boolean): { text: string; kind: "good" | "bad" | "plain" } {
  if (!withWarden) {
    if (!reachedWallet) return { text: "The request did not reach the practice wallet.", kind: "plain" };
    const without = "Nothing stood in between: Warden is not in this browser.";
    if (outcome === "stops") return { text: `The practice wallet was asked, and it signed. ${without} A real wallet would have shown its own prompt, and this is the kind of request people approve. With Warden it is stopped before the wallet hears of it.`, kind: "bad" };
    if (outcome === "asks") return { text: `The practice wallet was asked, and it signed. ${without} With Warden you would have read one sentence about it first.`, kind: "plain" };
    return { text: `The practice wallet was asked, and it signed. ${without} Warden would not have interrupted this one either.`, kind: "plain" };
  }
  if (outcome === "stops") {
    return reachedWallet
      ? { text: "The practice wallet was asked to sign this, and Warden should have stopped it. Please tell us: support@lamportrobotics.com.", kind: "bad" }
      : { text: "Stopped. The practice wallet was never asked.", kind: "good" };
  }
  if (outcome === "asks") {
    return reachedWallet
      ? { text: "You read Warden's sentence and continued, so the practice wallet was asked, and it signed. Nothing was sent.", kind: "good" }
      : { text: "You cancelled, so the practice wallet was never asked.", kind: "good" };
  }
  return reachedWallet && ended === "signed"
    ? { text: "Warden read it, had nothing to say, and passed it on. The practice wallet signed. Nothing was sent.", kind: "good" }
    : { text: "The practice wallet was not asked. If Warden showed you something, it is because this wallet has not paid that address before in this browser.", kind: "plain" };
}
