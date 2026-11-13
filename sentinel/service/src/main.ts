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
 *   SENTINEL_RPC_HEAVY_PER_10S, SENTINEL_RPC_LIGHT_PER_10S  how fast the RPC may be asked (rpc.ts): calls
 *                         started per ten seconds, for the two listings an RPC rations and for the rest.
 *                         Unset: what the public Solana RPC takes when that is the RPC, no limit otherwise.
 *                         "0" lifts one. A paid RPC takes more: set these to what its plan allows.
 *   SENTINEL_READERS      how many wallets are read at the same time (default 3)
 *   SENTINEL_PUSH         "off" to read wallets only in turn. Otherwise the RPC is also asked, over a websocket,
 *                         to say when a watched wallet is in a transaction, and that wallet is read at once (push.ts)
 *   SENTINEL_RPC_WS_URL   the RPC's websocket address, when it is not the RPC's own address with wss:// in front
 *   SENTINEL_READS_PER_MINUTE  how many reads of a wallet a minute are promised in all. A free wallet is one,
 *                         a paid one three. Unset: four fifths of what the pace above allows, the rest being
 *                         for what a read leads to (a new transaction, a first look at a new wallet); no
 *                         limit when the RPC is not paced. A new wallet is turned away when its reads do not fit.
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
import { Accounts, cleanTarget, type ReadBudget } from "./accounts.js";
import { Billing, Stripe, type BillingConfig } from "./billing.js";
import { dataKeyFrom } from "./crypto.js";
import { Blindness, RESUMED_SENTENCE, stoppedSentence } from "./blindness.js";
import { ChannelNotifier } from "./notify.js";
import { Ops } from "./ops.js";
import { PLANS, type ChannelKind } from "./plans.js";
import { Push, pushUrlFor } from "./push.js";
import { HttpRpc, PUBLIC_RPC_PACE, type Pace } from "./rpc.js";
import { listen } from "./server.js";
import { NonceBook } from "./signin.js";
import { FileStore, type MemoryStore, type StoredEvent } from "./store.js";
import { Watcher, type Notifier } from "./watcher.js";

export interface Config { rpcUrl: string; dataKey: Buffer; dataDir: string; origin: string; port: number; pollSeconds: number; proPollSeconds: number; maxWallets: number; reservedForPro: number; rpcPace: Pace; readers: number; pushUrl: string | null; reads: ReadBudget | null; ntfyHosts: Set<string>; trustProxy: boolean; opsChannel: { kind: ChannelKind; url: string } | null; billing: (BillingConfig & { holderRpcUrl: string }) | null }

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
  // how fast the RPC may be asked: what was measured for the public one, unless said otherwise
  const publicRpc = /(^|\.)mainnet-beta\.solana\.com$/.test(new URL(rpcUrl).hostname);
  const rpcPace: Pace = {};
  for (const [name, key] of [["SENTINEL_RPC_HEAVY_PER_10S", "heavyPer10s"], ["SENTINEL_RPC_LIGHT_PER_10S", "lightPer10s"]] as const) {
    const given = env[name];
    if (given === undefined || given === "") { if (publicRpc) rpcPace[key] = PUBLIC_RPC_PACE[key]!; continue; }
    const n = Number(given);
    if (!Number.isFinite(n) || n < 0 || n > 10_000) return { ok: false, why: `${name} has to be a number of calls per ten seconds, or 0 for no limit.` };
    if (n > 0) rpcPace[key] = n;
  }
  // where the RPC says, unasked, that a wallet was in a transaction: its own address as a websocket, unless told otherwise or told not to
  let pushUrl: string | null = null;
  if (env.SENTINEL_PUSH !== "off") {
    pushUrl = env.SENTINEL_RPC_WS_URL ? env.SENTINEL_RPC_WS_URL : pushUrlFor(rpcUrl);
    try { if (!pushUrl || !/^wss?:$/.test(new URL(pushUrl).protocol)) throw new Error(); } catch { return { ok: false, why: "SENTINEL_RPC_WS_URL has to be the RPC's websocket address (wss://…)." }; }
  }
  const readers = Number(env.SENTINEL_READERS ?? 3);
  if (!Number.isInteger(readers) || readers < 1 || readers > 32) return { ok: false, why: "SENTINEL_READERS has to be a whole number from 1 to 32." };
  const opsChannel = env.SENTINEL_OPS_CHANNEL ? cleanTarget(env.SENTINEL_OPS_CHANNEL, ntfyHosts) : null;
  if (env.SENTINEL_OPS_CHANNEL && !opsChannel) return { ok: false, why: "SENTINEL_OPS_CHANNEL has to be an ntfy topic on an allowed host, or a Discord or Slack webhook." };
  const billing = billingFrom(env, origin, rpcUrl);
  if (!billing.ok) return billing;
  // room kept for those who pay: only when there is something to pay for
  const reservedForPro = Number(env.SENTINEL_RESERVED_FOR_PRO ?? (billing.billing ? Math.floor(maxWallets / 5) : 0));
  if (!Number.isInteger(reservedForPro) || reservedForPro < 0 || reservedForPro >= maxWallets) return { ok: false, why: "SENTINEL_RESERVED_FOR_PRO has to be a whole number, zero or more, and less than SENTINEL_MAX_WALLETS." };
  // what can be promised: so many reads a minute, of which a wallet on each plan takes its share
  const readsGiven = env.SENTINEL_READS_PER_MINUTE;
  const perMinute = readsGiven !== undefined && readsGiven !== "" ? Number(readsGiven) : rpcPace.heavyPer10s ? Math.floor(rpcPace.heavyPer10s * 6 * 0.8) : 0;
  if (!Number.isFinite(perMinute) || perMinute < 0) return { ok: false, why: "SENTINEL_READS_PER_MINUTE has to be a number of reads a minute, or 0 for no limit." };
  const reads: ReadBudget | null = perMinute > 0
    ? { perMinute, cost: { watch: 60 / pollSeconds, pro: 60 / proPollSeconds }, reservedForPro: billing.billing ? Math.floor(perMinute * (reservedForPro / maxWallets)) : 0 }
    : null;
  return { ok: true, config: { rpcUrl, dataKey, dataDir: env.SENTINEL_DATA_DIR ?? "./sentinel-data", origin, port, pollSeconds, proPollSeconds, maxWallets, reservedForPro, rpcPace, readers, pushUrl, reads, ntfyHosts, trustProxy: env.SENTINEL_TRUST_PROXY === "1", opsChannel, billing: billing.billing } };
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
 *
 * A wallet's pace is a promise made to its owner ("read every minute", "every twenty seconds"). When more
 * wallets are due than can be read at once, `due` puts first the one furthest behind its own promise, so a
 * paid wallet promised twenty seconds is not kept waiting behind sixty free ones; and `late` says how many
 * are being read slower than promised, which is something whoever runs the service has to hear.
 */
export function pacer(tierOf: (wallet: string) => "watch" | "pro", seconds: { watch: number; pro: number }) {
  const last = new Map<string, number>();
  /** When a wallet was first asked about: what a wallet that was never read is measured from. */
  const known = new Map<string, number>();
  /** Wallets the RPC has just said something about, and when each was last read on its word. */
  const urgent = new Set<string>();
  const hurried = new Map<string, number>();
  let picked: string[] = [];
  const promiseOf = (wallet: string) => seconds[tierOf(wallet)];
  const since = (wallet: string, now: number) => { if (!known.has(wallet)) known.set(wallet, now); return last.get(wallet) ?? known.get(wallet)!; };
  const isDue = (wallet: string, now: number) => urgent.has(wallet) || !last.has(wallet) || now - last.get(wallet)! >= promiseOf(wallet) - 1; // a second of slack: a round that starts a moment early still counts
  return {
    pick(wallet: string, now: number): boolean {
      since(wallet, now);
      if (!isDue(wallet, now)) return false;
      if (urgent.delete(wallet)) hurried.set(wallet, now);
      last.set(wallet, now);
      picked.push(wallet);
      return true;
    },
    /**
     * The RPC says this wallet has just been in a transaction: it is read next, ahead of its turn. Not more
     * often than every `gap` seconds on such a word, so a wallet that never stops transacting costs a few
     * times its promised reads and no more. False when it was too soon, and the word is dropped: the wallet's
     * own turn is never far off.
     */
    hurry(wallet: string, now: number, gap = Math.max(5, Math.floor(promiseOf(wallet) / 4))): boolean {
      if (now - (hurried.get(wallet) ?? -Infinity) < gap) return false;
      urgent.add(wallet);
      return true;
    },
    /**
     * The wallets due now, the one furthest behind its promise first, at most `most`. A wallet never read is
     * due at once and is behind by how long it has waited since it was first met: many arriving together
     * take their turn among the wallets already here, and do not push them all back.
     */
    due(wallets: string[], now: number, most = Infinity): string[] {
      return wallets
        .filter((w) => { since(w, now); return isDue(w, now); })
        .map((w) => ({ w, behind: urgent.has(w) ? Infinity : (now - since(w, now)) / promiseOf(w), fresh: !last.has(w) }))
        .sort((a, b) => (b.behind === a.behind ? Number(b.fresh) - Number(a.fresh) : b.behind - a.behind))
        .slice(0, most)
        .map((x) => x.w);
    },
    /**
     * How many of these wallets have gone twice their promised time without a read being started, and the
     * worst of them. One slow round is not that; a service that cannot keep up is.
     */
    late(wallets: string[], now: number): { count: number; worst: { seconds: number; promised: number } | null } {
      let count = 0, worst: { seconds: number; promised: number } | null = null;
      for (const w of wallets) {
        const waited = now - since(w, now), promised = promiseOf(w);
        if (waited <= 2 * promised) continue;
        count += 1;
        if (!worst || waited / promised > worst.seconds / worst.promised) worst = { seconds: waited, promised };
      }
      return { count, worst };
    },
    tried(): string[] { const t = picked; picked = []; return t; },
    forget(keep: (wallet: string) => boolean): void { for (const m of [last, known, hurried]) for (const w of m.keys()) if (!keep(w)) m.delete(w); for (const w of urgent) if (!keep(w)) urgent.delete(w); },
  };
}

/** The breath between one round of reading and the next. */
export const ROUND_GAP_SECONDS = 2;

/** How long wallets may be read late before whoever runs the service is told. */
export const LATE_FOR_SECONDS = 15 * 60;

/**
 * One round of watching: read the wallets that are due, keep count of the ones that could not be read, and
 * tell an owner when theirs has gone unread for long enough to matter, and again when it is read.
 */
export function watchRound(o: {
  watcher: Pick<Watcher, "passAll">; store: MemoryStore; notifier: Notifier; pace: ReturnType<typeof pacer>; blindness: Blindness;
  state: { lastPassAt: number | null; blind: number; late?: number }; log?: (line: string) => void;
  /** Whoever runs the service hears when wallets go unread for long, and when they are read again. */
  ops?: Pick<Ops, "say">;
  /** How many wallets one round reads at most: a round is kept short so that the next can take whoever became due meanwhile. */
  batch?: number;
}): (now?: number) => Promise<void> {
  const blindNow = new Set<string>();
  const log = o.log ?? console.error;
  let lateSince: number | null = null;
  return async (now = Math.floor(Date.now() / 1000)) => {
    // the wallets furthest behind their own promise, and no more of them than one short round can read
    const chosen = new Set(o.pace.due(o.store.wallets().map((w) => w.address), now, o.batch ?? Infinity));
    const { blind } = await o.watcher.passAll((w) => chosen.has(w) && o.pace.pick(w, now));
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
    // Read, but later than promised: nobody is blind, and the plans are not being kept. That is a matter of
    // how much the RPC will take, which only whoever runs the service can change.
    const late = o.pace.late([...watched], now);
    o.state.late = late.count;
    lateSince = late.count > 0 ? lateSince ?? now : null;
    if (lateSince !== null && now - lateSince >= LATE_FOR_SECONDS && late.worst) {
      void o.ops?.say(`${late.count} of ${watched.size} wallets ${late.count === 1 ? "is" : "are"} being read later than their plan promises, and ${late.count === 1 ? "has" : "have"} been for ${Math.round((now - lateSince) / 60)} minutes: the slowest waited ${late.worst.seconds} seconds against ${late.worst.promised}. The RPC is not taking reads as fast as these wallets need them.`, "late", 3600);
    }
  };
}

/** The same, counted in what the RPC will take: null until nine tenths of the reads on offer are promised. */
export const nearlyOutOfReads = (promised: number, open: number, inAll: number = open): string | null =>
  promised >= open * 0.9
    ? `The wallets Sentinel watches are promised ${Math.round(promised)} of the ${open} reads a minute it gives to anyone${inAll > open ? ` (${inAll - open} more are kept for the paid plan)` : ""}. New owners are turned away when they are all promised; a faster RPC is what makes room.`
    : null;

/**
 * A round, with the push line looked after before it: told which wallets to listen for, asked now and then
 * whether it is still there, and whoever runs the service told when it has been down for a quarter of an
 * hour. A line that is down slows alerts to the pace of the plans; it stops nothing.
 */
export function pushedRounds(round: (now?: number) => Promise<void>, push: Pick<Push, "watch" | "check" | "state"> | null, wallets: () => string[], ops?: Pick<Ops, "say">, clock: () => number = () => Math.floor(Date.now() / 1000)): () => Promise<void> {
  let lastCheck = 0, downSince: number | null = null;
  return async () => {
    const now = clock();
    if (push) {
      push.watch(wallets());
      if (now - lastCheck >= 30) { lastCheck = now; push.check(); }
      downSince = push.state.connected ? null : downSince ?? now;
      if (downSince !== null && now - downSince >= LATE_FOR_SECONDS) void ops?.say("The RPC has not been telling Sentinel about transactions as they happen for a quarter of an hour (the push line is down). Wallets are still read in turn, at the pace of their plans, so alerts come later than they could.", "push-down", 6 * 3600);
    }
    await round(now);
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
  const accounts = new Accounts(store, cfg.dataKey, { ntfyHosts: cfg.ntfyHosts, maxWallets: cfg.maxWallets, reservedForPro: cfg.reservedForPro, ...(cfg.reads ? { reads: cfg.reads } : {}) });
  const notifier = new ChannelNotifier(accounts);
  const ops = new Ops(cfg.opsChannel, store.said, { saved: () => store.flush() });
  // one client for one RPC, so that everything asked of it is counted against the same pace
  const rpc = new HttpRpc(cfg.rpcUrl, undefined, { pace: cfg.rpcPace });
  const watcher = new Watcher(rpc, store, notifier, { readers: cfg.readers });
  const state = { lastPassAt: null as number | null, blind: 0, late: 0 };

  if (store.restoredFrom) void ops.say(`The data file was ${store.setAside ? "unreadable" : "missing"}, so Sentinel started from the snapshot ${store.restoredFrom.split("/").pop()}. What changed after that snapshot is lost${store.setAside ? "; the unreadable file was set aside, not deleted" : ""}.`, "restored", 0);

  // each wallet at its plan's pace: the paid plan's more often
  const pace = pacer((w) => accounts.profile(accounts.profileOf(w) ?? "")?.tier ?? "watch", { watch: cfg.pollSeconds, pro: cfg.proPollSeconds });
  // Short rounds, one after another with a breath between: each takes the few wallets furthest behind their
  // promise, so whoever becomes due while a round is under way waits for a handful of reads and not for all.
  const batch = Math.max(2, Math.ceil((cfg.rpcPace.heavyPer10s ?? 40) / 3));
  const round = watchRound({ watcher, store, notifier, pace, blindness: new Blindness(), state, ops, batch });
  // And the RPC is asked to say when a watched wallet is in a transaction: that wallet is then read next,
  // ahead of its turn. Only a reason to read sooner; the reading in turn above goes on whatever this does.
  const push = cfg.pushUrl ? new Push({ url: cfg.pushUrl, onMention: (wallet) => { pace.hurry(wallet, Math.floor(Date.now() / 1000)); } }) : null;
  push?.start();
  const stopRounds = startRounds(pushedRounds(round, push, () => store.wallets().map((w) => w.address), ops), ROUND_GAP_SECONDS);

  // once an hour: today's snapshot if there is none yet, and a word when the house is nearly full
  const stopHourly = startRounds(async () => {
    const now = Math.floor(Date.now() / 1000);
    try { store.snapshot(now); } catch (e) { void ops.say(`Today's snapshot of the data file could not be written (${String((e as Error).message ?? e).slice(0, 120)}).`, "snapshot-failed"); }
    const places = accounts.places();
    const full = nearlyFull(places.taken, places.open ?? cfg.maxWallets, places.inAll ?? cfg.maxWallets);
    if (full) void ops.say(full, "nearly-full", 86_400);
    const short = places.reads ? nearlyOutOfReads(places.reads.promised, places.reads.open, places.reads.inAll) : null;
    if (short) void ops.say(short, "nearly-out-of-reads", 86_400);
  }, 3600);

  const billing = cfg.billing ? new Billing(cfg.billing, accounts, cfg.billing.holderRpcUrl === cfg.rpcUrl ? rpc : new HttpRpc(cfg.billing.holderRpcUrl), new Stripe(cfg.billing.secretKey), { notice: (profile, sentence) => notifier.notice(profile, sentence) }) : null;
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
    accounts, store, watcher, nonces: new NonceBook(), origin: cfg.origin, health: () => ({ ...state, push: push ? (push.state.connected ? "on" as const : "down" as const) : "off" as const }),
    testChannel: (profile, id) => notifier.test(profile, id),
    notice: (profile, sentence, opts) => notifier.notice(profile, sentence, opts),
    webhookFailed: (why) => { void ops.say(`A webhook from Stripe could not be applied (${why.slice(0, 120)}). Stripe sends it again; if this repeats, a plan may not be starting or ending when it should.`, "webhook-failed", 3600); },
    ...(billing ? { billing: { api: billing, webhookSecret: cfg.billing!.webhookSecret } } : {}),
  }, { port: cfg.port, trustProxy: cfg.trustProxy });
  const started = `watching ${store.wallets().length} wallet(s), API on 127.0.0.1:${cfg.port}, page ${cfg.origin}, paid plan ${cfg.billing ? (cfg.billing.checkoutOpen ? "on sale" : "set up, checkout closed") : "not set up"}`;
  // said at most every ten minutes, so a service that keeps falling over does not fill the channel
  void ops.say(`Sentinel started: ${started}.`, "started", 600);
  return async () => { stopRounds(); push?.stop(); stopHourly(); stopDaily(); await new Promise<void>((r) => server.close(() => r())); };
}
