/** A Solana JSON-RPC endpoint, as far as the watcher uses one. */
export interface Rpc {
  call(method: string, params: unknown[]): Promise<any>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; headers?: { get(name: string): string | null } }>;

/**
 * How fast an RPC may be asked, in calls started per ten seconds. An RPC rations some calls far more tightly
 * than others: on the public Solana RPC, listing an address's transactions and listing an owner's token
 * accounts are each taken about ten times in ten seconds from one address, and everything else about four
 * times as often (measured from the server on 2026-11-13: at two a second, half were refused, each refusal
 * with "retry after ten seconds"). Going over costs more than waiting: the refusal closes the window.
 */
export interface Pace { heavyPer10s?: number; lightPer10s?: number }

/** The calls an RPC rations tightly. */
export const HEAVY: ReadonlySet<string> = new Set(["getSignaturesForAddress", "getTokenAccountsByOwner"]);

/** What the public Solana RPC takes from one address, a little under what was measured. */
export const PUBLIC_RPC_PACE: Pace = { heavyPer10s: 9, lightPer10s: 35 };

/** Lets one call start at a time, spaced evenly: never more than `per10s` in any ten seconds. */
class Spacing {
  private next = 0;
  constructor(private everyMs: number, private clock: () => number, private sleep: (ms: number) => Promise<void>) {}
  async turn(): Promise<void> {
    const now = this.clock();
    const at = Math.max(now, this.next);
    this.next = at + this.everyMs;
    if (at > now) await this.sleep(at - now);
  }
  /** The RPC said to stay away for a while: nobody of this kind starts before then. */
  holdOff(ms: number): void { this.next = Math.max(this.next, this.clock() + ms); }
}

/**
 * JSON-RPC over HTTP, at a pace the RPC will take. A refusal for asking too often (429) is waited out, for as
 * long as the RPC says, and tried again a few times; any other failure is the caller's to handle, because a
 * watcher that hides an outage is worse than one that says it is blind.
 */
export class HttpRpc implements Rpc {
  private heavy: Spacing | null;
  private light: Spacing | null;
  private clock: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private url: string, private fetchImpl: FetchLike = (u, i) => fetch(u, i), private opts: { timeoutMs?: number; retries?: number; waitMs?: number; pace?: Pace; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.clock = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const spacing = (per10s: number | undefined) => (per10s && per10s > 0 ? new Spacing(10_000 / per10s, this.clock, this.sleep) : null);
    this.heavy = spacing(opts.pace?.heavyPer10s);
    this.light = spacing(opts.pace?.lightPer10s);
  }

  /** How many of the rationed calls this may start in a minute, or null when it is not paced. */
  get heavyPerMinute(): number | null { return this.opts.pace?.heavyPer10s ? this.opts.pace.heavyPer10s * 6 : null; }

  async call(method: string, params: unknown[]): Promise<any> {
    const { timeoutMs = 10_000, retries = 4, waitMs = 500 } = this.opts;
    const lane = HEAVY.has(method) ? this.heavy : this.light;
    for (let attempt = 0; ; attempt++) {
      await lane?.turn();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await this.fetchImpl(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctl.signal });
        if (res.status === 429 && attempt < retries) {
          // as long as the RPC says, when it says; never more than half a minute on its word alone
          const told = Number(res.headers?.get("retry-after"));
          const wait = Number.isFinite(told) && told > 0 ? Math.min(told, 30) * 1000 : waitMs * 2 ** attempt;
          if (lane) lane.holdOff(wait); else await this.sleep(wait);
          continue;
        }
        if (!res.ok) throw new Error(`${method}: the RPC answered ${res.status}`);
        const body = await res.json();
        if (body?.error) throw new Error(`${method}: ${String(body.error.message ?? "RPC error")}`);
        return body?.result;
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
