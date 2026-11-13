/**
 * The process: the watcher on a timer, and the API beside it. It holds no signing key. Everything it needs
 * comes from the environment, and it refuses to start without the parts that keep owners' data closed.
 *
 *   SENTINEL_RPC_URL      the Solana RPC to read from (required)
 *   SENTINEL_DATA_KEY     32 random bytes in base64, sealing where alerts go (required; `openssl rand -base64 32`)
 *   SENTINEL_DATA_DIR     where the one data file lives (default ./sentinel-data)
 *   SENTINEL_ORIGIN       the Sentinel page's origin (default https://warden.lamportrobotics.com)
 *   SENTINEL_PORT         the API's port on 127.0.0.1 (default 8791); a web server in front adds TLS
 *   SENTINEL_POLL_SECONDS how often a wallet on the free plan is read (default 60, as the plan says)
 *   SENTINEL_PRO_POLL_SECONDS  how often a wallet on the paid plan is read (default 20, as the plan says)
 *   SENTINEL_NTFY_HOSTS   ntfy hosts alerts may go to, comma-separated (default ntfy.sh)
 *   SENTINEL_TRUST_PROXY  "1" when a proxy this process trusts sets X-Forwarded-For
 *   SENTINEL_MAX_WALLETS  how many wallets it watches in all (default 100): each costs RPC calls every round
 *   SENTINEL_RESERVED_FOR_PRO  how many of those places are kept for profiles on the paid plan (default: a
 *                         fifth of them when the paid plan is set up, none when it is not)
 *   SENTINEL_OPS_CHANNEL  where whoever runs the service is told what no owner can act on (ops.ts): an ntfy
 *                         topic on one of the hosts above, or a Discord or Slack webhook. Unset: only the log.
 *
 * The paid plan is there only when all four of these are set, and nothing is sold until checkout is opened:
 *   SENTINEL_STRIPE_SECRET_KEY, SENTINEL_STRIPE_WEBHOOK_SECRET
 *   SENTINEL_STRIPE_PRICE_FULL, SENTINEL_STRIPE_PRICE_HOLDER   the two monthly price ids (scripts/stripe-sentinel-setup.mjs)
 *   SENTINEL_STRIPE_PORTAL_CONFIG   the customer portal the setup script made (optional)
 *   SENTINEL_CHECKOUT          "open" to sell; anything else keeps checkout closed and honours existing subscriptions
 *   SENTINEL_PRICE_CENTS, SENTINEL_HOLDER_PRICE_CENTS          what the page shows (default 1500 and 1000)
 *   SENTINEL_HOLDER_MINT, SENTINEL_HOLDER_MIN                  the token and whole-token amount for the holder price
 *                                                              (default $LAMPORT, 250000)
 *   SENTINEL_HOLDER_RPC_URL    a mainnet RPC for the holder check, when SENTINEL_RPC_URL is not mainnet
 */
import { join } from "node:path";
import { Accounts, cleanTarget } from "./accounts.js";
import { Billing, Stripe, type BillingConfig } from "./billing.js";
import { dataKeyFrom } from "./crypto.js";
import { Blindness, RESUMED_SENTENCE, stoppedSentence } from "./blindness.js";
import { ChannelNotifier } from "./notify.js";
import { Ops } from "./ops.js";
import { PLANS, type ChannelKind } from "./plans.js";
import { HttpRpc } from "./rpc.js";
import { listen } from "./server.js";
import { NonceBook } from "./signin.js";
import { FileStore, type MemoryStore, type StoredEvent } from "./store.js";
import { Watcher, type Notifier } from "./watcher.js";

export interface Config { rpcUrl: string; dataKey: Buffer; dataDir: string; origin: string; port: number; pollSeconds: number; proPollSeconds: number; maxWallets: number; reservedForPro: number; ntfyHosts: Set<string>; trustProxy: boolean; opsChannel: { kind: ChannelKind; url: string } | null; billing: (BillingConfig & { holderRpcUrl: string }) | null }

/** $LAMPORT, the same token the Pincer1 holder price reads. */
export const LAMPORT_MINT = "D4CzGsZgusVj2K8R1its5H8WWdo9mazbDwBc6qvsmfun";

function billingFrom(env: Record<string, string | undefined>, origin: string, rpcUrl: string): { ok: true; billing: Config["billing"] } | { ok: false; why: string } {
  const names = ["SENTINEL_STRIPE_SECRET_KEY", "SENTINEL_STRIPE_WEBHOOK_SECRET", "SENTINEL_STRIPE_PRICE_FULL", "SENTINEL_STRIPE_PRICE_HOLDER"] as const;
  const set = names.filter((n) => (env[n] ?? "") !== "");
  if (set.length === 0) return { ok: true, billing: null };
  // half a payment setup is worse than none: it would take money and not know it
  if (set.length < names.length) return { ok: false, why: `the paid plan needs all of ${names.join(", ")}; missing ${names.filter((n) => !set.includes(n)).join(", ")}.` };
  if (!/^price_[A-Za-z0-9]+$/.test(env.SENTINEL_STRIPE_PRICE_FULL!) || !/^price_[A-Za-z0-9]+$/.test(env.SENTINEL_STRIPE_PRICE_HOLDER!) || env.SENTINEL_STRIPE_PRICE_FULL === env.SENTINEL_STRIPE_PRICE_HOLDER) return { ok: false, why: "SENTINEL_STRIPE_PRICE_FULL and SENTINEL_STRIPE_PRICE_HOLDER have to be two different Stripe price ids." };
  const cents = (name: string, fallback: number) => { const v = Number(env[name] ?? fallback); return Number.isInteger(v) && v > 0 ? v : null; };
  const centsFull = cents("SENTINEL_PRICE_CENTS", 1500), centsHolder = cents("SENTINEL_HOLDER_PRICE_CENTS", 1000), holderMin = cents("SENTINEL_HOLDER_MIN", 250_000);
  if (!centsFull || !centsHolder || !holderMin) return { ok: false, why: "SENTINEL_PRICE_CENTS, SENTINEL_HOLDER_PRICE_CENTS and SENTINEL_HOLDER_MIN have to be whole numbers above zero." };
  return { ok: true, billing: {
    secretKey: env.SENTINEL_STRIPE_SECRET_KEY!, webhookSecret: env.SENTINEL_STRIPE_WEBHOOK_SECRET!, priceFull: env.SENTINEL_STRIPE_PRICE_FULL!, priceHolder: env.SENTINEL_STRIPE_PRICE_HOLDER!,
    centsFull, centsHolder, holderMint: env.SENTINEL_HOLDER_MINT || LAMPORT_MINT, holderMin, pageUrl: `${origin}/sentinel/`, checkoutOpen: env.SENTINEL_CHECKOUT === "open",
    holderRpcUrl: env.SENTINEL_HOLDER_RPC_URL || rpcUrl,
    ...(/^bpc_[A-Za-z0-9]+$/.test(env.SENTINEL_STRIPE_PORTAL_CONFIG ?? "") ? { portalConfiguration: env.SENTINEL_STRIPE_PORTAL_CONFIG } : {}),
  } };
}

/** Reads the configuration, or says in one sentence what is missing. */
export function configFrom(env: Record<string, string | undefined>): { ok: true; config: Config } | { ok: false; why: string } {
  const rpcUrl = env.SENTINEL_RPC_URL ?? "";
  try { if (!/^https?:$/.test(new URL(rpcUrl).protocol)) throw new Error(); } catch { return { ok: false, why: "SENTINEL_RPC_URL has to be the address of a Solana RPC." }; }
  const dataKey = dataKeyFrom(env.SENTINEL_DATA_KEY);
  if (!dataKey) return { ok: false, why: "SENTINEL_DATA_KEY has to be 32 random bytes in base64 (openssl rand -base64 32)." };
  let origin: string;
  try { origin = new URL(env.SENTINEL_ORIGIN ?? "https://warden.lamportrobotics.com").origin; } catch { return { ok: false, why: "SENTINEL_ORIGIN has to be the Sentinel page's address." }; }
  const port = Number(env.SENTINEL_PORT ?? 8791);
  const pollSeconds = Number(env.SENTINEL_POLL_SECONDS ?? PLANS.watch.pollSeconds);
  // unless set, the paid plan's pace is the plan's own, or the free one's when that is already faster
  const proPollSeconds = Number(env.SENTINEL_PRO_POLL_SECONDS ?? Math.min(PLANS.pro.pollSeconds, Number.isFinite(pollSeconds) ? pollSeconds : PLANS.pro.pollSeconds));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, why: "SENTINEL_PORT has to be a port number." };
  if (!Number.isFinite(pollSeconds) || pollSeconds < 5) return { ok: false, why: "SENTINEL_POLL_SECONDS has to be 5 or more." };
  // the paid plan is sold as the faster one: a setting that made it slower would make the page a lie
  if (!Number.isFinite(proPollSeconds) || proPollSeconds < 5 || proPollSeconds > pollSeconds) return { ok: false, why: "SENTINEL_PRO_POLL_SECONDS has to be 5 or more, and no more than SENTINEL_POLL_SECONDS." };
  const maxWallets = Number(env.SENTINEL_MAX_WALLETS ?? 100);
  if (!Number.isInteger(maxWallets) || maxWallets < 1) return { ok: false, why: "SENTINEL_MAX_WALLETS has to be a whole number above zero." };
  const ntfyHosts = new Set((env.SENTINEL_NTFY_HOSTS ?? "ntfy.sh").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
  const opsChannel = env.SENTINEL_OPS_CHANNEL ? cleanTarget(env.SENTINEL_OPS_CHANNEL, ntfyHosts) : null;
  if (env.SENTINEL_OPS_CHANNEL && !opsChannel) return { ok: false, why: "SENTINEL_OPS_CHANNEL has to be an ntfy topic on an allowed host, or a Discord or Slack webhook." };
  const billing = billingFrom(env, origin, rpcUrl);
  if (!billing.ok) return billing;
  // room kept for those who pay: only when there is something to pay for
  const reservedForPro = Number(env.SENTINEL_RESERVED_FOR_PRO ?? (billing.billing ? Math.floor(maxWallets / 5) : 0));
  if (!Number.isInteger(reservedForPro) || reservedForPro < 0 || reservedForPro >= maxWallets) return { ok: false, why: "SENTINEL_RESERVED_FOR_PRO has to be a whole number, zero or more, and less than SENTINEL_MAX_WALLETS." };
  return { ok: true, config: { rpcUrl, dataKey, dataDir: env.SENTINEL_DATA_DIR ?? "./sentinel-data", origin, port, pollSeconds, proPollSeconds, maxWallets, reservedForPro, ntfyHosts, trustProxy: env.SENTINEL_TRUST_PROXY === "1", opsChannel, billing: billing.billing } };
}

/**
 * Reads every wallet, again and again, never two rounds at once. A round that fails is logged and the next
 * one still runs: a watcher that stops quietly is the failure this exists to prevent.
 */
export function startRounds(round: () => Promise<void>, everySeconds: number, log: (line: string) => void = console.error): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try { await round(); } catch (e) { log(`sentinel: a round failed: ${String((e as Error).message ?? e)}`); }
    if (!stopped) timer = setTimeout(tick, everySeconds * 1000);
  };
  void tick();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}

/**
 * Which wallets are due for a read, each at its plan's pace. `pick` answers for one wallet and remembers that
 * it was tried; `tried` hands back the ones picked since it was last asked.
 */
export function pacer(tierOf: (wallet: string) => "watch" | "pro", seconds: { watch: number; pro: number }) {
  const last = new Map<string, number>();
  let picked: string[] = [];
  return {
    pick(wallet: string, now: number): boolean {
      // a second of slack: a round that starts a moment early still counts
      if (now - (last.get(wallet) ?? -Infinity) < seconds[tierOf(wallet)] - 1) return false;
      last.set(wallet, now);
      picked.push(wallet);
      return true;
    },
    tried(): string[] { const t = picked; picked = []; return t; },
    forget(keep: (wallet: string) => boolean): void { for (const w of last.keys()) if (!keep(w)) last.delete(w); },
  };
}

/**
 * One round of watching: read the wallets that are due, keep count of the ones that could not be read, and
 * tell an owner when theirs has gone unread for long enough to matter, and again when it is read.
 */
export function watchRound(o: {
  watcher: Pick<Watcher, "passAll">; store: MemoryStore; notifier: Notifier; pace: ReturnType<typeof pacer>; blindness: Blindness;
  state: { lastPassAt: number | null; blind: number }; log?: (line: string) => void;
  /** Whoever runs the service hears when wallets go unread for long, and when they are read again. */
  ops?: Pick<Ops, "say">;
}): (now?: number) => Promise<void> {
  const blindNow = new Set<string>();
  const log = o.log ?? console.error;
  return async (now = Math.floor(Date.now() / 1000)) => {
    const { blind } = await o.watcher.passAll((w) => o.pace.pick(w, now));
    const failed = new Set(blind.map((b) => b.wallet));
    let stopped = 0, resumed = 0;
    for (const w of o.pace.tried()) {
      const read = !failed.has(w);
      if (read) blindNow.delete(w); else blindNow.add(w);
      const news = o.blindness.note(w, read, now);
      if (!news) continue;
      if (news === "stopped") stopped += 1; else resumed += 1;
      const sentence = news === "stopped" ? stoppedSentence(o.blindness.afterSeconds) : RESUMED_SENTENCE;
      const event: StoredEvent = { wallet: w, signature: "", slot: 0, at: now, level: "alert", signals: [news === "stopped" ? "watch_stopped" : "watch_resumed"], sentence, rescueWorthy: false };
      o.store.addEvent(event);
      const sent = await o.notifier.notify(w, "alert", sentence).catch(() => ({ delivered: 0, failed: 1 }));
      if (sent && sent.delivered === 0 && event.id) o.store.markUndelivered(event.id);
    }
    const watched = new Set(o.store.wallets().map((w) => w.address));
    for (const w of blindNow) if (!watched.has(w)) blindNow.delete(w);
    o.pace.forget((w) => watched.has(w));
    o.blindness.forget((w) => watched.has(w));
    o.state.lastPassAt = now;
    o.state.blind = blindNow.size;
    // which wallet, and why, goes to the log and nowhere else
    for (const b of blind) log(`sentinel: could not read ${b.wallet.slice(0, 4)}..${b.wallet.slice(-4)}: ${b.why}`);
    const minutes = Math.round(o.blindness.afterSeconds / 60);
    if (stopped) void o.ops?.say(`${stopped} of ${watched.size} wallets ${stopped === 1 ? "has" : "have"} gone unread for ${minutes} minutes (${String(blind[0]?.why ?? "no reason given").slice(0, 120)}). Their owners were told.`, "unread", 3600);
    if (resumed && blindNow.size === 0) void o.ops?.say("Every wallet is being read again.", "read-again", 3600);
  };
}

/** How full the service is, in words, once it is nearly full; null before that. */
export const nearlyFull = (taken: number, open: number, inAll: number = open): string | null =>
  taken >= Math.ceil(open * 0.9)
    ? `Sentinel holds ${taken} of the ${open} wallets it takes from anyone${inAll > open ? ` (${inAll - open} more places are kept for the paid plan)` : ""}. New owners are turned away when it is full.`
    : null;

export async function run(env: Record<string, string | undefined>): Promise<() => Promise<void>> {
  const read = configFrom(env);
  if (!read.ok) throw new Error(read.why);
  const cfg = read.config;
  const store = new FileStore(join(cfg.dataDir, "sentinel.json"));
  const accounts = new Accounts(store, cfg.dataKey, { ntfyHosts: cfg.ntfyHosts, maxWallets: cfg.maxWallets, reservedForPro: cfg.reservedForPro });
  const notifier = new ChannelNotifier(accounts);
  const ops = new Ops(cfg.opsChannel, store.said, { saved: () => store.flush() });
  const watcher = new Watcher(new HttpRpc(cfg.rpcUrl), store, notifier);
  const state = { lastPassAt: null as number | null, blind: 0 };

  if (store.restoredFrom) void ops.say(`The data file was ${store.setAside ? "unreadable" : "missing"}, so Sentinel started from the snapshot ${store.restoredFrom.split("/").pop()}. What changed after that snapshot is lost${store.setAside ? "; the unreadable file was set aside, not deleted" : ""}.`, "restored", 0);

  // each wallet at its plan's pace: the paid plan's more often
  const pace = pacer((w) => accounts.profile(accounts.profileOf(w) ?? "")?.tier ?? "watch", { watch: cfg.pollSeconds, pro: cfg.proPollSeconds });
  const stopRounds = startRounds(watchRound({ watcher, store, notifier, pace, blindness: new Blindness(), state, ops }), Math.min(cfg.pollSeconds, cfg.proPollSeconds));

  // once an hour: today's snapshot if there is none yet, and a word when the house is nearly full
  const stopHourly = startRounds(async () => {
    const now = Math.floor(Date.now() / 1000);
    try { store.snapshot(now); } catch (e) { void ops.say(`Today's snapshot of the data file could not be written (${String((e as Error).message ?? e).slice(0, 120)}).`, "snapshot-failed"); }
    const places = accounts.places();
    const full = nearlyFull(places.taken, places.open ?? cfg.maxWallets, places.inAll ?? cfg.maxWallets);
    if (full) void ops.say(full, "nearly-full", 86_400);
  }, 3600);

  const billing = cfg.billing ? new Billing(cfg.billing, accounts, new HttpRpc(cfg.billing.holderRpcUrl), new Stripe(cfg.billing.secretKey), { notice: (profile, sentence) => notifier.notice(profile, sentence) }) : null;
  // Once a day. First, Stripe's side: every profile is made to match what Stripe says, in case a webhook was
  // missed, and a subscription nobody here has is reported. Then whoever stopped holding the token moves to
  // the full price from their next bill, and the other way round.
  const stopDaily = billing ? startRounds(async () => {
    const { healed, failed: unread, orphans } = await billing.reconcile();
    if (healed) console.error(`sentinel: ${healed} profile(s) brought in line with Stripe`);
    if (unread) void ops.say("Stripe could not be read for the daily check of subscriptions. It is tried again tomorrow.", "stripe-unread", 86_400);
    for (const o of orphans) void ops.say(`A subscription to Sentinel is being paid and belongs to no profile here: ${o.subscription}. Its owner is paying for nothing: look it up in Stripe, and cancel and refund it or restore the profile.`, `orphan:${o.subscription}`, 86_400);
    const { moved, failed } = await billing.reprice();
    if (moved || failed) console.error(`sentinel: holder prices checked, ${moved} moved, ${failed} could not be checked`);
  }, 86_400) : () => undefined;

  const server = await listen({
    accounts, store, watcher, nonces: new NonceBook(), origin: cfg.origin, health: () => state,
    testChannel: (profile, id) => notifier.test(profile, id),
    notice: (profile, sentence, opts) => notifier.notice(profile, sentence, opts),
    webhookFailed: (why) => { void ops.say(`A webhook from Stripe could not be applied (${why.slice(0, 120)}). Stripe sends it again; if this repeats, a plan may not be starting or ending when it should.`, "webhook-failed", 3600); },
    ...(billing ? { billing: { api: billing, webhookSecret: cfg.billing!.webhookSecret } } : {}),
  }, { port: cfg.port, trustProxy: cfg.trustProxy });
  const started = `watching ${store.wallets().length} wallet(s), API on 127.0.0.1:${cfg.port}, page ${cfg.origin}, paid plan ${cfg.billing ? (cfg.billing.checkoutOpen ? "on sale" : "set up, checkout closed") : "not set up"}`;
  // said at most every ten minutes, so a service that keeps falling over does not fill the channel
  void ops.say(`Sentinel started: ${started}.`, "started", 600);
  return async () => { stopRounds(); stopHourly(); stopDaily(); await new Promise<void>((r) => server.close(() => r())); };
}
