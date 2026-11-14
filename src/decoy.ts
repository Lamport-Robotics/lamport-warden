/**
 * Decoy first. An experiment, off unless turned on.
 *
 * Connecting a wallet to a site hands the site one thing: an address. Nothing is signed. So the address a
 * site is handed first does not have to be the owner's. Warden can hand it a decoy: an address that holds
 * something, that nobody here has the key to, and that therefore cannot lose anything.
 *
 * A site that robs wallets looks at what the connected address holds and asks it to sign that away. A site
 * that does not, waits for its visitor to do something. So what a site asks the decoy to sign says what the
 * site is, before it has ever seen the owner's own address:
 *
 *   - It asks the decoy to hand over an account, or to let somebody spend its tokens without limit, or
 *     nearly all of them, or with nothing in the transaction that would use the permission: caught.
 *   - It asks the decoy to send out most of two or more different things at once, in a transaction that does
 *     nothing else: caught. That is a sweep; a payment is one thing, once.
 *   - It asks the decoy to send out nearly all it holds of something, in a transaction that does nothing
 *     else: caught. A visitor chooses an amount; a thief takes the balance.
 *   - Anything else: the site passes, the owner's own wallet is connected, and the site asks again.
 *
 * What moves into the decoy's own accounts is not sent out (wrapping SOL is not a payment). "Does nothing
 * else" means it calls only programs whose every instruction is read here: a transaction that also calls
 * some other program may be a swap, and is not judged a robbery on what it sends.
 *
 * What this cannot do: a thief who recognises the decoy asks it for nothing, passes, and then faces what
 * every site faces, which is Warden reading each request made of the real wallet. One who adds a call to a
 * program this does not read passes too. The decoy only ever adds a way of being caught. It takes none away.
 *
 * Pure: no chrome, no fetch of its own. The worker hands it the bytes and what the decoy holds.
 */
import type { ParsedTx } from "../pincer1/daemon/src/tx/parse.js";
import { ownerAtaSet, parseAnyMessage, splitTransaction } from "../pincer1/daemon/src/tx/parse.js";
import { fmtSol, fmtToken, short } from "../pincer1/daemon/src/tx/explain.js";
import { KNOWN_MINTS } from "../pincer1/daemon/src/tx/known.js";
import type { WardenVerdict } from "../pincer1/daemon/src/warden/index.js";
import type { FetchLike, Tables } from "./rpc.js";

/** A decoy and what it holds. Without holdings a site can still be caught by what it asks for, not by how much. */
export interface Decoy {
  address: string;
  /** SOL, in lamports. */
  lamports?: bigint;
  tokens?: { mint: string; account: string; amount: bigint; decimals: number }[];
}

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const MEMO = new Set(["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"]);
/** Programs whose every instruction the engine reads: a transaction made only of these hides nothing. */
const PLAIN = new Set([SYSTEM, TOKEN, TOKEN_2022, ASSOCIATED, COMPUTE_BUDGET, ...MEMO]);

export { LAMPORT_DECOYS } from "./defaults.js";

/**
 * The decoy a site is shown: the owner's own if they named one, or else one of Lamport's. `mark` is the
 * site's mark in this browser (hex), so that a site sees the same one each time, and different sites and
 * different browsers do not all see the same one.
 */
export function pickDecoy(named: string, roster: readonly string[], mark: string): string | null {
  if (named) return named;
  if (roster.length === 0) return null;
  const n = Number.parseInt(mark.slice(0, 8), 16);
  return roster[(Number.isFinite(n) ? n : 0) % roster.length]!;
}

const WSOL = "So11111111111111111111111111111111111111112";
/** How much of a holding counts as "nearly all of it". */
const NEARLY_ALL = 9n; // tenths
/** How much of each holding a sweep takes, at the least. */
const MOST = 5n; // tenths
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const u64 = (d: Uint8Array, at: number): bigint => { let n = 0n; for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(d[at + i] ?? 0); return n; };

export interface DecoyFinding {
  caught: boolean;
  /** What the site asked the decoy for, each as the end of "It asked the decoy to …". Empty when it passed. */
  asked: string[];
  /** Who would have received it, when that is one address. */
  to: string | null;
  /** Part of what was asked was not read here. A site that passes is then said to have passed on what could be read. */
  unread: boolean;
}

const tokenOf = (decoy: Decoy, mint: string | null, source: string) => decoy.tokens?.find((t) => t.account === source || (mint !== null && t.mint === mint));
const name = (mint: string | null, amount: bigint, decimals?: number) => fmtToken(amount, mint, { ...(mint && KNOWN_MINTS[mint] ? KNOWN_MINTS[mint] : {}), ...(decimals !== undefined ? { decimals } : {}) });

/** Reads what a site asked a decoy to sign. `parsed` is the transaction read with the decoy as its owner. */
export function findDrain(parsed: ParsedTx, decoy: Decoy): DecoyFinding {
  const asked: string[] = [];
  const to = new Set<string>();
  /** Calls only programs whose every instruction is read here, with every account known. */
  const plainOnly = parsed.programs.every((p) => PLAIN.has(p)) && !parsed.unresolvedLookups;
  /** The decoy's own accounts: what moves into one of them has not left the decoy. */
  const own = new Set<string>([decoy.address, ...(decoy.tokens ?? []).map((t) => t.account), ...ownerAtaSet(decoy.address, WSOL)]);

  // powers handed over
  for (const d of parsed.dangers) {
    if (d.kind === "set_authority") { asked.push(`hand ${d.to ? short(d.to) : "someone"} control of one of its token accounts`); if (d.to) to.add(d.to); }
    else if (d.kind === "assign") { asked.push("hand its whole account to another program"); if (d.to) to.add(d.to); }
  }
  // A permission to spend. An older exchange or a bridge asks for one, of the amount it is about to use, and
  // uses it in the same transaction. A thief asks for one without limit, or for all there is, or for one that
  // nothing in the transaction uses: that one is for later.
  for (const ix of parsed.instructions) {
    const checked = ix.label === "Token.approveChecked";
    if (!checked && ix.label !== "Token.approve") continue;
    const source = ix.accounts[0] ?? "", delegate = ix.accounts[checked ? 2 : 1] ?? "", signer = ix.accounts[checked ? 3 : 2];
    if (signer !== decoy.address) continue;
    const amount = u64(ix.data, 1);
    const held = tokenOf(decoy, checked ? ix.accounts[1] ?? null : null, source);
    const unlimited = amount === U64_MAX;
    const nearlyAll = !!held && held.amount > 0n && amount * 10n >= held.amount * NEARLY_ALL;
    if (unlimited || nearlyAll || !held || plainOnly) {
      asked.push(`let ${delegate ? short(delegate) : "someone"} spend its tokens${unlimited ? ", without limit" : nearlyAll ? ", all it holds" : ""}`);
      if (delegate) to.add(delegate);
    }
  }
  const handsOver = asked.length > 0;

  const outs: { what: string; nearlyAll: boolean; most: boolean; kind: string }[] = [];
  // SOL: what goes into the decoy's own wrapped-SOL account stays the decoy's
  let kept = 0n;
  for (const ix of parsed.instructions) if (ix.label === "System.transfer" && ix.accounts[0] === decoy.address && own.has(ix.accounts[1] ?? "")) kept += u64(ix.data, 4);
  const solOut = parsed.lamportsOut > kept ? parsed.lamportsOut - kept : 0n;
  if (solOut > 0n) {
    const known = decoy.lamports !== undefined && decoy.lamports > 0n;
    const nearlyAll = known && solOut * 10n >= decoy.lamports! * NEARLY_ALL;
    outs.push({ what: `${fmtSol(solOut)}${nearlyAll ? `, of the ${fmtSol(decoy.lamports!)} it holds` : ""}`, nearlyAll, most: !known || solOut * 10n >= decoy.lamports! * MOST, kind: "SOL" });
    if (parsed.dest && !own.has(parsed.dest)) to.add(parsed.dest);
  }
  for (const m of parsed.tokenOut) {
    if (m.amount <= 0n || own.has(m.dest)) continue;
    const held = tokenOf(decoy, m.mint, m.source);
    const mint = m.mint ?? held?.mint ?? null;
    const known = !!held && held.amount > 0n;
    const nearlyAll = known && m.amount * 10n >= held!.amount * NEARLY_ALL;
    outs.push({ what: `${name(mint, m.amount, held?.decimals)}${nearlyAll ? ", all it holds" : ""}`, nearlyAll, most: !known || m.amount * 10n >= held!.amount * MOST, kind: mint ?? m.source });
    if (m.dest) to.add(m.dest);
  }
  // closing the decoy's wrapped-SOL account pays out everything in it, to wherever the close says
  for (const ix of parsed.instructions) {
    if (ix.label !== "Token.closeAccount" || ix.accounts[2] !== decoy.address) continue;
    const held = decoy.tokens?.find((t) => t.account === ix.accounts[0] && t.mint === WSOL && t.amount > 0n);
    const dest = ix.accounts[1] ?? "";
    if (!held || own.has(dest)) continue;
    outs.push({ what: `${fmtSol(held.amount)} of wrapped SOL, all it holds`, nearlyAll: true, most: true, kind: WSOL });
    if (dest) to.add(dest);
  }
  // In a transaction that does nothing else. What comes back is not weighed: with only plain programs in it,
  // anything "coming back" is something the other side chose to put there, and one token in is not a trade.
  const sweep = plainOnly && new Set(outs.filter((o) => o.most).map((o) => o.kind)).size >= 2;
  const empties = plainOnly && outs.some((o) => o.nearlyAll);
  if (sweep || empties) asked.push(`send out ${outs.map((o) => o.what).join(" and ")}`);

  const caught = handsOver || sweep || empties;
  // who it was for is said only of a robbery: where an ordinary payment goes is the owner's business with the site
  return { caught, asked: caught ? asked : [], to: caught && to.size === 1 ? [...to][0]! : null, unread: !plainOnly };
}

/** One finding for everything a site asked the decoy for in one call. `more`: there was more than was read. */
export function together(findings: DecoyFinding[], more = false): DecoyFinding {
  const caught = findings.some((f) => f.caught);
  const asked = [...new Set(findings.flatMap((f) => f.asked))];
  const to = new Set(findings.filter((f) => f.caught && f.to).map((f) => f.to!));
  return { caught, asked: caught ? asked : [], to: caught && to.size === 1 && findings.filter((f) => f.caught).every((f) => f.to) ? [...to][0]! : null, unread: more || findings.some((f) => f.unread) };
}

const ACK = { kind: "acknowledge", expect: "I understand" } as const;

/**
 * What the owner is told, either way. On a pass they are about to connect their own wallet. `caughtOn`: the
 * day this same site was caught before, when it was; going on then takes typing, not a press.
 */
export function decoyVerdict(finding: DecoyFinding, decoy: Decoy, caughtOn: string | null = null): Pick<WardenVerdict, "level" | "sentence" | "reasons" | "confirm"> {
  if (finding.caught) {
    const what = finding.asked.length === 1 ? finding.asked[0]! : `${finding.asked.slice(0, -1).join(", ")}, and ${finding.asked.at(-1)}`;
    return {
      level: "block",
      sentence: `This site tried to rob a wallet that is not yours. I showed it a decoy before your own wallet, and it asked the decoy to ${what}${finding.to ? `, to ${short(finding.to)}` : ""}.`,
      reasons: [
        "the wallet this site asked was never connected to it: what it was handed is the decoy's address.",
        "nothing was taken: nobody here holds the decoy's key, so nothing it is asked to sign can be signed.",
        "I will pass nothing from this page to your wallet. Close it.",
      ],
    };
  }
  const read = finding.unread ? "nothing I could read in what it asked the decoy to sign is a robbery" : "what it asked the decoy to sign is not a robbery";
  if (caughtOn) {
    return {
      level: "confirm",
      sentence: `This site tried to rob a decoy wallet on ${caughtOn}. This time ${read}. Go on only if you are sure of this site: your own wallet is then connected to it.`,
      reasons: ["it was caught asking a decoy for what only a thief asks.", "a thief that was caught once can behave the next time."],
      confirm: ACK,
    };
  }
  return {
    level: "explain",
    sentence: `I showed this site a decoy wallet (${short(decoy.address)}) before yours, and ${read}. Continue to connect your own wallet; the site will then ask again, and I will read that request like any other.`,
    reasons: [],
  };
}

/** A message or a sign-in asked of the decoy: nothing in it can move anything, so the site passes on it. */
export const PASSED_ON_WORDS: DecoyFinding = { caught: false, asked: [], to: null, unread: false };
/** Something asked of the decoy that could not be read at all. Nothing in it catches anybody, and nothing in it was read. */
export const PASSED_UNREAD: DecoyFinding = { caught: false, asked: [], to: null, unread: true };

/** Judges the transaction a site asked a decoy to sign. Bytes that are not a transaction catch nobody. */
export function judgeDecoy(txBytes: Uint8Array, decoy: Decoy, lookupTables: Tables = {}): DecoyFinding {
  let parsed: ParsedTx;
  try {
    parsed = parseAnyMessage(splitTransaction(txBytes).messageBytes, { owner: decoy.address, ownerTokenAccounts: new Set((decoy.tokens ?? []).map((t) => t.account)), lookupTables });
  } catch { return PASSED_UNREAD; }
  // a transaction the decoy is not even a signer of asks nothing of the decoy
  if (!parsed.signers.includes(decoy.address)) return PASSED_ON_WORDS;
  return findDrain(parsed, decoy);
}

/**
 * What a decoy holds, asked of the RPC: its SOL, and its token accounts under both token programs. The RPC
 * learns the decoy's address and nothing about the owner. Null when it could not be read: the decoy is then
 * used without holdings, and a site is caught by what it asks for and not by how much.
 */
export async function readHoldings(address: string, rpcUrl: string, fetchImpl: FetchLike, timeoutMs = 4000): Promise<Pick<Decoy, "lamports" | "tokens"> | null> {
  if (!rpcUrl) return null;
  const ask = async (method: string, params: unknown[]): Promise<any> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctl.signal });
      if (!res.ok) throw new Error("the RPC did not answer");
      return (await res.json())?.result;
    } finally { clearTimeout(timer); }
  };
  try {
    const [balance, ...lists] = await Promise.all([
      ask("getBalance", [address, { commitment: "confirmed" }]),
      ...[TOKEN, TOKEN_2022].map((programId) => ask("getTokenAccountsByOwner", [address, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }])),
    ]);
    if (typeof balance?.value !== "number") return null;
    const tokens: NonNullable<Decoy["tokens"]> = [];
    for (const list of lists) for (const entry of list?.value ?? []) {
      const info = entry?.account?.data?.parsed?.info;
      if (!info || typeof entry.pubkey !== "string" || typeof info.mint !== "string") continue;
      const amount = BigInt(info.tokenAmount?.amount ?? "0");
      if (amount > 0n) tokens.push({ mint: info.mint, account: entry.pubkey, amount, decimals: Number(info.tokenAmount?.decimals ?? 0) });
    }
    return { lamports: BigInt(balance.value), tokens };
  } catch { return null; }
}
