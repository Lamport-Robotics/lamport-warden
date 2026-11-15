/**
 * What a LAMPORT costs in dollars, for turning the plan's price in dollars into an amount of LAMPORT.
 *
 * Three public sources that need no key are asked at once, as for SOL (solprice.ts): a price is given only
 * when at least two of them answer and agree, so one source that is stale, wrong or lying cannot set it
 * alone. They may be a little further apart than for SOL: a small token's price reaches each of them at a
 * different moment.
 *
 * And one thing more, because LAMPORT trades in one small pool. Somebody who pushes its price up for a
 * minute and asks for an amount in that minute would be asked for fewer tokens than the plan costs. So the
 * price used is the lower of the price now and the price an hour ago. A price that is held up for an hour in
 * a pool anyone can sell into is a price; one that is not, buys nothing. The hour-ago price comes from the
 * one source that reports the change over the last hour, and when that source does not answer, or is not
 * among the ones that agree, there is no price and nothing is quoted in LAMPORT (USDC needs no price and is
 * always there). Taking the lower can only ask for more tokens, never fewer, so it is nothing a source can
 * be made to lie in a payer's favour about.
 *
 * The answer is kept for half a minute.
 */
import { agreed, type PriceFetch } from "./solprice.js";

/** How far apart two sources may be and still count as agreeing about LAMPORT. */
export const LAMPORT_AGREE_WITHIN = 0.05;
/** The least and the most a LAMPORT is taken to cost: outside these a number is not a price. */
const LEAST = 1e-9, MOST = 1_000;

/** DexScreener lists every pool a token trades in: the one with the most in it is the one whose price is the token's. */
function deepest(j: any): any {
  const pools: any[] = Array.isArray(j) ? j : Array.isArray(j?.pairs) ? j.pairs : [];
  return [...pools].filter((p) => Number(p?.liquidity?.usd) > 0).sort((a, b) => Number(b.liquidity.usd) - Number(a.liquidity.usd))[0];
}

export const lamportSources = (mint: string): readonly { name: string; url: string; read: (j: any) => unknown }[] => [
  { name: "jupiter", url: `https://lite-api.jup.ag/price/v3?ids=${mint}`, read: (j) => j?.[mint]?.usdPrice },
  { name: "geckoterminal", url: `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}`, read: (j) => j?.data?.attributes?.price_usd },
  { name: "dexscreener", url: `https://api.dexscreener.com/tokens/v1/solana/${mint}`, read: (j) => deepest(j)?.priceUsd },
];
/** The source that also says how the price moved over the last hour. */
const WITH_HISTORY = "dexscreener";

/**
 * The price an hour ago, from the price now and the change over the hour in percent. With no trade in the
 * hour there is no change to report and the price then was the price now. Null when what was reported is
 * not a change at all.
 */
export function hourAgo(now: number, j: any): number | null {
  const pool = deepest(j);
  if (!pool || typeof pool.priceChange !== "object" || pool.priceChange === null) return null;
  if (pool.priceChange.h1 === undefined) return now;
  const change = Number(pool.priceChange.h1);
  if (!Number.isFinite(change) || change <= -100) return null;
  return now / (1 + change / 100);
}

export class LamportPrice {
  private last: { at: number; price: number } | null = null;
  constructor(private mint: string, private fetchImpl: PriceFetch = (u, i) => fetch(u, i), private opts: { now?: () => number; timeoutMs?: number; keepSeconds?: number } = {}) {}
  private now(): number { return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000); }

  /** Dollars for one LAMPORT: the lower of the price now and the price an hour ago. Throws when there is no such price. */
  async usd(): Promise<number> {
    if (this.last && this.now() - this.last.at < (this.opts.keepSeconds ?? 30)) return this.last.price;
    const sources = lamportSources(this.mint);
    const answers = await Promise.all(sources.map(async (s) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 5000);
      try { const r = await this.fetchImpl(s.url, { signal: ctl.signal }); if (!r.ok) return { price: NaN, body: null }; const body = await r.json(); return { price: Number(s.read(body)), body }; } catch { return { price: NaN, body: null }; } finally { clearTimeout(timer); }
    }));
    const now = agreed(answers.map((a) => a.price), LAMPORT_AGREE_WITHIN, LEAST, MOST);
    if (now === null) throw new Error("the price of LAMPORT could not be established: fewer than two sources agree");
    // the hour-ago price is taken only from a source whose own price now is one of those that agree
    const history = answers[sources.findIndex((s) => s.name === WITH_HISTORY)]!;
    if (!(history.price >= now / (1 + LAMPORT_AGREE_WITHIN) && history.price <= now * (1 + LAMPORT_AGREE_WITHIN))) throw new Error("the price of LAMPORT could not be established: no agreeing source says what it was an hour ago");
    const before = hourAgo(history.price, history.body);
    if (before === null || !(before >= LEAST && before <= MOST)) throw new Error("the price of LAMPORT could not be established: what it was an hour ago could not be read");
    const price = Math.min(now, before);
    this.last = { at: this.now(), price };
    return price;
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
