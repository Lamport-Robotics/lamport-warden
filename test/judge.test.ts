import "../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { judge, recordSigned, type Store } from "../src/judge.js";
import type { MemoryState } from "../pincer1/daemon/src/warden/index.js";

const owner = Keypair.fromSeed(new Uint8Array(32).fill(7));
const friend = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey;
const OWNER = owner.publicKey.toBase58();
const BLOCKHASH = "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x";
const NOW = 1_794_000_000;

/** An unsigned transaction as a page hands it to a wallet. */
const tx = (...ixs: TransactionInstruction[]) => new Transaction({ feePayer: owner.publicKey, recentBlockhash: BLOCKHASH }).add(...ixs).serialize({ requireAllSignatures: false, verifySignatures: false });
const pay = (to: PublicKey, sol: number) => SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: to, lamports: Math.round(sol * 1e9) });
const lookalike = (of: PublicKey) => new PublicKey(Buffer.from((BigInt("0x" + Buffer.from(of.toBytes()).toString("hex")) + 707281n * (1n << 80n)).toString(16).padStart(64, "0"), "hex"));

function memoryStore(sites: string[] = []) {
  const saved = new Map<string, MemoryState>();
  const store: Store = { load: async (o) => saved.get(o), save: async (o, s) => { saved.set(o, s); }, ringSites: async () => sites };
  return { store, saved };
}

describe("judging a request in the extension", () => {
  it("explains a first payment, remembers it only once it is signed, and is silent the next time", async () => {
    const { store, saved } = memoryStore();
    const first = await judge({ kind: "tx", bytes: tx(pay(friend, 0.5)), owner: OWNER }, "https://shop.example", store);
    expect(first.verdict.level).toBe("explain");
    expect(first.verdict.sentence).toMatch(/^From shop\.example: Sends 0\.5 SOL to .* You've never paid /);
    expect(saved.size).toBe(0); // looking is not paying
    await recordSigned(first, store, NOW);
    expect(saved.get(OWNER)!.counterparties[friend.toBase58()]!.timesPaid).toBe(1);
    const second = await judge({ kind: "tx", bytes: tx(pay(friend, 0.2)), owner: OWNER }, "https://shop.example", store);
    expect(second.verdict.level).toBe("allow");
  });

  it("blocks a look-alike of an address the owner has paid, and records nothing for it", async () => {
    const { store, saved } = memoryStore();
    await recordSigned(await judge({ kind: "tx", bytes: tx(pay(friend, 0.5)), owner: OWNER }, "https://shop.example", store), store, NOW);
    const fake = lookalike(friend);
    const v = await judge({ kind: "tx", bytes: tx(pay(fake, 0.5)), owner: OWNER }, "https://shop.example", store);
    expect(v.verdict.level).toBe("block");
    expect(v.verdict.sentence).toMatch(/address poisoning/);
    await recordSigned(v, store, NOW + 1);
    expect(saved.get(OWNER)!.counterparties[fake.toBase58()]).toBeUndefined();
  });

  it("keeps each wallet's history apart", async () => {
    const { store } = memoryStore();
    await recordSigned(await judge({ kind: "tx", bytes: tx(pay(friend, 0.5)), owner: OWNER }, "https://a.example", store), store, NOW);
    const other = Keypair.fromSeed(new Uint8Array(32).fill(3));
    const bytes = new Transaction({ feePayer: other.publicKey, recentBlockhash: BLOCKHASH }).add(SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: friend, lamports: 1e8 })).serialize({ requireAllSignatures: false, verifySignatures: false });
    const v = await judge({ kind: "tx", bytes, owner: other.publicKey.toBase58() }, "https://a.example", store);
    expect(v.verdict.sentence).toMatch(/You've never paid/);
  });

  it("says what a Privacy Rings deposit makes public", async () => {
    const { store } = memoryStore();
    const amount = [...new Uint8Array(new BigUint64Array([2_000_000_000n]).buffer)];
    const deposit = new TransactionInstruction({ programId: new PublicKey("ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW"), keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([15, 1, 0, 1, 0, ...owner.publicKey.toBytes(), ...new Uint8Array(32).fill(9), ...amount, 0]) });
    const v = await judge({ kind: "tx", bytes: tx(deposit), owner: OWNER }, "https://rings.example", store);
    expect(v.verdict).toMatchObject({ level: "explain", sentence: "Deposits 2 SOL into your Privacy Rings balance. The deposit and its amount are public." });
  });

  it("does not guess: unreadable bytes are blocked, and a request that names no account needs a confirmation", async () => {
    const { store } = memoryStore();
    expect((await judge({ kind: "tx", bytes: Uint8Array.of(1, 2, 3), owner: OWNER }, "https://x.example", store)).verdict.level).toBe("block");
    expect((await judge({ kind: "tx", bytes: new Uint8Array(0), owner: OWNER }, "https://x.example", store)).verdict.level).toBe("block");
    const anon = await judge({ kind: "tx", bytes: tx(pay(friend, 0.1)), owner: "" }, "https://x.example", store);
    expect(anon.verdict).toMatchObject({ level: "confirm", confirm: { kind: "acknowledge" } });
    const notMine = await judge({ kind: "tx", bytes: tx(pay(friend, 0.1)), owner: friend.toBase58() }, "https://x.example", store);
    expect(notMine.verdict.level).toBe("block");
  });

  it("blocks the Privacy Rings key request unless the owner allowed the site, and blocks unreadable messages", async () => {
    const derive = new Uint8Array([0xff, ...Buffer.from("solana offchain"), 0, ...Buffer.from("1d32a88533af12d35e5ac6fce817a4cb810bcc4115386b14a78e8b2ef09d864c", "hex"), 0, 1, ...owner.publicKey.toBytes(), 14, 0, ...Buffer.from("TSPP/derive/v1")]);
    const plain = memoryStore();
    const blocked = await judge({ kind: "msg", bytes: derive, owner: OWNER }, "https://drainer.example", plain.store);
    expect(blocked.verdict.level).toBe("block");
    expect(blocked.verdict.sentence).toMatch(/^drainer\.example is asking for the signature that unlocks your Privacy Rings keys/);
    const allowed = await judge({ kind: "msg", bytes: derive, owner: OWNER }, "https://rings.example", memoryStore(["https://rings.example"]).store);
    expect(allowed.verdict.level).toBe("confirm");
    const digest = new Uint8Array(32).map((_, i) => (i * 29 + 3) & 255);
    expect((await judge({ kind: "msg", bytes: digest, owner: OWNER }, "https://x.example", plain.store)).verdict.level).toBe("block");
    const signIn = await judge({ kind: "msg", bytes: new TextEncoder().encode("Sign in to example.org\nnonce: 1"), owner: OWNER }, "https://example.org", plain.store);
    expect(signIn.verdict.level).toBe("explain");
    // a signed message is never a payment: nothing is recorded
    await recordSigned(signIn, plain.store, NOW);
    expect(plain.saved.size).toBe(0);
  });
});
