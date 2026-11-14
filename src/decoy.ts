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
 *   - It asks the decoy to give away its tokens' authority, or to let somebody spend them: caught.
 *   - It asks the decoy to send out several different things at once and nothing else: caught. That is a
 *     sweep; a payment is one thing, once.
 *   - It asks the decoy to send out nearly all it holds of something: caught. A visitor chooses an amount; a
 *     thief takes the balance.
 *   - Anything else: the site passes, the owner's own wallet is connected, and the site asks again.
 *
 * What this cannot do: a thief who recognises the decoy asks it for nothing, passes, and then faces what
 * every site faces, which is Warden reading each request made of the real wallet. The decoy only ever adds
 * a way of being caught. It takes none away.
 *
 * Pure: no chrome, no fetch of its own. The worker hands it the bytes and what the decoy holds.
 */
import type { ParsedTx } from "../pincer1/daemon/src/tx/parse.js";
import { parseAnyMessage, splitTransaction } from "../pincer1/daemon/src/tx/parse.js";
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

/** How much of a holding counts as "nearly all of it". */
const NEARLY_ALL = 9n; // tenths

export interface DecoyFinding {
  caught: boolean;
  /** What the site asked the decoy for, each as the end of "It asked the decoy to …". Empty when it passed. */
  asked: string[];
  /** Who would have received it, when that is one address. */
  to: string | null;
}

const tokenOf = (decoy: Decoy, mint: string | null, source: string) => decoy.tokens?.find((t) => t.account === source || (mint !== null && t.mint === mint));
const name = (mint: string | null, amount: bigint, decimals?: number) => fmtToken(amount, mint, { ...(mint && KNOWN_MINTS[mint] ? KNOWN_MINTS[mint] : {}), ...(decimals !== undefined ? { decimals } : {}) });

/** Reads what a site asked a decoy to sign. `parsed` is the transaction read with the decoy as its owner. */
export function findDrain(parsed: ParsedTx, decoy: Decoy): DecoyFinding {
  const asked: string[] = [];
  const to = new Set<string>();

  // powers handed over: nothing a visitor's first click on a new site does
  for (const d of parsed.dangers) {
    if (d.kind === "approve") { asked.push(`let ${d.to ? short(d.to) : "someone"} spend its tokens${d.detail.startsWith("unlimited") ? ", without limit" : ""}`); if (d.to) to.add(d.to); }
    else if (d.kind === "set_authority") { asked.push(`hand ${d.to ? short(d.to) : "someone"} control of one of its token accounts`); if (d.to) to.add(d.to); }
    else if (d.kind === "assign") { asked.push("hand its whole account to another program"); if (d.to) to.add(d.to); }
  }
  const handsOver = asked.length > 0;

  const outs: { what: string; nearlyAll: boolean; kind: string }[] = [];
  if (parsed.lamportsOut > 0n) {
    const nearlyAll = decoy.lamports !== undefined && decoy.lamports > 0n && parsed.lamportsOut * 10n >= decoy.lamports * NEARLY_ALL;
    outs.push({ what: `${fmtSol(parsed.lamportsOut)}${nearlyAll ? `, of the ${fmtSol(decoy.lamports!)} it holds` : ""}`, nearlyAll, kind: "SOL" });
    if (parsed.dest) to.add(parsed.dest);
  }
  for (const m of parsed.tokenOut) {
    if (m.amount <= 0n) continue;
    const held = tokenOf(decoy, m.mint, m.source);
    const mint = m.mint ?? held?.mint ?? null;
    const nearlyAll = !!held && held.amount > 0n && m.amount * 10n >= held.amount * NEARLY_ALL;
    outs.push({ what: `${name(mint, m.amount, held?.decimals)}${nearlyAll ? ", all it holds" : ""}`, nearlyAll, kind: mint ?? m.source });
    if (m.dest) to.add(m.dest);
  }
  // nothing comes back, and nothing in the transaction is something the engine cannot read
  const onlyGiving = parsed.tokenIn.length === 0 && parsed.programs.every((p) => PLAIN.has(p)) && !parsed.unresolvedLookups;
  const sweep = onlyGiving && new Set(outs.map((o) => o.kind)).size >= 2;
  const empties = onlyGiving && outs.some((o) => o.nearlyAll);
  if (sweep || empties) asked.push(`send out ${outs.map((o) => o.what).join(" and ")}`);

  const caught = handsOver || sweep || empties;
  // who it was for is said only of a robbery: where an ordinary payment goes is the owner's business with the site
  return { caught, asked: caught ? asked : [], to: caught && to.size === 1 ? [...to][0]! : null };
}

/** What the owner is told, either way. `explain` on a pass: they are about to connect their own wallet. */
export function decoyVerdict(finding: DecoyFinding, decoy: Decoy): Pick<WardenVerdict, "level" | "sentence" | "reasons"> {
  if (finding.caught) {
    const what = finding.asked.length === 1 ? finding.asked[0]! : `${finding.asked.slice(0, -1).join(", ")}, and ${finding.asked.at(-1)}`;
    return {
      level: "block",
      sentence: `This site tried to rob a wallet that is not yours. I showed it a decoy before your own wallet, and it asked the decoy to ${what}${finding.to ? `, to ${short(finding.to)}` : ""}.`,
      reasons: [
        "your wallet was never connected to this site, and the site has not seen your address.",
        "nothing was taken: nobody here holds the decoy's key, so nothing it is asked to sign can be signed.",
        "I will pass nothing from this page to your wallet. Close it.",
      ],
    };
  }
  return {
    level: "explain",
    sentence: `I showed this site a decoy wallet (${short(decoy.address)}) before yours, and what it asked the decoy to sign is not a robbery. Continue to connect your own wallet; the site will then ask again, and I will read that request like any other.`,
    reasons: [],
  };
}

/** A message or a sign-in asked of the decoy: nothing in it can move anything, so the site passes on it. */
export const PASSED_ON_WORDS: DecoyFinding = { caught: false, asked: [], to: null };

/** Judges the transaction a site asked a decoy to sign. Bytes that are not a transaction catch nobody. */
export function judgeDecoy(txBytes: Uint8Array, decoy: Decoy, lookupTables: Tables = {}): DecoyFinding {
  let parsed: ParsedTx;
  try {
    parsed = parseAnyMessage(splitTransaction(txBytes).messageBytes, { owner: decoy.address, ownerTokenAccounts: new Set((decoy.tokens ?? []).map((t) => t.account)), lookupTables });
  } catch { return PASSED_ON_WORDS; }
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
