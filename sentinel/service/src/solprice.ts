/**
 * What a SOL costs in dollars, for quoting a price in SOL.
 *
 * Three public sources that need no key are asked at once. A price is given only when at least two of them
 * answer and agree to within two in a hundred; one source that is stale, wrong or lying cannot set a price
 * on its own, and when they do not agree nothing is quoted in SOL at all (USDC needs no price and is always
 * there). The answer is kept for half a minute.
 */
export type PriceFetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<any> }>;

const SOL = "So11111111111111111111111111111111111111112";
export const SOURCES: readonly { name: string; url: string; read: (j: any) => unknown }[] = [
  { name: "coinbase", url: "https://api.coinbase.com/v2/prices/SOL-USD/spot", read: (j) => j?.data?.amount },
  { name: "kraken", url: "https://api.kraken.com/0/public/Ticker?pair=SOLUSD", read: (j) => j?.result?.SOLUSD?.c?.[0] },
  { name: "jupiter", url: `https://lite-api.jup.ag/price/v3?ids=${SOL}`, read: (j) => j?.[SOL]?.usdPrice },
];
/** How far apart two sources may be and still count as agreeing. */
export const AGREE_WITHIN = 0.02;

/** The price two or more of these agree on (their mean), or null when no two do. */
export function agreed(prices: number[]): number | null {
  const sane = prices.filter((p) => Number.isFinite(p) && p > 0.01 && p < 1_000_000).sort((a, b) => a - b);
  let best: number[] = [];
  for (let i = 0; i < sane.length; i++) {
    const close = sane.filter((p) => p >= sane[i]! && p <= sane[i]! * (1 + AGREE_WITHIN));
    if (close.length > best.length) best = close;
  }
  return best.length >= 2 ? best.reduce((a, b) => a + b, 0) / best.length : null;
}

export class SolPrice {
  private last: { at: number; price: number } | null = null;
  constructor(private fetchImpl: PriceFetch = (u, i) => fetch(u, i), private opts: { now?: () => number; timeoutMs?: number; keepSeconds?: number } = {}) {}
  private now(): number { return this.opts.now ? this.opts.now() : Math.floor(Date.now() / 1000); }

  /** Dollars for one SOL. Throws when fewer than two sources agree. */
  async usd(): Promise<number> {
    if (this.last && this.now() - this.last.at < (this.opts.keepSeconds ?? 30)) return this.last.price;
    const answers = await Promise.all(SOURCES.map(async (s) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 5000);
      try { const r = await this.fetchImpl(s.url, { signal: ctl.signal }); return r.ok ? Number(s.read(await r.json())) : NaN; } catch { return NaN; } finally { clearTimeout(timer); }
    }));
    const price = agreed(answers);
    if (price === null) throw new Error("the price of SOL could not be established: fewer than two sources agree");
    this.last = { at: this.now(), price };
    return price;
  }
}
