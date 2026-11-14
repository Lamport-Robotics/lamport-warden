/**
 * Warden Sentinel's own transactions, read for what they are.
 *
 * Arming Sentinel asks the owner to do the two things Warden exists to stop: give an address that is not a
 * program unlimited permission to spend tokens, and sign transfers on a durable nonce that someone else will
 * send later. The engine blocks both, and should. This file recognises the exact shapes Sentinel uses and
 * says what they do instead.
 *
 * "Exact" carries the weight. A site that dresses its own approval up as "Sentinel setup" must get nothing:
 *   - Nothing here reads a name, a memo or any text. The delegate is derived from the pinned program id, the
 *     owner and the vault, and compared as an address.
 *   - A transaction is recognised only when every instruction in it is one of the expected ones. One stray
 *     instruction and the engine's verdict stands.
 *   - Any call to the Sentinel program from a site other than the arming page is blocked, whatever it is: the
 *     real program, pointed at a thief's vault and a thief's rescuer key, is a way to drain a wallet.
 *   - Setting Sentinel up names a vault, and whoever holds that vault's 24 words receives every rescue. Warden
 *     cannot know whose vault it is, so the owner retypes the end of its address, even on the arming page.
 *
 * The delegate is ["delegate", owner, vault] (sentinel/program/README.md). The vault comes from the
 * init_config in the same transaction, or from what this browser saw the owner set up before. A browser that
 * saw nothing (the wallet was set up from another one) reads the setup from the chain, and then asks for the
 * end of the vault's address again, as it does at setup: it is the first time this browser has shown it.
 *
 * This lives in the extension, not in the engine, so the engine pinned from Pincer1 does not move.
 */
import { PublicKey } from "@solana/web3.js";
import type { ParsedInstruction, ParsedTx } from "../pincer1/daemon/src/tx/parse.js";
import type { WardenVerdict } from "../pincer1/daemon/src/warden/index.js";
import { fmtSol } from "../pincer1/daemon/src/tx/explain.js";

/** lamport-sentinel on devnet. There is no mainnet program. */
export const SENTINEL_PROGRAM = "DHM2wm7S5Q4AzfzNFJV85tN3htUpYYEw38CdUApW6crK";
import { ARMING_ORIGIN } from "./defaults.js";
export { ARMING_ORIGIN };

const SYSTEM = "11111111111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
const DEFAULT_DELAY_HOURS = 72;

/** Anchor's `sha256("global:<name>")[..8]` for each instruction of the program (checked in test/sentinel.test.ts). */
export const DISCRIMINATORS: Record<string, string> = {
  init_config: "17eb73e8a86001e7",
  propose_vault: "a5ea784f735935a4",
  accept_vault: "4782611a828aca7e",
  cancel_proposal: "6a4a809213412717",
  set_rescuers: "4e08f83696fc6a03",
  close_config: "9109489d5f7d3d55",
  rescue_token: "e3f8a895a5501459",
  init_rescuer_set: "380ce9c1c0d38d0f",
  update_rescuer_set: "a8e6b0805e3b26ed",
};

/** What this browser knows of an owner's Sentinel setup, from the transactions it saw them sign. */
export interface SentinelState {
  /** The vault rescues go to. */
  vault: string;
  /** A vault proposed to replace it, not yet accepted. */
  pendingVault?: string;
}

export function sentinelStateFrom(stored: unknown): SentinelState | undefined {
  const s = stored as Partial<SentinelState> | null;
  if (!s || typeof s !== "object" || typeof s.vault !== "string" || !isAddress(s.vault)) return undefined;
  return { vault: s.vault, ...(typeof s.pendingVault === "string" && isAddress(s.pendingVault) ? { pendingVault: s.pendingVault } : {}) };
}

export type SentinelReading =
  /** Nothing of Sentinel's here, or not exactly one of its shapes: the engine's verdict stands. */
  | { kind: "none" }
  /** A Sentinel transaction. `after` is what to remember once it is signed: a state, or null to forget. */
  | { kind: "verdict"; verdict: WardenVerdict; after?: SentinelState | null };

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const last4 = (a: string) => a.slice(-4);
const isAddress = (s: string): boolean => { try { return new PublicKey(s).toBase58() === s; } catch { return false; } };
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

const pda = (seeds: (string | Uint8Array)[]): string =>
  PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === "string" ? new PublicKey(s).toBytes() : s)), new PublicKey(SENTINEL_PROGRAM))[0].toBase58();
const text = (s: string) => new TextEncoder().encode(s);

export const configAddress = (owner: string): string => pda([text("config"), owner]);
/** The address an owner approves on a token account so that it can be rescued into `vault`. */
export const delegateAddress = (owner: string, vault: string): string => pda([text("delegate"), owner, vault]);

const u64 = (d: Uint8Array, at: number): bigint | null => (at + 8 <= d.length ? new DataView(d.buffer, d.byteOffset + at, 8).getBigUint64(0, true) : null);
const i64 = (d: Uint8Array, at: number): bigint | null => (at + 8 <= d.length ? new DataView(d.buffer, d.byteOffset + at, 8).getBigInt64(0, true) : null);

/** Which Sentinel instruction this is, by its discriminator; null for bytes that are none of them. */
function nameOf(ix: ParsedInstruction): string | null {
  const d = hex(ix.data.subarray(0, 8));
  return Object.keys(DISCRIMINATORS).find((n) => DISCRIMINATORS[n] === d) ?? null;
}

/** A token `Approve` or `ApproveChecked` signed by the owner: the delegate and the amount. */
function approvalOf(ix: ParsedInstruction, owner: string): { delegate: string; amount: bigint } | null {
  if (!TOKEN_PROGRAMS.has(ix.program)) return null;
  const tag = ix.data[0];
  // Approve: [source, delegate, owner]; ApproveChecked: [source, mint, delegate, owner]. No multisig forms.
  const [delegate, authority, n] = tag === 4 ? [ix.accounts[1], ix.accounts[2], 3] : tag === 13 ? [ix.accounts[2], ix.accounts[3], 4] : [undefined, undefined, 0];
  const amount = u64(ix.data, 1);
  if (!delegate || authority !== owner || ix.accounts.length !== n || amount === null) return null;
  if (ix.data.length !== (tag === 4 ? 9 : 10)) return null;
  return { delegate, amount };
}

/**
 * True for a request from the arming page that is token approvals and nothing else: the one request whose
 * meaning depends on a setup this browser may never have seen, and for which the chain is worth asking.
 */
export function approvalsFromArmingPage(parsed: ParsedTx, owner: string, origin: string): boolean {
  if (origin !== ARMING_ORIGIN || parsed.unresolvedLookups) return false;
  const rest = parsed.instructions.filter((i) => i.program !== COMPUTE_BUDGET);
  return rest.length > 0 && rest.every((i) => approvalOf(i, owner) !== null);
}

/**
 * The vault an owner's Sentinel setup names, from the bytes of the account at their config address. Null for
 * anything that is not that owner's setup: the account has to be the Sentinel program's, and has to name the
 * owner it is being read for.
 */
export function vaultOfConfig(account: { owner: string; data: Uint8Array } | null, owner: string): string | null {
  // 8 discriminator, version, bump, owner, vault
  if (!account || account.owner !== SENTINEL_PROGRAM || account.data.length < 74) return null;
  try {
    if (new PublicKey(account.data.subarray(10, 42)).toBase58() !== owner) return null;
    return new PublicKey(account.data.subarray(42, 74)).toBase58();
  } catch { return null; }
}

const block = (sentence: string, reason: string, parsed: ParsedTx): SentinelReading => ({ kind: "verdict", verdict: { level: "block", sentence, reasons: [reason], parsed } });

/**
 * Reads a transaction for Sentinel's shapes. `state` is what this browser remembers of the owner's setup.
 * The verdict it returns replaces the engine's.
 */
export function readSentinel(parsed: ParsedTx, owner: string, origin: string, state: SentinelState | undefined, opts: { /** `state` was read from the chain a moment ago, and this browser never showed its owner that vault. */ unseen?: boolean } = {}): SentinelReading {
  const fromArmingPage = origin === ARMING_ORIGIN;
  const calls = parsed.instructions.filter((i) => i.program === SENTINEL_PROGRAM);
  const rest = parsed.instructions.filter((i) => i.program !== SENTINEL_PROGRAM && i.program !== COMPUTE_BUDGET);

  // ── any call to the Sentinel program from somewhere else ──
  if (calls.length > 0 && !fromArmingPage) {
    return block(
      "This site is trying to set up or change Warden Sentinel for your wallet. Only the Sentinel page at warden.lamportrobotics.com does that.",
      "it calls the Sentinel program from a site that is not the Sentinel page. Pointed at someone else's vault, that program moves your tokens to them.",
      parsed,
    );
  }
  if (!fromArmingPage) return { kind: "none" };
  // accounts named through a table nobody read cannot be compared with anything
  if (parsed.unresolvedLookups) return calls.length ? block("This Sentinel request names its accounts through a table I could not read, so I can't check it.", "its accounts could not be read.", parsed) : { kind: "none" };

  const approvals = rest.map((i) => approvalOf(i, owner));
  const onlyApprovals = approvals.every((a) => a !== null);
  const malformed = (what: string) => block(`This Sentinel request is not in a form I know (${what}), so I won't pass it on.`, "it does not match any Sentinel request exactly.", parsed);

  // ── no call to the program: arming more token accounts, or one rung of the SOL ladder ──
  if (calls.length === 0) {
    if (!state) return { kind: "none" };
    const delegate = delegateAddress(owner, state.vault);
    if (rest.length > 0 && onlyApprovals && approvals.every((a) => a!.delegate === delegate)) {
      if (opts.unseen) {
        return {
          kind: "verdict",
          after: { vault: state.vault },
          verdict: {
            level: "confirm",
            sentence: `Arms ${plural(rest.length, "token account", "token accounts")} for Warden Sentinel: it may move them into the Lamport Vault ${short(state.vault)}, and nowhere else. That is the vault this wallet's Sentinel setup names; this browser has not shown it to you before.`,
            reasons: ["whoever holds that vault's 24 words receives every rescue. Check the address against your own vault before you continue."],
            confirm: { kind: "last4", expect: last4(state.vault) },
            parsed,
          },
        };
      }
      return { kind: "verdict", verdict: { level: "explain", sentence: `Arms ${plural(rest.length, "token account", "token accounts")} for Warden Sentinel: it may move them into your Lamport Vault ${short(state.vault)}, and nowhere else.`, reasons: [], parsed } };
    }
    return ladderRung(parsed, rest, owner, state);
  }

  const names = calls.map(nameOf);
  if (names.some((n) => n === null)) return malformed("an instruction it does not have");
  // every instruction the owner signs names the owner first and the owner's own config second
  const config = configAddress(owner);
  const ownerFirst = (ix: ParsedInstruction) => ix.accounts[0] === owner;

  // ── rescuing, by the owner: one call per token ──
  if (names.every((n) => n === "rescue_token")) {
    if (rest.length > 0) return malformed("a rescue with other instructions beside it");
    for (const ix of calls) if (!ownerFirst(ix) || ix.accounts[1] !== config || ix.accounts.length !== 11) return malformed("a rescue that is not for this wallet");
    const vault = calls[0]!.accounts[4]!;
    if (calls.some((ix) => ix.accounts[4] !== vault || ix.accounts[2] !== delegateAddress(owner, vault))) return malformed("a rescue with mixed-up accounts");
    return { kind: "verdict", verdict: { level: "explain", sentence: `Moves the tokens of ${plural(calls.length, "token account", "token accounts")} you armed into your Lamport Vault ${short(vault)}. Getting them back out takes the vault's 24 words.`, reasons: [], parsed } };
  }

  // everything else is one call, for this owner's config
  if (calls.length !== 1) return malformed("several changes in one transaction");
  const ix = calls[0]!;
  const name = names[0]!;
  if (name === "init_rescuer_set" || name === "update_rescuer_set") return block("This changes the keys of Lamport's own rescue service. It is not something a wallet owner is asked to sign.", "it is an administrator's instruction.", parsed);
  if (!ownerFirst(ix) || ix.accounts[1] !== config) return malformed("accounts that are not this wallet's");

  if (name === "init_config") {
    const vault = ix.accounts[2];
    if (ix.accounts.length !== 4 || !vault || ix.accounts[3] !== SYSTEM) return malformed("wrong accounts");
    // Option<i64>: 0, or 1 and the delay in seconds
    const some = ix.data[8];
    const seconds = some === 0 && ix.data.length === 9 ? BigInt(DEFAULT_DELAY_HOURS * 3600) : some === 1 && ix.data.length === 17 ? i64(ix.data, 9) : null;
    if (seconds === null || seconds < 86_400n || seconds > 2_592_000n) return malformed("a waiting time out of range");
    if (!onlyApprovals) return malformed("setup with other instructions beside it");
    const delegate = delegateAddress(owner, vault);
    if (approvals.some((a) => a!.delegate !== delegate)) return block("This looks like Warden Sentinel's setup, but one of the permissions in it goes to another address than Sentinel's for that vault.", "an approval in it is not for Sentinel's address.", parsed);
    const hours = Number(seconds / 3600n);
    const armed = rest.length ? ` It arms ${plural(rest.length, "token account", "token accounts")}.` : "";
    return {
      kind: "verdict",
      after: { vault },
      verdict: {
        level: "confirm",
        sentence: `Sets up Warden Sentinel for this wallet. In a rescue, your tokens can go only to the Lamport Vault ${short(vault)}.${armed} Changing that vault later takes ${hours} hours, or closing this setup and making another.`,
        reasons: ["whoever holds that vault's 24 words receives every rescue. Check the address against your own vault before you continue."],
        confirm: { kind: "last4", expect: last4(vault) },
        parsed,
      },
    };
  }

  // the rest take no companions
  if (rest.length > 0) return malformed("a change with other instructions beside it");
  const current = state ? ` instead of ${short(state.vault)}` : "";
  switch (name) {
    case "propose_vault": {
      const next = ix.accounts[2];
      if (ix.accounts.length !== 3 || !next || ix.data.length !== 8) return malformed("wrong accounts");
      return {
        kind: "verdict",
        after: state ? { vault: state.vault, pendingVault: next } : undefined,
        verdict: {
          level: "confirm",
          sentence: `Proposes a new vault for Warden Sentinel: ${short(next)}${current}. It can take effect only after the waiting time you chose at setup; until then rescues go to the current vault.`,
          reasons: ["whoever holds the new vault's 24 words would receive every rescue. Check the address against your own vault."],
          confirm: { kind: "last4", expect: last4(next) },
          parsed,
        },
      };
    }
    case "accept_vault": {
      const next = ix.accounts[2];
      if (ix.accounts.length !== 3 || !next || ix.data.length !== 8) return malformed("wrong accounts");
      return {
        kind: "verdict",
        after: { vault: next },
        verdict: {
          level: "confirm",
          sentence: `Switches Warden Sentinel to the vault ${short(next)}. Tokens you armed for the old vault are no longer covered until you arm them again.`,
          reasons: ["from now on rescues go to this vault."],
          confirm: { kind: "last4", expect: last4(next) },
          parsed,
        },
      };
    }
    case "cancel_proposal":
      if (ix.accounts.length !== 2 || ix.data.length !== 8) return malformed("wrong accounts");
      return { kind: "verdict", after: state ? { vault: state.vault } : undefined, verdict: { level: "explain", sentence: "Drops the proposed change of vault for Warden Sentinel. Rescues keep going to your current vault.", reasons: [], parsed } };
    case "set_rescuers": {
      if (ix.accounts.length !== 2) return malformed("wrong accounts");
      if (ix.data[8] === 0 && ix.data.length === 9) return { kind: "verdict", verdict: { level: "explain", sentence: "Lets Lamport's rescue service trigger a rescue of your armed tokens into your own vault. It cannot send them anywhere else.", reasons: [], parsed } };
      if (ix.data[8] === 1 && ix.data.length === 41) {
        const key = new PublicKey(ix.data.subarray(9, 41)).toBase58();
        return { kind: "verdict", verdict: { level: "confirm", sentence: `Lets the key ${short(key)}, and no longer Lamport's service, trigger a rescue of your armed tokens into your own vault. It cannot send them anywhere else.`, reasons: ["a rescue can then be triggered by that key at any time. Getting tokens back out of the vault takes its 24 words."], confirm: { kind: "last4", expect: last4(key) }, parsed } };
      }
      return malformed("a rescuer choice I can't read");
    }
    case "close_config":
      if (ix.accounts.length !== 2 || ix.data.length !== 8) return malformed("wrong accounts");
      return { kind: "verdict", after: null, verdict: { level: "confirm", sentence: "Turns Warden Sentinel off for this wallet. Nothing can be rescued any more. The permissions on your token accounts stay until you revoke them, but nothing can use them.", reasons: ["after this, Sentinel only watches."], confirm: { kind: "acknowledge", expect: "I understand" }, parsed } };
    default:
      return malformed("an instruction that needs something else");
  }
}

/**
 * One rung of the SOL ladder: on a durable nonce the owner controls, a transfer from the owner to their own
 * vault, with nothing else in the transaction. The engine reads that as "signed now, sent whenever" and a
 * wallet being emptied, which is what it is. It is recognised only when the destination is the vault this
 * browser saw the owner set up.
 */
function ladderRung(parsed: ParsedTx, rest: ParsedInstruction[], owner: string, state: SentinelState): SentinelReading {
  if (rest.length !== 2 || rest.some((i) => i.program !== SYSTEM)) return { kind: "none" };
  const [advance, transfer] = rest as [ParsedInstruction, ParsedInstruction];
  const tag = (i: ParsedInstruction) => (i.data.length >= 4 ? new DataView(i.data.buffer, i.data.byteOffset, 4).getUint32(0, true) : -1);
  // AdvanceNonceAccount: [nonce, recent blockhashes sysvar, authority]; Transfer: [from, to], u64 lamports
  if (tag(advance) !== 4 || advance.data.length !== 4 || advance.accounts.length !== 3 || advance.accounts[2] !== owner) return { kind: "none" };
  const lamports = u64(transfer.data, 4);
  if (tag(transfer) !== 2 || transfer.data.length !== 12 || transfer.accounts.length !== 2 || transfer.accounts[0] !== owner || transfer.accounts[1] !== state.vault || lamports === null) return { kind: "none" };
  return {
    kind: "verdict",
    verdict: {
      level: "explain",
      sentence: `Signs, for later, a transfer of ${fmtSol(lamports)} to your Lamport Vault ${short(state.vault)}. Sentinel keeps it and can send it only in a rescue; it can go nowhere else. It stays valid until that nonce is used.`,
      reasons: [],
      parsed,
    },
  };
}
