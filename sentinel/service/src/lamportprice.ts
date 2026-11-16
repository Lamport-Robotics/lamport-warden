/**
 * What a LAMPORT costs in dollars, for turning the plan's price in dollars into an amount of LAMPORT.
 *
 * Three public sources that need no key are asked at once, as for SOL (solprice.ts): a price is given only
 * when at least two of them answer and agree, so one source that is stale, wrong or lying cannot set it
 * alone. They may be a little further apart than for SOL: a small token's price reaches each of them at a
 * different moment.
 *
 * LAMPORT trades in one small pool, and that changes two things.
 *
 * Which pool. Asked about a token, a source answers with the price in whichever pool it takes for the
 * token's, and anybody can make a pool. One that holds only LAMPORT, priced at ten times what it trades for,
 * costs nothing to keep (nobody can sell into it) and looks deep, because what is in it is counted at its
 * own price. So two of the three sources are not asked about the token at all: they are asked about the one
 * pool, by its address (`pool`), and an answer about another pool, or one where LAMPORT is not the token
 * being priced, is no answer. The third (Jupiter) is asked about the token and can only agree with them:
 * with two needed, a price always has one of the pool's own sources behind it.
 *
 * How long. Somebody who pushes the price up in that pool and asks for an amount while it is up would be
 * asked for fewer tokens than the plan costs. So the price used is the lowest of the price now, the price
 * an hour ago and the price six hours ago. A price that is held up for six hours in a pool anyone can sell
 * into is a price; one that is not, buys nothing. What it was before comes from the pool's own sources, each
 * of which reports the change over those periods; at least one that agrees about the price now has to give
 * both, and every one that gives any is counted. A change that cannot be read is not taken for no change.
 * Taking the lowest can only ask for more tokens, never fewer, so a source that lies about the past cannot
 * lie in a payer's favour further than the price now, on which two have to agree.
 *
 * How deep. All of that rests on the pool having enough in it that holding its price up costs something.
 * If what is in it were taken out, or trading moved elsewhere, a few hundred dollars would hold any price
 * in what was left, and the two sources that read it would agree with each other about it. So each of them
 * also has to say the pool holds at least LAMPORT_POOL_LEAST_USD, or its word about the pool is not taken;
 * and when Jupiter, the one source that follows the token wherever it trades, answers and does not agree,
 * there is no price. That last lets somebody who can mislead Jupiter turn paying in LAMPORT off for a
 * while. Off is the safe way for this to fail.
 *
 * What this does not do: a rise older than six hours is the price, and after any rise inside six hours a
 * payer is asked for more tokens than the price of the moment would give. Both are said in the terms.
 *
 * When there is no price, nothing is quoted in LAMPORT (USDC needs no price and is always there). A price,
 * and the lack of one, is kept for half a minute, and whoever asks while the sources are being asked waits
 * for that one answer: a crowd of pages cannot make the service ask a public source a crowd of times.
 */
import { agreed, type PriceFetch } from "./solprice.js";

/** How far apart two sources may be and still count as agreeing about LAMPORT. */
export const LAMPORT_AGREE_WITHIN = 0.05;
/** The least and the most a LAMPORT is taken to cost: outside these a number is not a price. A dollar a token would be a billion dollars for all of them. */
const LEAST = 1e-9, MOST = 1;
/** The least a pool has to hold, in dollars as its sources count it, for its price to be taken as the token's. On 2026-11-16 LAMPORT's held about 19,000. */
export const LAMPORT_POOL_LEAST_USD = 5_000;
/** How long a price, or the lack of one, stands before the sources are asked again. */
export const LAMPORT_KEEP_SECONDS = 30;
/** How old a price may be and still be shown as "about this many" (never used for an amount to pay). */
export const LAMPORT_SHOW_SECONDS = 180;

/** What one source said: the price now, and for a source that reads the pool, the price one hour and six hours before (null where it could not be read) and what the pool holds in dollars. */
export interface LamportAnswer { price: number; before: readonly (number | null)[]; depth?: number }
const NOTHING: LamportAnswer = { price: NaN, before: [] };

/** A number as a source writes one: a number, or its digits in a string. Anything else (nothing, a space, a list, true) is not a number, whatever JavaScript would make of it. */
export function written(x: unknown): number {
  if (typeof x === "number") return Number.isFinite(x) ? x : NaN;
  return typeof x === "string" && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(x) ? Number(x) : NaN;
}

/** The price before, from the price now and the change since, in percent. Null when what was reported is not a change. */
export function before(now: number, percent: unknown): number | null {
  const change = written(percent);
  if (!Number.isFinite(change) || change <= -100) return null;
  return now / (1 + change / 100);
}

export interface LamportSource { name: string; /** It is asked about the pool, not about the token. */ pool: boolean; url: string; read: (j: any) => LamportAnswer }

export const lamportSources = (mint: string, pool: string): readonly LamportSource[] => [
  { name: "jupiter", pool: false, url: `https://lite-api.jup.ag/price/v3?ids=${mint}`, read: (j) => ({ price: written(j?.[mint]?.usdPrice), before: [] }) },
  {
    name: "geckoterminal", pool: true, url: `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}`,
    read: (j) => {
      const d = j?.data, a = d?.attributes;
      // the pool that was asked about, with LAMPORT as the token it prices
      if (!a || a.address !== pool || d?.relationships?.base_token?.data?.id !== `solana_${mint}`) return NOTHING;
      const price = written(a.base_token_price_usd);
      const change = a.price_change_percentage;
      return { price, before: [before(price, change?.h1), before(price, change?.h6)], depth: written(a.reserve_in_usd) };
    },
  },
  {
    name: "dexscreener", pool: true, url: `https://api.dexscreener.com/latest/dex/pairs/solana/${pool}`,
    read: (j) => {
      const pairs: any[] = Array.isArray(j?.pairs) ? j.pairs : j?.pair ? [j.pair] : [];
      const p = pairs.find((x) => x?.pairAddress === pool);
      if (!p || p.baseToken?.address !== mint) return NOTHING;
      const price = written(p.priceUsd);
      // DexScreener leaves a period's change out when it has none to give. With no trade in the period the
      // price then was the price now; left out with trades in it, it is not known, and is not guessed.
      const over = (k: "h1" | "h6"): number | null => {
        const c = p.priceChange?.[k];
        if (c !== undefined && c !== null) return before(price, c);
        const t = p.txns?.[k];
        return t && t.buys === 0 && t.sells === 0 ? price : null;
      };
      return { price, before: [over("h1"), over("h6")], depth: written(p.liquidity?.usd) };
    },
  },
];

/**
 * The price to use, from what the sources said (in the order of `sources`): the lowest of the price now, on
 * which two agree, and the prices before that the agreeing pool sources give. Throws when there is none.
 */
export function lamportPriceFrom(sources: readonly LamportSource[], answers: readonly LamportAnswer[]): number {
  const now = agreed(answers.map((a) => a.price), LAMPORT_AGREE_WITHIN, LEAST, MOST);
  if (now === null) throw new Error("the price of LAMPORT could not be established: fewer than two sources agree");
  const agrees = (p: number) => p >= now / (1 + LAMPORT_AGREE_WITHIN) && p <= now * (1 + LAMPORT_AGREE_WITHIN);
  // the source that follows the token wherever it trades: when it answers, the pool's price has to be the token's price
  if (answers.some((a, i) => !sources[i]!.pool && a.price > LEAST && a.price < MOST && !agrees(a.price))) throw new Error("the price of LAMPORT could not be established: its price in its pool is not its price elsewhere");
  const reads = answers.filter((a, i) => sources[i]!.pool && agrees(a.price));
  if (!reads.length) throw new Error("the price of LAMPORT could not be established: no source that reads its pool is among those that agree");
  // and the pool has to hold enough that its price costs something to move: a source that does not say so is not taken at its word about it
  const pools = reads.filter((a) => a.depth !== undefined && a.depth >= LAMPORT_POOL_LEAST_USD);
  if (!pools.length) throw new Error("the price of LAMPORT could not be established: its pool holds too little for its price to be relied on");
  const sane = (p: number | null): p is number => p !== null && p >= LEAST && p <= MOST;
  // one of them has to say what it was both an hour and six hours ago; whatever any of them says is counted
  if (!pools.some((a) => a.before.length === 2 && a.before.every(sane))) throw new Error("the price of LAMPORT could not be established: what it was one hour and six hours ago could not be read");
  return Math.min(now, ...pools.flatMap((a) => a.before.filter(sane)));
}

export class LamportPrice {
  private last: { at: number; price: number } | null = null;
  private failed: { at: number; why: string } | null = null;
  private asking: Promise<number> | null = null;
  constructor(private mint: string, private pool: string, private fetchImpl: PriceFetch = (u, i) => fetch(u, i), private opts: { now?: () => number; timeoutMs?: number; keepSeconds?: number } = {}) {}
  private now(): number { return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000); }
  private get keep(): number { return this.opts.keepSeconds ?? LAMPORT_KEEP_SECONDS; }

  /** Dollars for one LAMPORT: the lowest of the price now, an hour ago and six hours ago. Throws when there is no such price. */
  usd(): Promise<number> {
    const now = this.now();
    if (this.last && now - this.last.at < this.keep) return Promise.resolve(this.last.price);
    if (this.failed && now - this.failed.at < this.keep) return Promise.reject(new Error(this.failed.why));
    // one asking at a time: whoever comes while it is out waits for the same answer
    this.asking ??= this.ask().then(
      (price) => { this.last = { at: this.now(), price }; this.failed = null; this.asking = null; return price; },
      (e: unknown) => { this.failed = { at: this.now(), why: e instanceof Error ? e.message : "the price of LAMPORT could not be established" }; this.asking = null; throw e; },
    );
    return this.asking;
  }

  /**
   * The last price established, when it is no more than three minutes old, without waiting for anything;
   * null otherwise. When it is getting old the sources are asked again behind the caller's back. This is for
   * showing about how many tokens something comes to, and never for an amount to pay.
   */
  shown(): number | null {
    const now = this.now();
    if (!this.last || now - this.last.at >= this.keep) void this.usd().catch(() => { /* remembered as failed; asked again in half a minute */ });
    return this.last && now - this.last.at < LAMPORT_SHOW_SECONDS ? this.last.price : null;
  }

  private async ask(): Promise<number> {
    const sources = lamportSources(this.mint, this.pool);
    const answers = await Promise.all(sources.map(async (s): Promise<LamportAnswer> => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 5000);
      try { const r = await this.fetchImpl(s.url, { signal: ctl.signal }); if (!r.ok) return NOTHING; return s.read(await r.json()); } catch { return NOTHING; } finally { clearTimeout(timer); }
    }));
    return lamportPriceFrom(sources, answers);
  }
}

/**
 * Dollars in cents as whole LAMPORT at a price, rounded up to the token, in the token's smallest units. A
 * whole number of tokens, so that the amount on the page, in the wallet and in the terms is one that can be
 * read at a glance; the rounding is worth less than a hundredth of a cent.
 */
export function lamportFor(cents: number, usdPerToken: number, decimals: number): bigint {
  // in millionths of a millionth of a dollar, so that a price of a few hundred-thousandths of a dollar keeps its digits
  const pico = BigInt(Math.round(usdPerToken * 1e12));
  if (pico <= 0n) throw new Error("no price");
  const tokens = (BigInt(cents) * 10_000_000_000n + pico - 1n) / pico;
  const units = tokens * 10n ** BigInt(decimals);
  if (tokens <= 0n || units >= 2n ** 63n) throw new Error("no amount");
  return units;
}
