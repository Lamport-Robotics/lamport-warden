/**
 * The process: the watcher on a timer, and the API beside it. It holds no signing key. Everything it needs
 * comes from the environment, and it refuses to start without the parts that keep owners' data closed.
 *
 *   SENTINEL_RPC_URL      the Solana RPC to read from (required)
 *   SENTINEL_DATA_KEY     32 random bytes in base64, sealing where alerts go (required; `openssl rand -base64 32`)
 *   SENTINEL_DATA_DIR     where the one data file lives (default ./sentinel-data)
 *   SENTINEL_ORIGIN       the Sentinel page's origin (default https://warden.lamportrobotics.com)
 *   SENTINEL_PORT         the API's port on 127.0.0.1 (default 8791); a web server in front adds TLS
 *   SENTINEL_POLL_SECONDS how often every wallet is read (default 30)
 *   SENTINEL_NTFY_HOSTS   ntfy hosts alerts may go to, comma-separated (default ntfy.sh)
 *   SENTINEL_TRUST_PROXY  "1" when a proxy this process trusts sets X-Forwarded-For
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
import { Accounts } from "./accounts.js";
import { Billing, Stripe, type BillingConfig } from "./billing.js";
import { dataKeyFrom } from "./crypto.js";
import { ChannelNotifier } from "./notify.js";
import { HttpRpc } from "./rpc.js";
import { listen } from "./server.js";
import { NonceBook } from "./signin.js";
import { FileStore } from "./store.js";
import { Watcher } from "./watcher.js";

export interface Config { rpcUrl: string; dataKey: Buffer; dataDir: string; origin: string; port: number; pollSeconds: number; ntfyHosts: Set<string>; trustProxy: boolean; billing: (BillingConfig & { holderRpcUrl: string }) | null }

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
  const pollSeconds = Number(env.SENTINEL_POLL_SECONDS ?? 30);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, why: "SENTINEL_PORT has to be a port number." };
  if (!Number.isFinite(pollSeconds) || pollSeconds < 5) return { ok: false, why: "SENTINEL_POLL_SECONDS has to be 5 or more." };
  const ntfyHosts = new Set((env.SENTINEL_NTFY_HOSTS ?? "ntfy.sh").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
  const billing = billingFrom(env, origin, rpcUrl);
  if (!billing.ok) return billing;
  return { ok: true, config: { rpcUrl, dataKey, dataDir: env.SENTINEL_DATA_DIR ?? "./sentinel-data", origin, port, pollSeconds, ntfyHosts, trustProxy: env.SENTINEL_TRUST_PROXY === "1", billing: billing.billing } };
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

export async function run(env: Record<string, string | undefined>): Promise<() => Promise<void>> {
  const read = configFrom(env);
  if (!read.ok) throw new Error(read.why);
  const cfg = read.config;
  const store = new FileStore(join(cfg.dataDir, "sentinel.json"));
  const accounts = new Accounts(store, cfg.dataKey, { ntfyHosts: cfg.ntfyHosts });
  const notifier = new ChannelNotifier(accounts);
  const watcher = new Watcher(new HttpRpc(cfg.rpcUrl), store, notifier);
  const state = { lastPassAt: null as number | null, blind: 0 };

  const stopRounds = startRounds(async () => {
    const { blind } = await watcher.passAll();
    state.lastPassAt = Math.floor(Date.now() / 1000);
    state.blind = blind.length;
    // which wallet, and why, goes to the log and nowhere else
    for (const b of blind) console.error(`sentinel: could not read ${b.wallet.slice(0, 4)}..${b.wallet.slice(-4)}: ${b.why}`);
  }, cfg.pollSeconds);

  const billing = cfg.billing ? new Billing(cfg.billing, accounts, new HttpRpc(cfg.billing.holderRpcUrl), new Stripe(cfg.billing.secretKey)) : null;
  // once a day: whoever stopped holding the token moves to the full price from their next bill, and the other way round
  const stopReprice = billing ? startRounds(async () => {
    const { moved, failed } = await billing.reprice();
    if (moved || failed) console.error(`sentinel: holder prices checked, ${moved} moved, ${failed} could not be checked`);
  }, 86_400) : () => undefined;

  const server = await listen({ accounts, store, watcher, nonces: new NonceBook(), origin: cfg.origin, health: () => state, ...(billing ? { billing: { api: billing, webhookSecret: cfg.billing!.webhookSecret } } : {}) }, { port: cfg.port, trustProxy: cfg.trustProxy });
  console.error(`sentinel: watching ${store.wallets().length} wallet(s), API on 127.0.0.1:${cfg.port}, page ${cfg.origin}, paid plan ${cfg.billing ? (cfg.billing.checkoutOpen ? "on sale" : "set up, checkout closed") : "not set up"}`);
  return async () => { stopRounds(); stopReprice(); await new Promise<void>((r) => server.close(() => r())); };
}
