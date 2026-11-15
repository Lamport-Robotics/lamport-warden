/**
 * The judging half: takes what a wallet was asked to sign and returns Warden's verdict. Pure apart from the
 * store and the table reader it is given, so it runs under test in Node. The engine itself lives in the
 * Pincer1 repo (pincer1/daemon/src/warden, a submodule pinned to one commit) and is bundled from there; it is
 * the same code the robot uses.
 */
import { PublicKey } from "@solana/web3.js";
import { OwnerMemory, checkMessage, checkTransaction, recordConfirmed, type MemoryState, type WardenVerdict } from "../pincer1/daemon/src/warden/index.js";
import { parseAnyMessage, splitTransaction, type ParsedTx } from "../pincer1/daemon/src/tx/parse.js";
import { approvalsFromArmingPage, readSentinel, sentinelStateFrom, type SentinelState } from "./sentinel.js";
import { tablesNeeded, type Tables } from "./rpc.js";
import { READ_IN_FULL, wordsFor, type Simulated } from "./simulate.js";

export interface Store {
  /** The stored history of one wallet address, or undefined. */
  load(owner: string): Promise<unknown>;
  save(owner: string, state: MemoryState): Promise<void>;
  /** Sites the owner allowed to ask for the Privacy Rings key signature. */
  ringSites(): Promise<string[]>;
  /** What this browser saw of one wallet's Sentinel setup (sentinel.ts), or undefined. */
  sentinel?(owner: string): Promise<unknown>;
  /** Remembers it, or forgets it when `state` is null. */
  saveSentinel?(owner: string, state: SentinelState | null): Promise<void>;
}

export interface JudgeRequest { kind: "tx" | "msg" | "signin" | "opaque"; bytes: Uint8Array; owner: string }
export interface Judged {
  verdict: WardenVerdict;
  owner: string;
  kind: JudgeRequest["kind"];
  /** For a Sentinel transaction: what to remember of the owner's setup once it is signed (null: forget it). */
  sentinelAfter?: SentinelState | null;
}
/** Reads the lookup tables a message needs. Absent: every request is judged without them. */
export type TableSource = (messageBytes: Uint8Array) => Promise<Tables>;
/**
 * Runs the transaction against the chain as it is now. Null means the owner has simulation off: nothing was
 * asked, and nothing is said about it. A failure to get an answer is different, and the owner is told.
 */
export type SimulationSource = (txBytes: Uint8Array, messageBytes: Uint8Array, owner: string, tables: Tables) => Promise<Simulated | null>;
/**
 * The vault an owner's Sentinel setup names on the chain, or null when they have none. Asked only when the
 * Sentinel page hands over token approvals and this browser has no memory of that wallet's setup.
 */
export type SentinelSource = (owner: string) => Promise<string | null>;
export interface Sources { tables?: TableSource; simulate?: SimulationSource; sentinelVault?: SentinelSource }

const ACK = { kind: "acknowledge", expect: "I understand" } as const;

export async function judge(req: JudgeRequest, origin: string, store: Store, sources: Sources = {}): Promise<Judged> {
  const { tables, simulate, sentinelVault } = sources;
  if (req.kind === "opaque") {
    return { verdict: { level: "confirm", sentence: "This site asked your wallet to sign something in a form I can't read, so I can't tell you what it does.", reasons: ["the signing request is not in a form I know."], confirm: ACK }, owner: req.owner, kind: "opaque" };
  }
  if (req.kind === "signin") return { verdict: checkSignIn(req.bytes, origin), owner: req.owner, kind: "signin" };
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
  // Sentinel's own transactions are the two things the engine exists to block, so they are read first, by
  // their exact shape, and only then is anything else left to the engine (sentinel.ts).
  let decoded: ParsedTx | null = null;
  try { decoded = parseAnyMessage(messageBytes, { owner: req.owner, lookupTables }); } catch { decoded = null; }
  if (decoded && decoded.signers.includes(req.owner)) {
    let state = sentinelStateFrom(await store.sentinel?.(req.owner));
    let unseen = false;
    // Approvals from the Sentinel page, and nothing here remembers a setup: it may have been made in another
    // browser. The chain says which vault it names, and the owner is then asked to check that vault here too.
    if (!state && sentinelVault && approvalsFromArmingPage(decoded, req.owner, origin)) {
      const vault = await sentinelVault(req.owner).catch(() => null);
      if (vault) { state = { vault }; unseen = true; }
    }
    const sentinel = readSentinel(decoded, req.owner, origin, state, { unseen });
    if (sentinel.kind === "verdict") return { verdict: sentinel.verdict, owner: req.owner, kind: "tx", sentinelAfter: sentinel.after };
  }
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

const hostOf = (s: string): string | null => { try { return new URL(s.includes("://") ? s : `https://${s}`).host.toLowerCase(); } catch { return null; } };

/**
 * Sign In With Solana. The wallet writes the message from the request's fields and it begins with a domain:
 * "<domain> wants you to sign in with your Solana account". A signature over that message signs the owner in
 * to that domain, wherever the request came from. So the one thing that matters is whether the domain is the
 * site that is asking. When it is, there is nothing to stop for. When it is another site, it is a relay: the
 * page is collecting a sign-in for somewhere else.
 */
export function checkSignIn(bytes: Uint8Array, origin: string): WardenVerdict {
  const here = hostOf(origin);
  const who = here ?? "This site";
  let fields: Record<string, unknown>;
  try { fields = JSON.parse(new TextDecoder().decode(bytes)); } catch { fields = {}; }
  const domain = typeof fields.domain === "string" && fields.domain.trim() !== "" ? fields.domain.trim() : null;
  if (domain === null) return { level: "allow", sentence: `${who} asks you to sign in to it.`, reasons: [] };
  const named = hostOf(domain);
  if (named === null) return { level: "confirm", sentence: `${who} asks you to sign in, but the request names a site I can't read: "${domain.slice(0, 80)}".`, reasons: ["the sign-in request does not name a readable site."], confirm: ACK };
  if (here !== null && named === here) return { level: "allow", sentence: `${who} asks you to sign in to it.`, reasons: [] };
  return {
    level: "block",
    sentence: `${who} asks you to sign in, but the signature would sign you in to ${named}, a different site.`,
    reasons: [`the request is for ${named} and it comes from ${here ?? "an unknown page"}. A site that collects sign-ins for another site can use them there as you.`],
  };
}

/**
 * After the owner let the request through and the wallet returned a signature. This is the only place trust in
 * an address grows; a request that was blocked, cancelled or never signed records nothing.
 */
export async function recordSigned(judged: Judged, store: Store, atUnix: number): Promise<void> {
  if (judged.kind !== "tx" || !judged.owner || !judged.verdict.parsed || judged.verdict.level === "block") return;
  if (judged.sentinelAfter !== undefined) await store.saveSentinel?.(judged.owner, judged.sentinelAfter);
  const memory = OwnerMemory.from(await store.load(judged.owner));
  recordConfirmed(memory, judged.verdict.parsed, atUnix);
  await store.save(judged.owner, memory.toJSON());
}
