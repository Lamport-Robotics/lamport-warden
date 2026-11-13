/**
 * The judging half: takes what a wallet was asked to sign and returns Warden's verdict. Pure apart from the
 * store and the table reader it is given, so it runs under test in Node. The engine itself lives in the
 * Pincer1 repo (pincer1/daemon/src/warden, a submodule pinned to one commit) and is bundled from there; it is
 * the same code the robot uses.
 */
import { PublicKey } from "@solana/web3.js";
import { OwnerMemory, checkMessage, checkTransaction, recordConfirmed, type MemoryState, type WardenVerdict } from "../pincer1/daemon/src/warden/index.js";
import { splitTransaction } from "../pincer1/daemon/src/tx/parse.js";
import { tablesNeeded, type Tables } from "./rpc.js";
import { READ_IN_FULL, wordsFor, type Simulated } from "./simulate.js";

export interface Store {
  /** The stored history of one wallet address, or undefined. */
  load(owner: string): Promise<unknown>;
  save(owner: string, state: MemoryState): Promise<void>;
  /** Sites the owner allowed to ask for the Privacy Rings key signature. */
  ringSites(): Promise<string[]>;
}

export interface JudgeRequest { kind: "tx" | "msg" | "opaque"; bytes: Uint8Array; owner: string }
export interface Judged { verdict: WardenVerdict; owner: string; kind: JudgeRequest["kind"] }
/** Reads the lookup tables a message needs. Absent: every request is judged without them. */
export type TableSource = (messageBytes: Uint8Array) => Promise<Tables>;
/**
 * Runs the transaction against the chain as it is now. Null means the owner has simulation off: nothing was
 * asked, and nothing is said about it. A failure to get an answer is different, and the owner is told.
 */
export type SimulationSource = (txBytes: Uint8Array, messageBytes: Uint8Array, owner: string, tables: Tables) => Promise<Simulated | null>;
export interface Sources { tables?: TableSource; simulate?: SimulationSource }

const ACK = { kind: "acknowledge", expect: "I understand" } as const;

export async function judge(req: JudgeRequest, origin: string, store: Store, sources: Sources = {}): Promise<Judged> {
  const { tables, simulate } = sources;
  if (req.kind === "opaque") {
    return { verdict: { level: "confirm", sentence: "This site asked your wallet to sign something in a form I can't read, so I can't tell you what it does.", reasons: ["the signing request is not in a form I know."], confirm: ACK }, owner: req.owner, kind: "opaque" };
  }
  if (req.kind === "msg") {
    let ownKey: Uint8Array | null = null;
    try { ownKey = req.owner ? new PublicKey(req.owner).toBytes() : null; } catch { ownKey = null; }
    return { verdict: checkMessage({ bytes: req.bytes, origin, ownKey, ringSites: await store.ringSites() }), owner: req.owner, kind: "msg" };
  }
  let messageBytes: Uint8Array;
  try { messageBytes = splitTransaction(req.bytes).messageBytes; } catch {
    return { verdict: { level: "block", sentence: "This is not a transaction I can read, so I can't tell you what it does.", reasons: ["it does not decode as a Solana transaction."] }, owner: req.owner, kind: "tx" };
  }
  if (!req.owner) {
    return { verdict: { level: "confirm", sentence: "The site did not say which of your accounts signs this, so I can't compare it with your history.", reasons: ["the request names no account."], confirm: ACK }, owner: "", kind: "tx" };
  }
  const memory = OwnerMemory.from(await store.load(req.owner));
  const lookupTables: Tables = tables ? await tables(messageBytes).catch((): Tables => ({})) : {};
  let verdict = checkTransaction({ bytes: messageBytes, owner: req.owner, memory, origin, privacyRings: "explain", lookupTables });
  // A program the decoder does not read in full is where the rest of the story is: ask what the whole thing would do.
  // Not for a request already blocked, and not for one made only of instructions that are read exactly.
  if (simulate && verdict.level !== "block" && verdict.parsed && verdict.parsed.programs.some((p) => !READ_IN_FULL.has(p))) {
    const sim = await simulate(req.bytes, messageBytes, req.owner, lookupTables).catch((): Simulated => ({ ok: false, why: "unavailable" }));
    if (sim) {
      const w = wordsFor(sim, { feeLamports: verdict.parsed.feeLamports, decodedLamportsOut: verdict.parsed.lamportsOut });
      const rank = { allow: 0, explain: 1, confirm: 2, block: 3 } as const;
      const level = rank[w.atLeast] > rank[verdict.level] ? w.atLeast : verdict.level;
      verdict = {
        ...verdict, level,
        sentence: `${verdict.sentence} ${w.sentence}`,
        reasons: [...w.reasons, ...verdict.reasons.filter((r) => r !== "nothing unusual." || w.reasons.length === 0)],
        // a verdict raised to "confirm" here has nothing to retype but the acknowledgement
        confirm: level === "confirm" ? verdict.confirm ?? ACK : verdict.confirm,
      };
    }
  }
  // Accounts named through a table nobody could read are accounts nobody read: say so, and never wave it through.
  const unread = [...tablesNeeded(messageBytes).keys()].filter((k) => !lookupTables[k]);
  if (unread.length && verdict.level !== "block") {
    const why = "it names some of its accounts through a lookup table I could not read, so part of it is hidden from me.";
    return { verdict: { ...verdict, level: verdict.level === "allow" ? "explain" : verdict.level, sentence: `${verdict.sentence} I could not read all of the accounts it uses.`, reasons: [...verdict.reasons.filter((r) => r !== "nothing unusual."), why] }, owner: req.owner, kind: "tx" };
  }
  return { verdict, owner: req.owner, kind: "tx" };
}

/**
 * After the owner let the request through and the wallet returned a signature. This is the only place trust in
 * an address grows; a request that was blocked, cancelled or never signed records nothing.
 */
export async function recordSigned(judged: Judged, store: Store, atUnix: number): Promise<void> {
  if (judged.kind !== "tx" || !judged.owner || !judged.verdict.parsed || judged.verdict.level === "block") return;
  const memory = OwnerMemory.from(await store.load(judged.owner));
  recordConfirmed(memory, judged.verdict.parsed, atUnix);
  await store.save(judged.owner, memory.toJSON());
}
