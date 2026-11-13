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
import { Accounts, type Refusal } from "./accounts.js";
import { PLANS } from "./plans.js";
import { verifyStripeSignature, type Billing } from "./billing.js";
import { addressBytes, looksLikeSignature } from "./crypto.js";
import { channelAddedNotice, channelRemovedNotice, reportLinkedNotice, signedInNotice, takerTrustedNotice, walletRemovedNotice } from "./notices.js";
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
  /** The body as it arrived, and Stripe's signature over it: a webhook is checked against the bytes, not the parse. */
  raw?: string;
  stripeSignature?: string;
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
  health?: () => { lastPassAt: number | null; blind: number; late?: number; push?: "on" | "down" | "off" };
  /** The paid tier. Absent: there is no paid tier, and the page is told so. */
  billing?: { api: Billing; webhookSecret: string };
  /** Sends a test to one of a profile's channels. */
  testChannel?: (profile: string, channelId: string) => Promise<{ ok: true } | { ok: false; status: number; why: string }>;
  /**
   * Tells a profile's owner, through the channels it has at the moment of the call, that the profile changed
   * (notices.ts). The addresses are taken when it is called, so a notice about a removal is called for first.
   */
  notice?: (profile: string, sentence: string, opts?: { quiet?: boolean }) => Promise<void>;
  /** How many new profiles one network may start in a day (default 5). */
  newProfilesPerDay?: number;
  /** Told when a webhook that Stripe signed could not be applied: Stripe will send it again, and someone should know. */
  webhookFailed?: (why: string) => void;
}

/**
 * One caller, for the limits. An IPv4 address stands for itself. An IPv6 address stands for its /64: one
 * subscriber is handed a whole /64, and counting each of its addresses separately would count nothing.
 */
export function networkOf(ip: string): string {
  const bare = ip.split("%")[0]!.trim().toLowerCase();
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (v4) return v4[1]!;
  if (!bare.includes(":")) return bare;
  const [head = "", tail] = bare.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
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
const TOO_MANY_CHANGES = no(429, "this profile was changed many times in the last hour. Wait a while and try again.");
const text = (v: unknown, max = 4096): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const bytes = (v: unknown, max: number): Uint8Array | null => {
  const s = text(v, max * 2);
  if (!s || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  const b = Buffer.from(s, "base64");
  return b.length > 0 && b.length <= max ? new Uint8Array(b) : null;
};
const field = (body: unknown, name: string): unknown => (body && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined);
const eventView = (e: StoredEvent) => ({ id: e.id, wallet: e.wallet, signature: e.signature || null, at: e.at, level: e.level, signals: e.signals, sentence: e.sentence, canRescue: e.rescueWorthy, answer: e.answer ?? null, undelivered: e.undelivered === true });

export function api(deps: ApiDeps): (req: ApiRequest) => Promise<ApiResponse> {
  const { accounts, store, watcher, nonces } = deps;
  const limiter = deps.limiter ?? new RateLimiter();
  const now = () => (deps.now ? deps.now() : Math.floor(Date.now() / 1000));
  const host = new URL(deps.origin).host;
  // sent, not waited for: the addresses are read as this is called, and the answer does not wait on a slow channel
  const notice = (profile: string, sentence: string, opts?: { quiet?: boolean }) => { void deps.notice?.(profile, sentence, opts).catch(() => undefined); };

  const me = (profile: string) => {
    const p = accounts.profile(profile)!;
    return {
      profile: { id: p.id, tier: p.tier, autoRescue: p.autoRescue, createdAt: p.createdAt },
      wallets: accounts.walletsOf(profile).map((address) => ({
        address,
        armed: !!store.wallets().find((w) => w.address === address)?.sentinelDelegate,
        reporting: accounts.reporting(address),
        // over the plan's limit: kept, not read
        paused: accounts.paused(address),
        // null until the first read: the page says "not watched yet" rather than nothing
        lastReadAt: store.record(address).lastSeenAt,
      })),
      // `active`: alerts go there now. A channel the plan does not cover stays listed, and unused.
      channels: accounts.channelViews(profile),
      limits: { wallets: PLANS[p.tier].wallets, channels: PLANS[p.tier].channels, kinds: PLANS[p.tier].kinds, pollSeconds: PLANS[p.tier].pollSeconds, push: PLANS[p.tier].push },
    };
  };

  return async (req) => {
    const t = now();
    const from = networkOf(req.ip);
    const parts = req.path.split("/").filter(Boolean);
    if (parts[0] !== "v1") return no(404, "there is nothing at that address.");
    const route = `${req.method} /${parts.slice(1).join("/")}`;

    if (route === "GET /health") {
      const h = deps.health?.() ?? { lastPassAt: null, blind: 0 };
      // late: read, but slower than their plan promises
      // push: whether the RPC is telling the service of transactions as they happen ("down": asked to, and the line is not up)
      return ok({ ok: true, watching: store.wallets().length, lastPassAt: h.lastPassAt, blind: h.blind, late: h.late ?? 0, push: h.push ?? "off" });
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

    // ---- Stripe: a subscription started, changed or ended. Believed only with Stripe's signature over the exact body.
    if (route === "POST /stripe/webhook") {
      if (!deps.billing) return no(404, "there is nothing at that address.");
      if (!verifyStripeSignature(req.raw ?? "", req.stripeSignature, deps.billing.webhookSecret, t)) return no(400, "that is not signed by Stripe.");
      let event: unknown;
      try { event = JSON.parse(req.raw ?? ""); } catch { return no(400, "the request is not JSON."); }
      // a failure here is answered with an error so that Stripe sends it again
      try { await deps.billing.api.onEvent(event); } catch (e) { deps.webhookFailed?.(String((e as Error).message ?? e)); throw e; }
      return ok({ received: true });
    }

    // ---- signing in
    const who = accounts.sessionOf(req.bearer, t);
    const session = who?.profile ?? null;

    if (route === "POST /nonce") {
      if (!limiter.allow(`nonce:${from}`, 30, 60, t)) return SLOW_DOWN;
      const purpose = field(req.body, "purpose") === "link" ? "link" : "signin";
      if (purpose === "link" && !session) return no(401, "sign in first.");
      return ok({ nonce: nonces.issue(purpose === "link" ? { kind: "link", profile: session! } : { kind: "signin" }, t), host });
    }

    if (route === "POST /signin") {
      if (!limiter.allow(`signin:${from}`, 10, 60, t)) return SLOW_DOWN;
      const address = text(field(req.body, "address"), 44);
      const message = bytes(field(req.body, "message"), 2000);
      const signature = bytes(field(req.body, "signature"), 64);
      if (!address || !message || !signature) return no(400, "a sign-in carries the address, the signed text and the signature.");
      const result = verifySignIn({ address, message, signature }, host, nonces, t);
      if (!result.ok) return no(401, result.why);
      if (result.purpose.kind === "link") {
        // the number was issued to a signed-in profile, and only that profile may spend it
        if (session !== result.purpose.profile) return no(401, "sign in first.");
        // a wallet's first read costs a few hundred RPC calls: adding and removing one in a loop is not allowed to spend them
        if (accounts.profileOf(result.address) === undefined && !limiter.allow(`link:${session}`, 10, 86_400, t)) return no(429, "this profile added many wallets today. Try again tomorrow.");
        const linked = accounts.admit(result.address, session, t);
        return linked.ok ? ok(me(session)) : refused(linked);
      }
      // There is room for only so many wallets, and each new one is read from its history. One network starts a
      // few profiles a day, so that one visitor cannot take every place or spend the RPC on wallets made up for it.
      if (accounts.profileOf(result.address) === undefined && !limiter.allow(`create:${from}`, deps.newProfilesPerDay ?? 5, 86_400, t)) return no(429, "too many new profiles were started from this network today. Try again tomorrow.");
      const admitted = accounts.admit(result.address, null, t);
      if (!admitted.ok) return refused(admitted);
      // the owner hears of every sign-in to a profile that already had channels; a few an hour, then no more is said
      if (!admitted.created && limiter.allow(`signin-notice:${admitted.profile}`, 6, 3600, t)) notice(admitted.profile, signedInNotice(result.address), { quiet: true });
      return ok({ session: accounts.startSession(admitted.profile, t, result.address), ...me(admitted.profile) });
    }

    // ---- everything below needs a session
    if (!session) return no(401, "sign in first.");
    if (!limiter.allow(`api:${session}`, 300, 60, t)) return SLOW_DOWN;

    if (route === "GET /me") return ok(me(session));
    if (route === "POST /signout") { accounts.endSession(req.bearer!); return ok(); }

    if (parts[1] === "wallets" && parts[2]) {
      const wallet = parts[2];
      if (req.method === "DELETE" && parts.length === 3) {
        const may = accounts.mayRemoveWallet(session, wallet);
        if (!may.ok) return refused(may);
        if (!limiter.allow(`change:${session}`, 20, 3600, t)) return TOO_MANY_CHANGES;
        // said first, to the channels the profile still has
        notice(session, walletRemovedNotice(wallet, may.last, who!.wallet));
        const r = accounts.removeWallet(session, wallet);
        return r.ok ? ok({ ok: true, profileRemoved: r.profileRemoved }) : refused(r);
      }
      if (parts[3] === "report-token" && parts.length === 4) {
        if (req.method === "POST") {
          if (accounts.profileOf(wallet) === session && !limiter.allow(`change:${session}`, 20, 3600, t)) return TOO_MANY_CHANGES;
          const r = accounts.newReportToken(session, wallet);
          if (!r.ok) return refused(r);
          // what this browser reports from now on softens alerts, so the owner hears that one was linked
          notice(session, reportLinkedNotice(wallet, who!.wallet));
          return ok({ token: r.token });
        }
        if (req.method === "DELETE") return accounts.dropReportToken(session, wallet) ? ok() : no(404, "that wallet is not in this profile.");
      }
    }

    if (route === "POST /channels") {
      // what kind of channel it is, is read from the address itself, never taken from the caller
      if (!limiter.allow(`change:${session}`, 20, 3600, t)) return TOO_MANY_CHANGES;
      const r = accounts.addChannel(session, field(req.body, "target"), t);
      if (!r.ok) return refused(r);
      notice(session, channelAddedNotice(r.channel.hint, who!.wallet));
      return ok(r.channel, 201);
    }
    if (req.method === "DELETE" && parts[1] === "channels" && parts[2] && parts.length === 3) {
      const channel = accounts.channelView(session, parts[2]);
      if (!channel) return no(404, "there is no such channel.");
      if (!limiter.allow(`change:${session}`, 20, 3600, t)) return TOO_MANY_CHANGES;
      // said first, and to the channel that is going: a channel alerts do not go to is removed without a word
      if (channel.active) notice(session, channelRemovedNotice(channel.hint, who!.wallet));
      return accounts.removeChannel(session, parts[2]) ? ok() : no(404, "there is no such channel.");
    }
    if (req.method === "POST" && parts[1] === "channels" && parts[2] && parts[3] === "test" && parts.length === 4) {
      if (!deps.testChannel) return no(501, "test alerts are not switched on here.");
      // a few at a time: this sends a message somewhere on the owner's say-so, and nothing should be made to send many
      if (!limiter.allow(`test:${session}`, 5, 600, t)) return SLOW_DOWN;
      const r = await deps.testChannel(session, parts[2]);
      return r.ok ? ok() : no(r.status, r.why);
    }

    if (route === "GET /billing") return ok(deps.billing ? await deps.billing.api.quote(session) : { enabled: false });
    if (route === "POST /billing/checkout" || route === "POST /billing/portal") {
      if (!deps.billing) return no(404, "there is no paid plan here.");
      if (!limiter.allow(`billing:${session}`, 10, 600, t)) return SLOW_DOWN;
      const r = route.endsWith("checkout") ? await deps.billing.api.checkout(session) : await deps.billing.api.portal(session);
      return r.ok ? ok({ url: r.url }) : no(r.status, r.why);
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
      if (answer === "this_was_me" && event.signature) {
        const takers = event.takers ?? [];
        // For a taking under a permission it also makes that permission's holder familiar, which is less
        // protection from then on: the profile's channels are told, once it has in fact been done.
        void watcher.confirmOwn(event.wallet, event.signature).then((done) => { if (done && takers.length > 0) notice(session, takerTrustedNotice(takers, event.wallet, who!.wallet)); }).catch(() => undefined);
      }
      return ok();
    }

    return no(404, "there is nothing at that address.");
  };
}

// ---- transport

const MAX_BODY = 16 * 1024;

function readBody(req: IncomingMessage, keepRaw: boolean): Promise<{ ok: true; body: unknown; raw?: string } | { ok: false; status: number; why: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0, done = false;
    const finish = (r: { ok: true; body: unknown; raw?: string } | { ok: false; status: number; why: string }) => { if (!done) { done = true; resolve(r); } };
    const limit = keepRaw ? 256 * 1024 : MAX_BODY; // Stripe's events are larger than anything the page sends
    req.on("data", (c: Buffer) => {
      size += c.length;
      // the rest is read and dropped, so the caller gets the answer instead of a closed connection
      if (size > limit) { chunks.length = 0; finish({ ok: false, status: 413, why: "that request is too large." }); return; }
      chunks.push(c);
    });
    req.on("error", () => finish({ ok: false, status: 400, why: "the request could not be read." }));
    req.on("end", () => {
      if (done) return;
      if (size === 0) return finish({ ok: true, body: undefined });
      const raw = Buffer.concat(chunks).toString("utf8");
      // a webhook is parsed after its signature is checked, from these same bytes
      if (keepRaw) return finish({ ok: true, body: undefined, raw });
      try { finish({ ok: true, body: JSON.parse(raw) }); } catch { finish({ ok: false, status: 400, why: "the request is not JSON." }); }
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
        const webhook = url.pathname === "/v1/stripe/webhook";
        const read = await readBody(req, webhook);
        if (!read.ok) {
          // nothing more is taken on this connection once it has sent too much
          if (read.status === 413) { res.setHeader("Connection", "close"); res.once("finish", () => req.destroy()); }
          return send(no(read.status, read.why));
        }
        const auth = typeof req.headers.authorization === "string" ? /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.headers.authorization) : null;
        // the last address is the one the proxy in front wrote; anything before it is whatever the caller sent
        const forwarded = opts.trustProxy && typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"].split(",").at(-1)!.trim() : "";
        const stripeSignature = webhook && typeof req.headers["stripe-signature"] === "string" ? req.headers["stripe-signature"] : undefined;
        send(await handle({ method: req.method ?? "GET", path: url.pathname, bearer: auth ? auth[1]! : null, body: read.body, ip: forwarded || req.socket.remoteAddress || "unknown", raw: read.raw, stripeSignature }));
      } catch (e) {
        // what went wrong stays in the log; the caller is told only that something did
        console.error("sentinel: a request failed", e);
        // an answer that was already under way is cut off; nothing here may throw, or the process would end
        try { if (res.headersSent) res.destroy(); else send(no(500, "something went wrong here.")); } catch { res.destroy(); }
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
