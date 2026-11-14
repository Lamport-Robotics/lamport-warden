/** A Solana JSON-RPC endpoint, as far as the watcher uses one. */
export interface Rpc {
  /**
   * @param opts.first      true for what nothing else may hold up (a rescue): it goes before all that is waiting
   * @param opts.background true for work that can wait (reading a new wallet's history): it is let through
   *                        only when nothing that cannot wait is asking for the same kind of call
   */
  call(method: string, params: unknown[], opts?: { background?: boolean; first?: boolean }): Promise<any>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; headers?: { get(name: string): string | null } }>;

/**
 * How fast an RPC may be asked, in calls started per ten seconds. An RPC rations some calls far more tightly
 * than others. On the public Solana RPC, measured from the server on 2026-11-13: listing an address's
 * transactions, listing an owner's token accounts, and fetching a transaction are each taken about ten times
 * in ten seconds from one address, each on an allowance of its own (eight of each inside ten seconds: none
 * refused; the eleventh of any one: refused, with "retry after ten seconds"). Reading an account is taken
 * four times a second. Going over costs more than waiting: the refusal closes the window.
 *
 * `heavyPer10s` is for each of the rationed calls separately; `lightPer10s` is for everything else together.
 */
export interface Pace { heavyPer10s?: number; lightPer10s?: number }

/** The calls an RPC rations tightly, each on its own allowance. */
export const HEAVY: ReadonlySet<string> = new Set(["getSignaturesForAddress", "getTokenAccountsByOwner", "getTransaction"]);

/** What the public Solana RPC takes from one address, a little under what was measured. */
export const PUBLIC_RPC_PACE: Pace = { heavyPer10s: 9, lightPer10s: 35 };

/**
 * Lets one call start at a time, spaced evenly: never more than so many in any ten seconds. Whoever cannot
 * wait goes first; work that can wait takes the turns nobody else wants.
 */
class Lane {
  private nextAt = 0;
  private waiting: { go: () => void; background: boolean; first?: boolean }[] = [];
  private running = false;
  constructor(private everyMs: number, private clock: () => number, private sleep: (ms: number) => Promise<void>) {}

  /** `first`: ahead of everyone already waiting, behind only others that asked to be first. */
  turn(background = false, first = false): Promise<void> {
    return new Promise((go) => {
      if (first) { const at = this.waiting.findIndex((w) => !w.first); this.waiting.splice(at < 0 ? this.waiting.length : at, 0, { go, background: false, first: true }); }
      else this.waiting.push({ go, background });
      void this.run();
    });
  }

  /** The RPC said to stay away for a while: nobody of this kind starts before then. */
  holdOff(ms: number): void { this.nextAt = Math.max(this.nextAt, this.clock() + ms); }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.waiting.length > 0) {
        const wait = this.nextAt - this.clock();
        if (wait > 0) await this.sleep(wait);
        if (this.nextAt - this.clock() > 0) continue; // held off while it slept
        // chosen now, not when it joined: something that cannot wait may have arrived in the meantime
        const urgent = this.waiting.findIndex((w) => !w.background);
        const [next] = this.waiting.splice(urgent >= 0 ? urgent : 0, 1);
        this.nextAt = this.clock() + this.everyMs;
        next!.go();
      }
    } finally {
      this.running = false;
    }
  }
}

/**
 * JSON-RPC over HTTP, at a pace the RPC will take. A refusal for asking too often (429) is waited out, for as
 * long as the RPC says, and tried again a few times; any other failure is the caller's to handle, because a
 * watcher that hides an outage is worse than one that says it is blind.
 */
export class HttpRpc implements Rpc {
  private lanes = new Map<string, Lane>();
  private clock: () => number;
  private sleep: (ms: number) => Promise<void>;

  constructor(private url: string, private fetchImpl: FetchLike = (u, i) => fetch(u, i), private opts: { timeoutMs?: number; retries?: number; waitMs?: number; pace?: Pace; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
    this.clock = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The lane a call waits its turn in: one for each rationed call, one for all the rest. Null when that kind is not paced. */
  private laneFor(method: string): Lane | null {
    const heavy = HEAVY.has(method);
    const per10s = heavy ? this.opts.pace?.heavyPer10s : this.opts.pace?.lightPer10s;
    if (!per10s || per10s <= 0) return null;
    const name = heavy ? method : "";
    let lane = this.lanes.get(name);
    if (!lane) { lane = new Lane(10_000 / per10s, this.clock, this.sleep); this.lanes.set(name, lane); }
    return lane;
  }

  /** How many of one rationed call this may start in a minute, or null when it is not paced. */
  get heavyPerMinute(): number | null { return this.opts.pace?.heavyPer10s ? this.opts.pace.heavyPer10s * 6 : null; }

  async call(method: string, params: unknown[], opts: { background?: boolean; first?: boolean } = {}): Promise<any> {
    const { timeoutMs = 10_000, retries = 4, waitMs = 500 } = this.opts;
    const lane = this.laneFor(method);
    for (let attempt = 0; ; attempt++) {
      await lane?.turn(opts.background === true, opts.first === true);
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
