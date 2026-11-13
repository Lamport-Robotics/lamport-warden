/** A Solana JSON-RPC endpoint, as far as the watcher uses one. */
export interface Rpc {
  call(method: string, params: unknown[]): Promise<any>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/**
 * JSON-RPC over HTTP. A refusal for asking too often (429) is waited out and tried again, a few times; any
 * other failure is the caller's to handle, because a watcher that hides an outage is worse than one that
 * says it is blind.
 */
export class HttpRpc implements Rpc {
  constructor(private url: string, private fetchImpl: FetchLike = (u, i) => fetch(u, i), private opts: { timeoutMs?: number; retries?: number; waitMs?: number } = {}) {}

  async call(method: string, params: unknown[]): Promise<any> {
    const { timeoutMs = 10_000, retries = 4, waitMs = 500 } = this.opts;
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await this.fetchImpl(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctl.signal });
        if (res.status === 429 && attempt < retries) { await new Promise((r) => setTimeout(r, waitMs * 2 ** attempt)); continue; }
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
