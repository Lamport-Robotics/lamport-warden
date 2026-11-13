/**
 * The service's HTTP API: what the Sentinel page and the owner's browser extension talk to.
 *
 * Two kinds of caller, two kinds of proof:
 *   - the Sentinel page, signed in with a wallet signature, holding a session token it sends as a bearer
 *     header (no cookie, so another site cannot ride on it);
 *   - the extension, which holds one token per wallet and may do exactly one thing with it: say "this
 *     signature was mine".
 *
 * `handle` is the whole API as a function of a request, so it is tested without a socket. `listen` puts it
 * behind Node's HTTP server and does the transport's part: size limits, JSON, CORS.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { Accounts, CHANNEL_LIMIT, WALLET_LIMIT, type Refusal } from "./accounts.js";
import { addressBytes, looksLikeSignature } from "./crypto.js";
import { NonceBook, verifySignIn } from "./signin.js";
import type { MemoryStore, StoredEvent } from "./store.js";
import type { Watcher } from "./watcher.js";

export interface ApiRequest {
  method: string;
  /** The path without the query. */
  path: string;
  /** The bearer token, when one was sent. */
  bearer: string | null;
  body: unknown;
  /** Who is asking, for the limits. */
  ip: string;
}
export interface ApiResponse { status: number; body: unknown }

export interface ApiDeps {
  accounts: Accounts;
  store: MemoryStore;
  watcher: Pick<Watcher, "ownerSigned" | "confirmOwn">;
  nonces: NonceBook;
  /** The Sentinel page's origin, like https://warden.lamportrobotics.com. Sign-in texts must name its host. */
  origin: string;
  limiter?: RateLimiter;
  now?: () => number;
  /** How the watching is going, for /v1/health. */
  health?: () => { lastPassAt: number | null; blind: number };
}

/** So many per window, per key. In memory: a restart forgives everyone, which is fine for what these guard. */
export class RateLimiter {
  private hits = new Map<string, { n: number; resetAt: number }>();
  allow(key: string, limit: number, windowSeconds: number, now: number): boolean {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) {
      if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
      this.hits.set(key, { n: 1, resetAt: now + windowSeconds });
      return true;
    }
    h.n += 1;
    return h.n <= limit;
  }
}

const ok = (body: unknown = { ok: true }, status = 200): ApiResponse => ({ status, body });
const no = (status: number, why: string): ApiResponse => ({ status, body: { error: why } });
const refused = (r: Refusal): ApiResponse => no(r.status, r.why);
const SLOW_DOWN = no(429, "too many requests. Wait a minute and try again.");
const text = (v: unknown, max = 4096): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const bytes = (v: unknown, max: number): Uint8Array | null => {
  const s = text(v, max * 2);
  if (!s || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  const b = Buffer.from(s, "base64");
  return b.length > 0 && b.length <= max ? new Uint8Array(b) : null;
};
const field = (body: unknown, name: string): unknown => (body && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined);
const eventView = (e: StoredEvent) => ({ id: e.id, wallet: e.wallet, signature: e.signature || null, at: e.at, level: e.level, signals: e.signals, sentence: e.sentence, canRescue: e.rescueWorthy, answer: e.answer ?? null });

export function api(deps: ApiDeps): (req: ApiRequest) => Promise<ApiResponse> {
  const { accounts, store, watcher, nonces } = deps;
  const limiter = deps.limiter ?? new RateLimiter();
  const now = () => (deps.now ? deps.now() : Math.floor(Date.now() / 1000));
  const host = new URL(deps.origin).host;

  const me = (profile: string) => {
    const p = accounts.profile(profile)!;
    return {
      profile: { id: p.id, tier: p.tier, autoRescue: p.autoRescue, createdAt: p.createdAt },
      wallets: accounts.walletsOf(profile).map((address) => ({
        address,
        armed: !!store.wallets().find((w) => w.address === address)?.sentinelDelegate,
        reporting: accounts.reporting(address),
        // null until the first read: the page says "not watched yet" rather than nothing
        lastReadAt: store.record(address).lastSeenAt,
      })),
      channels: accounts.channelsOf(profile).map((c) => ({ id: c.id, kind: c.kind, hint: c.hint })),
      limits: { wallets: WALLET_LIMIT[p.tier], channels: CHANNEL_LIMIT },
    };
  };

  return async (req) => {
    const t = now();
    const parts = req.path.split("/").filter(Boolean);
    if (parts[0] !== "v1") return no(404, "there is nothing at that address.");
    const route = `${req.method} /${parts.slice(1).join("/")}`;

    if (route === "GET /health") {
      const h = deps.health?.() ?? { lastPassAt: null, blind: 0 };
      return ok({ ok: true, watching: store.wallets().length, lastPassAt: h.lastPassAt, blind: h.blind });
    }

    // ---- the extension: "this signature was mine"
    if (route === "POST /report") {
      const wallet = text(field(req.body, "wallet"), 44);
      const signature = field(req.body, "signature");
      if (!wallet || !addressBytes(wallet) || !looksLikeSignature(signature)) return no(400, "a report names a wallet and a transaction signature.");
      // the same answer whether the wallet is unknown or the token is wrong
      if (!accounts.mayReport(wallet, req.bearer)) return no(401, "that report token is not valid for that wallet.");
      if (!limiter.allow(`report:${wallet}`, 240, 3600, t)) return SLOW_DOWN;
      // noted at once; written when the wallet is next free, so the answer does not wait on a pass
      void watcher.ownerSigned(wallet, signature).catch(() => undefined);
      return ok({ ok: true }, 202);
    }

    // ---- signing in
    const session = accounts.session(req.bearer, t);

    if (route === "POST /nonce") {
      if (!limiter.allow(`nonce:${req.ip}`, 30, 60, t)) return SLOW_DOWN;
      const purpose = field(req.body, "purpose") === "link" ? "link" : "signin";
      if (purpose === "link" && !session) return no(401, "sign in first.");
      return ok({ nonce: nonces.issue(purpose === "link" ? { kind: "link", profile: session! } : { kind: "signin" }, t), host });
    }

    if (route === "POST /signin") {
      if (!limiter.allow(`signin:${req.ip}`, 10, 60, t)) return SLOW_DOWN;
      const address = text(field(req.body, "address"), 44);
      const message = bytes(field(req.body, "message"), 2000);
      const signature = bytes(field(req.body, "signature"), 64);
      if (!address || !message || !signature) return no(400, "a sign-in carries the address, the signed text and the signature.");
      const result = verifySignIn({ address, message, signature }, host, nonces, t);
      if (!result.ok) return no(401, result.why);
      if (result.purpose.kind === "link") {
        // the number was issued to a signed-in profile, and only that profile may spend it
        if (session !== result.purpose.profile) return no(401, "sign in first.");
        const linked = accounts.admit(result.address, session, t);
        return linked.ok ? ok(me(session)) : refused(linked);
      }
      const admitted = accounts.admit(result.address, null, t);
      if (!admitted.ok) return refused(admitted);
      return ok({ session: accounts.startSession(admitted.profile, t), ...me(admitted.profile) });
    }

    // ---- everything below needs a session
    if (!session) return no(401, "sign in first.");
    if (!limiter.allow(`api:${session}`, 300, 60, t)) return SLOW_DOWN;

    if (route === "GET /me") return ok(me(session));
    if (route === "POST /signout") { accounts.endSession(req.bearer!); return ok(); }

    if (parts[1] === "wallets" && parts[2]) {
      const wallet = parts[2];
      if (req.method === "DELETE" && parts.length === 3) {
        const r = accounts.removeWallet(session, wallet);
        return r.ok ? ok({ ok: true, profileRemoved: r.profileRemoved }) : refused(r);
      }
      if (parts[3] === "report-token" && parts.length === 4) {
        if (req.method === "POST") { const r = accounts.newReportToken(session, wallet); return r.ok ? ok({ token: r.token }) : refused(r); }
        if (req.method === "DELETE") return accounts.dropReportToken(session, wallet) ? ok() : no(404, "that wallet is not in this profile.");
      }
    }

    if (route === "POST /channels") {
      if (field(req.body, "kind") !== "ntfy") return no(400, "the only channel so far is ntfy.");
      const r = accounts.addNtfy(session, field(req.body, "target"), t);
      return r.ok ? ok(r.channel, 201) : refused(r);
    }
    if (req.method === "DELETE" && parts[1] === "channels" && parts[2] && parts.length === 3) {
      return accounts.removeChannel(session, parts[2]) ? ok() : no(404, "there is no such channel.");
    }

    if (route === "GET /events") return ok({ events: accounts.eventsOf(session).map(eventView) });

    if (req.method === "POST" && parts[1] === "events" && parts[2] && parts[3] === "answer" && parts.length === 4) {
      const event = accounts.eventOf(session, parts[2]);
      if (!event) return no(404, "there is no such alert.");
      const answer = field(req.body, "answer");
      if (answer === "rescue") return no(501, "rescue is not switched on yet.");
      if (answer !== "this_was_me" && answer !== "ignore") return no(400, "the answer is this_was_me or ignore.");
      store.answer(event.id!, answer);
      // who it paid becomes someone this wallet pays; read from the chain again, not taken from the page
      if (answer === "this_was_me" && event.signature) void watcher.confirmOwn(event.wallet, event.signature).catch(() => undefined);
      return ok();
    }

    return no(404, "there is nothing at that address.");
  };
}

// ---- transport

const MAX_BODY = 16 * 1024;

function readBody(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: number; why: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0, done = false;
    const finish = (r: { ok: true; body: unknown } | { ok: false; status: number; why: string }) => { if (!done) { done = true; resolve(r); } };
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { finish({ ok: false, status: 413, why: "that request is too large." }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("error", () => finish({ ok: false, status: 400, why: "the request could not be read." }));
    req.on("end", () => {
      if (size === 0) return finish({ ok: true, body: undefined });
      try { finish({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch { finish({ ok: false, status: 400, why: "the request is not JSON." }); }
    });
  });
}

/**
 * Which pages may read an answer. The Sentinel page, and nothing else, for everything a session can do. A
 * report comes from the extension's background worker, whose origin differs per install, and it is
 * authorised by its token alone, so that one path answers any origin.
 */
export function corsHeaders(path: string, requestOrigin: string | undefined, pageOrigin: string): Record<string, string> {
  const common = { "Access-Control-Allow-Headers": "authorization, content-type", "Access-Control-Max-Age": "600", Vary: "Origin" };
  if (path === "/v1/report") return { ...common, "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  if (requestOrigin && requestOrigin === pageOrigin) return { ...common, "Access-Control-Allow-Origin": pageOrigin, "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS" };
  return { Vary: "Origin" };
}

export function listen(deps: ApiDeps, opts: { port: number; host?: string; trustProxy?: boolean }): Promise<Server> {
  const handle = api(deps);
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...corsHeaders(url.pathname, origin, deps.origin) };
      const send = (r: ApiResponse) => { res.writeHead(r.status, headers); res.end(JSON.stringify(r.body)); };
      try {
        if (req.method === "OPTIONS") { res.writeHead(204, headers); res.end(); return; }
        const read = await readBody(req);
        if (!read.ok) return send(no(read.status, read.why));
        const auth = typeof req.headers.authorization === "string" ? /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.headers.authorization) : null;
        const forwarded = opts.trustProxy && typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"].split(",")[0]!.trim() : "";
        send(await handle({ method: req.method ?? "GET", path: url.pathname, bearer: auth ? auth[1]! : null, body: read.body, ip: forwarded || req.socket.remoteAddress || "unknown" }));
      } catch (e) {
        // what went wrong stays in the log; the caller is told only that something did
        console.error("sentinel: a request failed", e);
        send(no(500, "something went wrong here."));
      }
    })();
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve(server));
  });
}
