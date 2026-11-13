/**
 * Warden and Sentinel's own transactions. The instructions come from sentinel/vectors/instructions.json,
 * which the program's own test suite writes and runs through the compiled program: what is recognised here
 * is what the program really takes.
 */
import "../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { judge, recordSigned, type Store } from "../src/judge.js";
import { ARMING_ORIGIN, DISCRIMINATORS, SENTINEL_PROGRAM, configAddress, delegateAddress, type SentinelState } from "../src/sentinel.js";
import type { MemoryState } from "../pincer1/daemon/src/warden/index.js";

const V = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "sentinel", "vectors", "instructions.json"), "utf8"));
const owner = Keypair.fromSeed(new Uint8Array(32).fill(7));
const OWNER = owner.publicKey.toBase58();
const BLOCKHASH = "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x";
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ELSEWHERE = "https://free-airdrop.example";
const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey;

/** An instruction of the vector file, as web3.js holds one. */
const ix = (name: string): TransactionInstruction => {
  const v = V.instructions[name];
  return new TransactionInstruction({ programId: new PublicKey(v.programId), keys: v.accounts.map((a: any) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })), data: Buffer.from(v.data, "hex") });
};
const tx = (ixs: TransactionInstruction[], feePayer = owner.publicKey) => new Transaction({ feePayer, recentBlockhash: BLOCKHASH }).add(...ixs).serialize({ requireAllSignatures: false, verifySignatures: false });
/** approve_checked of `amount` on a token account of the owner's, to `delegate`. */
const approve = (delegate: PublicKey, n = 0, amount = 2n ** 64n - 1n) => {
  const data = Buffer.alloc(10); data[0] = 13; data.writeBigUInt64LE(amount, 1); data[9] = 6;
  return new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: key(100 + n), isSigner: false, isWritable: true }, { pubkey: key(150 + n), isSigner: false, isWritable: false }, { pubkey: delegate, isSigner: false, isWritable: false }, { pubkey: owner.publicKey, isSigner: true, isWritable: false }], data });
};

function stores(initial?: SentinelState) {
  const memory = new Map<string, MemoryState>();
  const sentinel = new Map<string, SentinelState>();
  if (initial) sentinel.set(OWNER, initial);
  const store: Store = {
    load: async (o) => memory.get(o), save: async (o, s) => { memory.set(o, s); }, ringSites: async () => [],
    sentinel: async (o) => sentinel.get(o), saveSentinel: async (o, s) => { if (s === null) sentinel.delete(o); else sentinel.set(o, s); },
  };
  return { store, sentinel };
}
const ask = async (bytes: Uint8Array, origin: string, state?: SentinelState) => (await judge({ kind: "tx", bytes, owner: OWNER }, origin, stores(state).store)).verdict;

describe("what Warden knows of the program", () => {
  it("has the program's id, its instruction discriminators and its addresses right", () => {
    expect(SENTINEL_PROGRAM).toBe(V.program);
    for (const [name, d] of Object.entries(DISCRIMINATORS)) expect(d, name).toBe(createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex"));
    expect(configAddress(OWNER)).toBe(V.config);
    expect(delegateAddress(OWNER, V.vault)).toBe(V.delegate);
    expect(delegateAddress(OWNER, V.vault2)).toBe(V.delegate2);
    expect(OWNER).toBe(V.owner);
  });
});

describe("arming, on the Sentinel page", () => {
  it("explains the real setup transaction and asks for the end of the vault's address, where the engine alone blocks it", async () => {
    const setup = tx([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ix("init_config"), ix("approve_checked"), approve(new PublicKey(V.delegate), 1)]);
    const v = await ask(setup, ARMING_ORIGIN);
    expect(v.level).toBe("confirm");
    expect(v.confirm).toEqual({ kind: "last4", expect: V.vault.slice(-4) });
    expect(v.sentence).toBe(`Sets up Warden Sentinel for this wallet. In a rescue, your tokens can go only to the Lamport Vault ${V.vault.slice(0, 4)}…${V.vault.slice(-4)}. It arms 2 token accounts. Changing that vault later takes 72 hours.`);
    expect((await ask(tx([ix("init_config_with_delay_24h")]), ARMING_ORIGIN)).sentence).toMatch(/takes 24 hours\.$/);

    // the approval alone, anywhere, is what the engine exists to stop
    const bare = await ask(tx([ix("approve_checked")]), ELSEWHERE);
    expect(bare.level).toBe("block");
    expect(bare.reasons.join(" ")).toMatch(/unlimited permission to spend/);
  });

  it("remembers the vault only once the setup is signed, and then recognises later batches of approvals", async () => {
    const { store, sentinel } = stores();
    const later = tx([approve(new PublicKey(V.delegate), 2), approve(new PublicKey(V.delegate), 3), approve(new PublicKey(V.delegate), 4)]);
    // before any setup this browser has seen: an unlimited approval to a plain address, blocked
    expect((await judge({ kind: "tx", bytes: later, owner: OWNER }, ARMING_ORIGIN, store)).verdict.level).toBe("block");

    const setup = await judge({ kind: "tx", bytes: tx([ix("init_config"), ix("approve_checked")]), owner: OWNER }, ARMING_ORIGIN, store);
    expect(sentinel.size).toBe(0); // looking is not signing
    await recordSigned(setup, store, 1_794_000_000);
    expect(sentinel.get(OWNER)).toEqual({ vault: V.vault });

    const batch = (await judge({ kind: "tx", bytes: later, owner: OWNER }, ARMING_ORIGIN, store)).verdict;
    expect(batch.level).toBe("explain");
    expect(batch.sentence).toBe(`Arms 3 token accounts for Warden Sentinel: it may move them into your Lamport Vault ${V.vault.slice(0, 4)}…${V.vault.slice(-4)}, and nowhere else.`);
    // the same batch from another site is not Sentinel's business: the engine blocks it
    expect((await judge({ kind: "tx", bytes: later, owner: OWNER }, ELSEWHERE, store)).verdict.level).toBe("block");
  });

  it("still blocks the same shape with anything in it that is not Sentinel's", async () => {
    const state = { vault: V.vault };
    const blocked = async (ixs: TransactionInstruction[], why: RegExp) => {
      const v = await ask(tx(ixs), ARMING_ORIGIN, state);
      expect(v.level, v.sentence).toBe("block");
      expect(`${v.sentence} ${v.reasons.join(" ")}`).toMatch(why);
    };
    // a delegate one byte off
    const off = new PublicKey(V.delegate).toBytes(); off[31] ^= 1;
    await blocked([ix("init_config"), approve(new PublicKey(off))], /another address than Sentinel's/);
    await blocked([approve(new PublicKey(off))], /unlimited permission/);
    // the delegate of another vault, and of another owner
    await blocked([ix("init_config"), approve(new PublicKey(V.delegate2))], /another address than Sentinel's/);
    await blocked([approve(new PublicKey(delegateAddress(key(50).toBase58(), V.vault)))], /unlimited permission/);
    // the same bytes sent to another program id
    const clone = ix("init_config"); clone.programId = key(60);
    await blocked([clone, ix("approve_checked")], /unlimited permission|not executable|unknown|haven't approved/);
    // setup for someone else's config
    const other = ix("init_config"); other.keys[1] = { pubkey: new PublicKey(configAddress(key(50).toBase58())), isSigner: false, isWritable: true };
    await blocked([other], /not in a form I know/);
    // setup with a transfer tucked in beside it, or with the rescuer swapped in the same breath
    await blocked([ix("init_config"), ix("approve_checked"), SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: key(70), lamports: 5 })], /not in a form I know/);
    await blocked([ix("init_config"), ix("set_rescuers_own")], /not in a form I know/);
    // a batch of approvals with one for somebody else among them
    await blocked([approve(new PublicKey(V.delegate)), approve(key(80))], /unlimited permission/);
    // an administrator's instruction
    const admin = ix("cancel_proposal"); admin.data = Buffer.concat([Buffer.from(DISCRIMINATORS.update_rescuer_set!, "hex"), Buffer.from([0, 0, 0, 0, 0])]);
    await blocked([admin], /administrator's instruction/);
    // bytes that are no instruction of the program
    const junk = ix("cancel_proposal"); junk.data = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    await blocked([junk], /not in a form I know/);
  });
});

describe("from any other site", () => {
  it.each(["init_config", "propose_vault", "accept_vault", "cancel_proposal", "set_rescuers_own", "set_rescuers_lamport_set", "close_config", "rescue_token_by_owner"])("blocks %s", async (name) => {
    for (const origin of [ELSEWHERE, "https://warden.lamportrobotics.com.evil.example", "http://warden.lamportrobotics.com", "https://lamportrobotics.com", ""]) {
      const v = await ask(tx([ix(name)]), origin, { vault: V.vault });
      expect(v.level, origin).toBe("block");
      expect(v.sentence).toMatch(/Only the Sentinel page at warden\.lamportrobotics\.com does that\.$/);
    }
  });

  it("blocks the real setup pointed at a thief's vault and rescuer, which is how the real program would drain a wallet", async () => {
    const v = await ask(tx([ix("init_config"), ix("approve_checked"), ix("set_rescuers_own")]), ELSEWHERE);
    expect(v.level).toBe("block");
  });
});

describe("changing Sentinel, on its page", () => {
  it("asks for the end of the new vault's address before proposing or accepting it, and remembers what was signed", async () => {
    const { store, sentinel } = stores({ vault: V.vault });
    const propose = await judge({ kind: "tx", bytes: tx([ix("propose_vault")]), owner: OWNER }, ARMING_ORIGIN, store);
    expect(propose.verdict).toMatchObject({ level: "confirm", confirm: { kind: "last4", expect: V.vault2.slice(-4) } });
    expect(propose.verdict.sentence).toMatch(/^Proposes a new vault for Warden Sentinel: .{4}….{4} instead of .{4}….{4}\./);
    await recordSigned(propose, store, 1);
    expect(sentinel.get(OWNER)).toEqual({ vault: V.vault, pendingVault: V.vault2 });

    // while it waits, arming is still for the current vault
    expect((await judge({ kind: "tx", bytes: tx([approve(new PublicKey(V.delegate))]), owner: OWNER }, ARMING_ORIGIN, store)).verdict.level).toBe("explain");
    expect((await judge({ kind: "tx", bytes: tx([approve(new PublicKey(V.delegate2))]), owner: OWNER }, ARMING_ORIGIN, store)).verdict.level).toBe("block");

    const accept = await judge({ kind: "tx", bytes: tx([ix("accept_vault")]), owner: OWNER }, ARMING_ORIGIN, store);
    expect(accept.verdict).toMatchObject({ level: "confirm", confirm: { kind: "last4", expect: V.vault2.slice(-4) } });
    await recordSigned(accept, store, 2);
    expect(sentinel.get(OWNER)).toEqual({ vault: V.vault2 });
    // now it is the new vault's delegate that arms, and the old one's that is refused
    expect((await judge({ kind: "tx", bytes: tx([approve(new PublicKey(V.delegate2))]), owner: OWNER }, ARMING_ORIGIN, store)).verdict.level).toBe("explain");
    expect((await judge({ kind: "tx", bytes: tx([approve(new PublicKey(V.delegate))]), owner: OWNER }, ARMING_ORIGIN, store)).verdict.level).toBe("block");
  });

  it("explains the smaller changes, and asks before a key of the owner's own may trigger rescues or Sentinel is turned off", async () => {
    const state = { vault: V.vault };
    expect(await ask(tx([ix("cancel_proposal")]), ARMING_ORIGIN, state)).toMatchObject({ level: "explain" });
    expect(await ask(tx([ix("set_rescuers_lamport_set")]), ARMING_ORIGIN, state)).toMatchObject({ level: "explain" });
    expect(await ask(tx([ix("set_rescuers_own")]), ARMING_ORIGIN, state)).toMatchObject({ level: "confirm", confirm: { kind: "last4", expect: V.ownRescuer.slice(-4) } });
    expect(await ask(tx([ix("rescue_token_by_owner")]), ARMING_ORIGIN, state)).toMatchObject({ level: "explain", sentence: expect.stringMatching(/^Moves the tokens of 1 token account you armed into your Lamport Vault /) });

    const { store, sentinel } = stores(state);
    const close = await judge({ kind: "tx", bytes: tx([ix("close_config")]), owner: OWNER }, ARMING_ORIGIN, store);
    expect(close.verdict).toMatchObject({ level: "confirm", confirm: { kind: "acknowledge" } });
    await recordSigned(close, store, 3);
    expect(sentinel.has(OWNER)).toBe(false);
  });

  it("records nothing for a request that was blocked", async () => {
    const { store, sentinel } = stores();
    const v = await judge({ kind: "tx", bytes: tx([ix("init_config")]), owner: OWNER }, ELSEWHERE, store);
    await recordSigned(v, store, 1);
    expect(sentinel.size).toBe(0);
  });
});

describe("the SOL ladder", () => {
  const nonce = key(31), rescuer = key(32);
  // signed by the owner now, paid for and sent by the rescuer later
  const rung = (to: PublicKey, lamports: number, extra: TransactionInstruction[] = [], authority = owner.publicKey) =>
    tx([SystemProgram.nonceAdvance({ noncePubkey: nonce, authorizedPubkey: authority }), SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: to, lamports }), ...extra], rescuer);

  it("explains a pre-signed transfer to the owner's own vault, where the engine alone refuses it", async () => {
    const state = { vault: V.vault };
    const v = await ask(rung(new PublicKey(V.vault), 9_000_000_000), ARMING_ORIGIN, state);
    expect(v.level).toBe("explain");
    expect(v.sentence).toBe(`Signs, for later, a transfer of 9 SOL to your Lamport Vault ${V.vault.slice(0, 4)}…${V.vault.slice(-4)}. Sentinel keeps it and can send it only in a rescue; it can go nowhere else. It stays valid until that nonce is used.`);
    // the engine's own reading of the same bytes
    const engine = await ask(rung(new PublicKey(V.vault), 9_000_000_000), ELSEWHERE, state);
    expect(engine.level).not.toBe("allow");
    expect(engine.level).not.toBe("explain");
  });

  it("leaves to the engine anything that is not exactly that", async () => {
    const state = { vault: V.vault };
    const notRecognised = async (bytes: Uint8Array, known = true) => {
      const v = await ask(bytes, ARMING_ORIGIN, known ? state : undefined);
      expect(v.sentence).not.toMatch(/Sentinel keeps it/);
      expect(["confirm", "block"]).toContain(v.level);
    };
    await notRecognised(rung(key(90), 9_000_000_000));                                       // to another address
    await notRecognised(rung(new PublicKey(V.vault2), 9_000_000_000));                       // to a vault that is not the owner's configured one
    await notRecognised(rung(new PublicKey(V.vault), 9_000_000_000), false);                 // before this browser saw any setup
    await notRecognised(rung(new PublicKey(V.vault), 9_000_000_000, [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: key(91), lamports: 1 })])); // with a second transfer
    await notRecognised(rung(new PublicKey(V.vault), 9_000_000_000, [], key(92)));           // a nonce someone else controls
  });
});
