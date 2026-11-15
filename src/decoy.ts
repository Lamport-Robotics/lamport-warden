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

/** Something one transaction would send out of the decoy. `held`: what the decoy holds of it, when that is known. */
interface Out { kind: string; mint: string | null; amount: bigint; held: bigint | null; decimals?: number; wrapped?: boolean; dest: string }
/** What one transaction asks of the decoy, before anything is decided about it. */
interface Reading {
  /** Calls only programs whose every instruction is read here, with every account known. */
  plainOnly: boolean;
  /** Powers it would hand over, each as the end of "It asked the decoy to …", and to whom. */
  hands: string[];
  handsTo: string[];
  outs: Out[];
}

/** Reads what a transaction asks of a decoy. `parsed` is the transaction read with the decoy as its owner. */
function reading(parsed: ParsedTx, decoy: Decoy): Reading {
  const hands: string[] = [], handsTo: string[] = [];
  const plainOnly = parsed.programs.every((p) => PLAIN.has(p)) && !parsed.unresolvedLookups;
  /** The decoy's own wrapped-SOL accounts: the one worked out from its address, and any it is known to hold. */
  const wrappedOwn = new Set<string>([...ownerAtaSet(decoy.address, WSOL), ...(decoy.tokens ?? []).filter((t) => t.mint === WSOL).map((t) => t.account)]);
  /** The decoy's own accounts: what moves into one of them has not left the decoy. */
  const own = new Set<string>([decoy.address, ...(decoy.tokens ?? []).map((t) => t.account), ...wrappedOwn]);

  // powers handed over
  for (const d of parsed.dangers) {
    if (d.kind === "set_authority") { hands.push(`hand ${d.to ? short(d.to) : "someone"} control of one of its token accounts`); if (d.to) handsTo.push(d.to); }
    else if (d.kind === "assign") { hands.push("hand its whole account to another program"); if (d.to) handsTo.push(d.to); }
  }
  // A permission to spend. An older exchange or a bridge asks for one, of the amount it is about to use, and
  // uses it in the same transaction; a bridge may ask for it on an account it has only just made. A thief
  // asks for one without limit, or for all there is, or for one that nothing in the transaction uses: that
  // one is for later.
  for (const ix of parsed.instructions) {
    const checked = ix.label === "Token.approveChecked";
    if (!checked && ix.label !== "Token.approve") continue;
    const source = ix.accounts[0] ?? "", delegate = ix.accounts[checked ? 2 : 1] ?? "", signer = ix.accounts[checked ? 3 : 2];
    if (signer !== decoy.address) continue;
    const amount = u64(ix.data, 1);
    const held = tokenOf(decoy, checked ? ix.accounts[1] ?? null : null, source);
    const unlimited = amount === U64_MAX;
    const nearlyAll = !!held && held.amount > 0n && amount * 10n >= held.amount * NEARLY_ALL;
    // on an account the decoy is known not to hold anything in, a limited permission gives nothing away
    const nothingThere = decoy.tokens !== undefined && !held;
    if (unlimited || nearlyAll || (plainOnly && !nothingThere)) {
      hands.push(`let ${delegate ? short(delegate) : "someone"} spend its tokens${unlimited ? ", without limit" : nearlyAll ? ", all it holds" : ""}`);
      if (delegate) handsTo.push(delegate);
    }
  }

  const outs: Out[] = [];
  // Closing one of the decoy's wrapped-SOL accounts to somebody else pays out everything in it: what it held,
  // and whatever this same transaction put into it first.
  const closedTo = new Map<string, string>();
  for (const ix of parsed.instructions) {
    if (ix.label !== "Token.closeAccount" || ix.accounts[2] !== decoy.address) continue;
    const account = ix.accounts[0] ?? "", dest = ix.accounts[1] ?? "";
    if (wrappedOwn.has(account) && !own.has(dest)) closedTo.set(account, dest);
  }
  // SOL: what goes into the decoy's own wrapped-SOL account stays the decoy's, unless that account is closed away
  let kept = 0n, solDest = parsed.dest && !own.has(parsed.dest) ? parsed.dest : "";
  for (const ix of parsed.instructions) {
    if (ix.label !== "System.transfer" || ix.accounts[0] !== decoy.address) continue;
    const into = ix.accounts[1] ?? "";
    if (!own.has(into)) continue;
    if (closedTo.has(into)) solDest ||= closedTo.get(into)!;
    else kept += u64(ix.data, 4);
  }
  const solOut = parsed.lamportsOut > kept ? parsed.lamportsOut - kept : 0n;
  if (solOut > 0n) outs.push({ kind: "SOL", mint: null, amount: solOut, held: decoy.lamports ?? null, dest: solDest });
  for (const m of parsed.tokenOut) {
    if (m.amount <= 0n || own.has(m.dest)) continue;
    const held = tokenOf(decoy, m.mint, m.source);
    const mint = m.mint ?? held?.mint ?? null;
    outs.push({ kind: mint ?? m.source, mint, amount: m.amount, held: held ? held.amount : decoy.tokens !== undefined ? 0n : null, decimals: held?.decimals, dest: m.dest });
  }
  for (const [account, dest] of closedTo) {
    const held = decoy.tokens?.find((t) => t.account === account && t.amount > 0n);
    if (held) outs.push({ kind: WSOL, mint: WSOL, amount: held.amount, held: held.amount, wrapped: true, dest });
  }
  return { plainOnly, hands, handsTo, outs };
}

/**
 * Decides on everything a site asked the decoy for in one call. What is sent out is added up over the
 * transactions that do nothing else: a balance taken in two halves is taken.
 */
function decide(readings: Reading[]): DecoyFinding {
  const asked = [...new Set(readings.flatMap((r) => r.hands))];
  const to = new Set(readings.flatMap((r) => r.handsTo));
  const totals = new Map<string, Out>();
  for (const r of readings) {
    if (!r.plainOnly) continue;
    for (const o of r.outs) {
      // more than the decoy holds was not worked out from what it holds: that is a price, not a balance
      if (o.held !== null && o.amount > o.held) continue;
      const sum = totals.get(o.kind);
      if (sum) { sum.amount += o.amount; if (sum.dest !== o.dest) sum.dest = ""; } else totals.set(o.kind, { ...o });
    }
  }
  // With nothing known of what the decoy holds, how much is asked says nothing: only the powers above do.
  const nearlyAll = (o: Out) => o.held !== null && o.held > 0n && o.amount * 10n >= o.held * NEARLY_ALL;
  const most = (o: Out) => o.held !== null && o.held > 0n && o.amount * 10n >= o.held * MOST;
  const all = [...totals.values()];
  const sweep = all.filter(most).length >= 2;
  const empties = all.some(nearlyAll);
  if (sweep || empties) {
    const said = (o: Out) => (o.wrapped ? `${fmtSol(o.amount)} of wrapped SOL, all it holds`
      : o.kind === "SOL" ? `${fmtSol(o.amount)}${nearlyAll(o) ? `, of the ${fmtSol(o.held!)} it holds` : ""}`
      : `${name(o.mint, o.amount, o.decimals)}${nearlyAll(o) ? ", all it holds" : ""}`);
    asked.push(`send out ${all.map(said).join(" and ")}`);
    for (const o of all) to.add(o.dest);
  }
  const caught = asked.length > 0;
  // who it was for is said only of a robbery: where an ordinary payment goes is the owner's business with the site
  return { caught, asked, to: caught && to.size === 1 && !to.has("") ? [...to][0]! : null, unread: readings.some((r) => !r.plainOnly) };
}

/** One thing a site asked a decoy to sign, in a call that may ask for several. */
export type AskedOf = { kind: "tx"; bytes: Uint8Array; tables?: Tables } | { kind: "words" } | { kind: "unread" };

/**
 * Judges everything a site asked a decoy to sign in one call. A message or a sign-in ("words") can move
 * nothing; a request in a form that is not read here ("unread"), and bytes that are no transaction, catch
 * nobody and leave the answer worded as what could be read.
 */
export function judgeCall(asks: AskedOf[], decoy: Decoy): DecoyFinding {
  const readings: Reading[] = [];
  let unread = false;
  for (const a of asks) {
    if (a.kind === "words") continue;
    if (a.kind === "unread") { unread = true; continue; }
    let parsed: ParsedTx;
    try {
      parsed = parseAnyMessage(splitTransaction(a.bytes).messageBytes, { owner: decoy.address, ownerTokenAccounts: new Set((decoy.tokens ?? []).map((t) => t.account)), lookupTables: a.tables ?? {} });
    } catch { unread = true; continue; }
    // a transaction the decoy is not even a signer of asks nothing of the decoy
    if (parsed.signers.includes(decoy.address)) readings.push(reading(parsed, decoy));
  }
  const found = decide(readings);
  return { ...found, unread: found.unread || unread };
}

/** Judges one transaction a site asked a decoy to sign. */
export const judgeDecoy = (txBytes: Uint8Array, decoy: Decoy, lookupTables: Tables = {}): DecoyFinding => judgeCall([{ kind: "tx", bytes: txBytes, tables: lookupTables }], decoy);

const ACK = { kind: "acknowledge", expect: "I understand" } as const;

/**
 * What the owner is told, either way. On a pass they are about to connect their own wallet. `caughtOn`: the
 * day this same site was caught before, when it was. `beyond`: how many more things the call asked for than
 * the `read` that were read. Going on in either case takes typing, not a press.
 */
export function decoyVerdict(finding: DecoyFinding, decoy: Decoy, o: { caughtOn?: string | null; read?: number; beyond?: number } = {}): Pick<WardenVerdict, "level" | "sentence" | "reasons" | "confirm"> {
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
  if (o.caughtOn) {
    return {
      level: "confirm",
      sentence: `This site tried to rob a decoy wallet on ${o.caughtOn}. This time ${read}. Go on only if you are sure of this site: your own wallet is then connected to it.`,
      reasons: ["it was caught asking a decoy for what only a thief asks.", "a thief that was caught once can behave the next time."],
      confirm: ACK,
    };
  }
  if (o.beyond && o.beyond > 0) {
    const seen = o.read ?? 0;
    return {
      level: "confirm",
      sentence: `This site asked the decoy to sign ${seen + o.beyond} things at once, and I read the first ${seen}. Nothing I could read in those is a robbery. Go on only if you are sure of this site: your own wallet is then connected to it.`,
      reasons: ["a robbery can be put after more requests than anybody reads.", "an ordinary site does not ask a wallet it has just met for this many signatures."],
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
