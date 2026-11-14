/**
 * The rescue program's instructions, built the way the program reads them. The Sentinel page uses these to
 * arm a wallet (the owner signs), and the rescuer uses them to move tokens into the owner's vault.
 *
 * Nothing here decides where tokens go. The program computes the destination on chain from the owner's own
 * configuration; an instruction built with any other account in that place is refused there. These builders
 * are checked, byte for byte and account for account, against sentinel/vectors/instructions.json, which the
 * program's own test suite writes after running each instruction through the compiled program.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { DISCRIMINATORS, SENTINEL_PROGRAM } from "../../../src/sentinel.js";

export const PROGRAM = new PublicKey(SENTINEL_PROGRAM);
export const SYSTEM = new PublicKey("11111111111111111111111111111111");
export const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const COMPUTE_BUDGET = new PublicKey("ComputeBudget111111111111111111111111111111");

const text = (s: string) => new TextEncoder().encode(s);
const pda = (seeds: Uint8Array[], program = PROGRAM) => PublicKey.findProgramAddressSync(seeds, program)[0];
const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
const data = (name: string, ...rest: Uint8Array[]) => Buffer.concat([hex(DISCRIMINATORS[name]!), ...rest]);
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const i64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, n, true); return b; };
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const key = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
const U64_MAX = 0xffff_ffff_ffff_ffffn;

/** Where an owner's Sentinel configuration lives. */
export const configAddress = (owner: PublicKey) => pda([text("config"), owner.toBytes()]);
/** The address an owner approves on a token account so that it can be rescued into `vault`, and nowhere else. */
export const delegateAddress = (owner: PublicKey, vault: PublicKey) => pda([text("delegate"), owner.toBytes(), vault.toBytes()]);
/** Lamport's shared set of rescuer keys. */
export const rescuerSetAddress = () => pda([text("rescuers")]);
/** The vault's own token account for a mint: the only place a rescue can put that token. */
export const vaultTokenAddress = (vault: PublicKey, mint: PublicKey, tokenProgram = TOKEN) => pda([vault.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN);

/** Sets the vault rescues go to. `delaySeconds` is how long a later change of vault must wait; absent, the program's 72 hours. */
export function initConfig(owner: PublicKey, vault: PublicKey, delaySeconds?: number): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [key(owner, true, true), key(configAddress(owner), false, true), key(vault, false, false), key(SYSTEM, false, false)],
    data: data("init_config", delaySeconds === undefined ? Uint8Array.of(0) : Buffer.concat([Uint8Array.of(1), i64(BigInt(delaySeconds))])),
  });
}

/** The owner lets Sentinel's delegate for this vault move one token account. The whole balance, now and later: a rescue takes whatever is there. */
export function approveForRescue(o: { owner: PublicKey; source: PublicKey; mint: PublicKey; decimals: number; vault: PublicKey; tokenProgram?: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: o.tokenProgram ?? TOKEN,
    keys: [key(o.source, false, true), key(o.mint, false, false), key(delegateAddress(o.owner, o.vault), false, false), key(o.owner, true, false)],
    data: Buffer.concat([Uint8Array.of(13), u64(U64_MAX), Uint8Array.of(o.decimals)]), // ApproveChecked
  });
}

/**
 * Makes the vault's own token account for a mint, paid for by `payer`, and does nothing when it is there
 * already. An owner signs these at setup, so that a rescue only ever moves tokens into accounts that exist:
 * the key that rescues then never pays for one, and nobody can make it pay.
 */
export function createVaultTokenAccount(payer: PublicKey, vault: PublicKey, mint: PublicKey, tokenProgram = TOKEN): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN,
    keys: [key(payer, true, true), key(vaultTokenAddress(vault, mint, tokenProgram), false, true), key(vault, false, false), key(mint, false, false), key(SYSTEM, false, false), key(tokenProgram, false, false)],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

export const proposeVault = (owner: PublicKey, newVault: PublicKey) => new TransactionInstruction({ programId: PROGRAM, keys: [key(owner, true, false), key(configAddress(owner), false, true), key(newVault, false, false)], data: data("propose_vault") });
export const acceptVault = (owner: PublicKey, newVault: PublicKey) => new TransactionInstruction({ programId: PROGRAM, keys: [key(owner, true, false), key(configAddress(owner), false, true), key(newVault, false, false)], data: data("accept_vault") });
export const cancelProposal = (owner: PublicKey) => new TransactionInstruction({ programId: PROGRAM, keys: [key(owner, true, false), key(configAddress(owner), false, true)], data: data("cancel_proposal") });
export const closeConfig = (owner: PublicKey) => new TransactionInstruction({ programId: PROGRAM, keys: [key(owner, true, true), key(configAddress(owner), false, true)], data: data("close_config") });
/** Who may trigger a rescue besides the owner: Lamport's set, or one key the owner runs. */
export const setRescuers = (owner: PublicKey, who: { kind: "lamport" } | { kind: "own"; key: PublicKey }) =>
  new TransactionInstruction({ programId: PROGRAM, keys: [key(owner, true, false), key(configAddress(owner), false, true)], data: data("set_rescuers", who.kind === "lamport" ? Uint8Array.of(0) : Buffer.concat([Uint8Array.of(1), who.key.toBytes()])) });

/**
 * Moves everything in one of the owner's token accounts into the vault's token account for that mint.
 * `rescuer` signs and pays for that account if it does not exist yet. `viaSet`: the signer is one of
 * Lamport's set, so the set is shown to the program; otherwise the place it would go holds the program's own
 * address, which is how the program is told "none".
 */
export function rescueToken(o: { rescuer: PublicKey; owner: PublicKey; vault: PublicKey; mint: PublicKey; source: PublicKey; tokenProgram?: PublicKey; viaSet: boolean }): TransactionInstruction {
  const tokenProgram = o.tokenProgram ?? TOKEN;
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      key(o.rescuer, true, true), key(configAddress(o.owner), false, false), key(delegateAddress(o.owner, o.vault), false, false),
      key(o.viaSet ? rescuerSetAddress() : PROGRAM, false, false), key(o.vault, false, false), key(o.mint, false, false),
      key(o.source, false, true), key(vaultTokenAddress(o.vault, o.mint, tokenProgram), false, true),
      key(tokenProgram, false, false), key(ASSOCIATED_TOKEN, false, false), key(SYSTEM, false, false),
    ],
    data: data("rescue_token"),
  });
}

const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** Where the loader keeps the program's code and its upgrade authority. */
export const programDataAddress = () => pda([PROGRAM.toBytes()], UPGRADEABLE_LOADER);

/**
 * Makes Lamport's shared set of rescuer keys. Once, by the program's upgrade authority. `admin` is who may
 * replace the keys afterwards; a key in the set can move an owner's armed tokens into that owner's vault and
 * do nothing else.
 */
export function initRescuerSet(authority: PublicKey, admin: PublicKey, rescuers: PublicKey[]): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [key(authority, true, true), key(rescuerSetAddress(), false, true), key(PROGRAM, false, false), key(programDataAddress(), false, false), key(SYSTEM, false, false)],
    data: data("init_rescuer_set", admin.toBytes(), u32(rescuers.length), ...rescuers.map((r) => r.toBytes())),
  });
}

// ---- planning a rescue

/** One of the owner's token accounts, as the chain shows it. */
export interface Holding {
  address: string; mint: string; tokenProgram: string;
  /** In the token's smallest units. */
  amount: bigint; decimals: number;
  delegate: string | null; delegatedAmount: bigint;
  frozen: boolean;
  /**
   * True for a token that cannot be moved by a plain transfer, or not safely: one that is not transferable at
   * all, or one whose issuer runs a program of its own on every transfer (which could refuse a rescue, or
   * refuse the vault's owner when they take it out again). Left out of a setup and of a rescue.
   */
  unmovable?: boolean;
}

/**
 * Which accounts a rescue can move, biggest first. Only an account that still names Sentinel's delegate for
 * this vault, with something in it, not frozen, and of a token a plain transfer moves: anything else the
 * program or the token would refuse, and a refused instruction fails the whole transaction it rides in.
 * `worth` puts a value on a holding so that the most valuable goes first; without it, the largest count of
 * whole tokens does, which is only a guess across different tokens.
 */
export function planRescue(holdings: Holding[], owner: PublicKey, vault: PublicKey, worth?: (h: Holding) => number): Holding[] {
  const delegate = delegateAddress(owner, vault).toBase58();
  const value = worth ?? ((h: Holding) => Number(h.amount) / 10 ** h.decimals);
  return holdings.filter((h) => h.delegate === delegate && h.delegatedAmount > 0n && h.amount > 0n && !h.frozen && !h.unmovable).sort((a, b) => value(b) - value(a));
}

/**
 * The instructions of each transaction of a rescue, in the order to send them. A few accounts per
 * transaction, so one that fails does not hold back the rest, with a priority fee: a rescue is a race.
 */
export function rescueInstructions(plan: Holding[], o: { rescuer: PublicKey; owner: PublicKey; vault: PublicKey; viaSet: boolean; perTransaction?: number; microLamportsPerUnit?: number }): TransactionInstruction[][] {
  const per = Math.max(1, Math.min(o.perTransaction ?? 3, 5));
  const out: TransactionInstruction[][] = [];
  for (let i = 0; i < plan.length; i += per) {
    const batch = plan.slice(i, i + per);
    out.push([
      new TransactionInstruction({ programId: COMPUTE_BUDGET, keys: [], data: Buffer.concat([Uint8Array.of(2), u32(120_000 * batch.length)]) }),
      new TransactionInstruction({ programId: COMPUTE_BUDGET, keys: [], data: Buffer.concat([Uint8Array.of(3), u64(BigInt(o.microLamportsPerUnit ?? 50_000))]) }),
      ...batch.map((h) => rescueToken({ rescuer: o.rescuer, owner: o.owner, vault: o.vault, mint: new PublicKey(h.mint), source: new PublicKey(h.address), tokenProgram: new PublicKey(h.tokenProgram), viaSet: o.viaSet })),
    ]);
  }
  return out;
}
