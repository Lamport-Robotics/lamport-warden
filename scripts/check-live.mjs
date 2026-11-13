// Asks the deployed Sentinel service, from outside, whether it is watching. The service tells its owners and
// its operator when it cannot read a wallet; what it cannot do is say that it has stopped altogether. This is
// run on a schedule from somewhere that is not the server (.github/workflows/sentinel-watch.yml), and a
// failure there is the notice.
//
//   node scripts/check-live.mjs [health address] [--once]
//
// Exit 0: watching. Exit 1: it does not answer, or its watcher has stopped (starting it again may help).
// Exit 3: it answers and cannot read any wallet (the RPC's trouble: starting it again will not help).
// Either way, one sentence says why. --once asks a single time instead of three.
const DEFAULT = 'https://warden.lamportrobotics.com/sentinel/api/v1/health';

/** A round runs at least once a minute. Ten minutes without one is not a slow round. */
export const STALE_AFTER_SECONDS = 600;

/**
 * Reads what /v1/health answered. Returns null when the service is watching, or one sentence saying why it
 * is not. `now` is unix seconds.
 */
export function wrongWith(health, now) {
  if (!health || typeof health !== 'object' || health.ok !== true) return 'the service answered, and did not say it was all right.';
  if (typeof health.lastPassAt !== 'number') return 'the service is up and has not finished a single round of reading wallets.';
  const age = now - health.lastPassAt;
  if (age > STALE_AFTER_SECONDS) return `the last round of reading wallets ended ${Math.round(age / 60)} minutes ago: the watcher has stopped while the service still answers.`;
  const watching = Number(health.watching) || 0, blind = Number(health.blind) || 0;
  // one wallet that cannot be read is its owner's news, and they are told. All of them is the service's.
  if (watching > 0 && blind >= watching) return `none of the ${watching} watched wallets can be read: the RPC is refusing or down.`;
  return null;
}

/** Asks a few times before giving up: one dropped connection is not an outage. */
export async function ask(url, { tries = 3, waitMs = 20_000, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last = 'no answer';
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } });
      if (res.ok) return { ok: true, health: await res.json() };
      last = `it answered ${res.status}`;
    } catch (e) {
      last = String(e?.cause?.code ?? e?.name ?? e);
    }
    if (i < tries - 1) await sleep(waitMs);
  }
  return { ok: false, why: `the service did not answer in ${tries} tries (${last}).` };
}

/** True when what is wrong is that no wallet can be read, by a service that is otherwise doing its rounds. */
export function isBlind(health, now) {
  return !!health && health.ok === true && typeof health.lastPassAt === 'number' && now - health.lastPassAt <= STALE_AFTER_SECONDS && (Number(health.watching) || 0) > 0 && (Number(health.blind) || 0) >= (Number(health.watching) || 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith('--')) || DEFAULT;
  const answer = await ask(url, args.includes('--once') ? { tries: 1 } : {});
  const now = Math.floor(Date.now() / 1000);
  const why = answer.ok ? wrongWith(answer.health, now) : answer.why;
  if (why) { console.error(`Sentinel is not watching: ${why}`); process.exit(answer.ok && isBlind(answer.health, now) ? 3 : 1); }
  console.log(`Sentinel is watching: ${answer.health.watching} wallet(s), last round ${Math.floor(Date.now() / 1000) - answer.health.lastPassAt} s ago, ${answer.health.blind} unread, ${answer.health.late ?? 0} read later than promised, push ${answer.health.push ?? "off"}.`);
}
