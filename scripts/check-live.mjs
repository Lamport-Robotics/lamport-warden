// Asks the deployed Sentinel service, from outside, whether it is watching. The service tells its owners and
// its operator when it cannot read a wallet; what it cannot do is say that it has stopped altogether. This is
// run on a schedule from somewhere that is not the server (.github/workflows/sentinel-watch.yml), and a
// failure there is the notice.
//
//   node scripts/check-live.mjs [health address]      exit 0: watching; exit 1: not, with one sentence why
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.argv[2] || DEFAULT;
  const answer = await ask(url);
  const why = answer.ok ? wrongWith(answer.health, Math.floor(Date.now() / 1000)) : answer.why;
  if (why) { console.error(`Sentinel is not watching: ${why}`); process.exit(1); }
  console.log(`Sentinel is watching: ${answer.health.watching} wallet(s), last round ${Math.floor(Date.now() / 1000) - answer.health.lastPassAt} s ago, ${answer.health.blind} unread, ${answer.health.late ?? 0} read later than promised, push ${answer.health.push ?? "off"}.`);
}
