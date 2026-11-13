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
 */
import { join } from "node:path";
import { Accounts } from "./accounts.js";
import { dataKeyFrom } from "./crypto.js";
import { ChannelNotifier } from "./notify.js";
import { HttpRpc } from "./rpc.js";
import { listen } from "./server.js";
import { NonceBook } from "./signin.js";
import { FileStore } from "./store.js";
import { Watcher } from "./watcher.js";

export interface Config { rpcUrl: string; dataKey: Buffer; dataDir: string; origin: string; port: number; pollSeconds: number; ntfyHosts: Set<string>; trustProxy: boolean }

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
  return { ok: true, config: { rpcUrl, dataKey, dataDir: env.SENTINEL_DATA_DIR ?? "./sentinel-data", origin, port, pollSeconds, ntfyHosts, trustProxy: env.SENTINEL_TRUST_PROXY === "1" } };
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

  const server = await listen({ accounts, store, watcher, nonces: new NonceBook(), origin: cfg.origin, health: () => state }, { port: cfg.port, trustProxy: cfg.trustProxy });
  console.error(`sentinel: watching ${store.wallets().length} wallet(s), API on 127.0.0.1:${cfg.port}, page ${cfg.origin}`);
  return async () => { stopRounds(); await new Promise<void>((r) => server.close(() => r())); };
}
