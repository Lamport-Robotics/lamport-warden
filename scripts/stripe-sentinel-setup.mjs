// Sets up what the Sentinel paid plan needs in a Stripe account: one product, two monthly prices, the
// customer portal, and (when asked) the webhook. Safe to run again: it finds what is there before it makes
// anything, and it never changes a price that exists.
//
//   STRIPE_SECRET_KEY=sk_... node scripts/stripe-sentinel-setup.mjs
//   STRIPE_SECRET_KEY=sk_... node scripts/stripe-sentinel-setup.mjs --webhook https://warden.lamportrobotics.com/sentinel/api/v1/stripe/webhook --secret-out /etc/lamport-sentinel.webhook
//
// It prints the settings the service reads (ids, not secrets). The webhook's signing secret is shown by Stripe
// once, when the webhook is made, so it is written to the file named by --secret-out (mode 0600) and never
// printed.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PRODUCT_ID = 'warden_sentinel';
export const KEY_FULL = 'sentinel_monthly';
export const KEY_HOLDER = 'sentinel_monthly_holder';
export const EVENTS = ['checkout.session.completed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'];

/** A Stripe call with form-encoded parameters. `pairs` is a list so that a name may repeat. */
export function stripeCaller(secretKey, fetchImpl = fetch) {
  return async (method, path, pairs = []) => {
    const body = new URLSearchParams(pairs).toString();
    const res = await fetchImpl(`https://api.stripe.com/v1${path}${method === 'GET' && body ? `?${body}` : ''}`, {
      method,
      headers: { authorization: `Bearer ${secretKey}`, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(method === 'POST' ? { body } : {}),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(`stripe ${method} ${path}: ${res.status} ${json?.error?.code ?? json?.error?.type ?? ''} ${json?.error?.message ?? ''}`.trim()); e.status = res.status; throw e; }
    return json;
  };
}

/**
 * @param call from stripeCaller
 * @param opts {centsFull, centsHolder, webhookUrl?}
 * @returns {{priceFull, priceHolder, portalConfiguration, webhook: null | {id, secret: string | null}}}
 */
export async function setup(call, opts = {}) {
  const centsFull = opts.centsFull ?? 1500, centsHolder = opts.centsHolder ?? 1000;

  let product;
  try { product = await call('GET', `/products/${PRODUCT_ID}`); } catch (e) { if (e.status !== 404) throw e; }
  if (!product) product = await call('POST', '/products', [['id', PRODUCT_ID], ['name', 'Warden Sentinel'], ['description', 'Watches your Solana wallets after you sign and tells you when something looks wrong.']]);

  const found = await call('GET', '/prices', [['lookup_keys[]', KEY_FULL], ['lookup_keys[]', KEY_HOLDER], ['active', 'true'], ['limit', '10']]);
  const byKey = Object.fromEntries((found.data ?? []).map((p) => [p.lookup_key, p]));
  const ensure = async (key, cents, nickname) => {
    const have = byKey[key];
    if (have) {
      // a price is what subscribers were promised: a different amount under the same key is an error, not something to fix quietly
      if (have.unit_amount !== cents || have.recurring?.interval !== 'month' || have.currency !== 'usd') throw new Error(`the price ${key} exists with a different amount (${have.unit_amount} ${have.currency}/${have.recurring?.interval}); decide what to do with it by hand`);
      return have.id;
    }
    return (await call('POST', '/prices', [['product', product.id], ['currency', 'usd'], ['unit_amount', String(cents)], ['recurring[interval]', 'month'], ['lookup_key', key], ['nickname', nickname]])).id;
  };
  const priceFull = await ensure(KEY_FULL, centsFull, 'Sentinel, monthly');
  const priceHolder = await ensure(KEY_HOLDER, centsHolder, 'Sentinel, monthly, $LAMPORT holder');

  // the portal: where a subscriber changes the card or cancels, on Stripe's own page
  const portals = await call('GET', '/billing_portal/configurations', [['limit', '100']]);
  let portal = (portals.data ?? []).find((c) => c.metadata?.app === 'sentinel' && c.active);
  if (!portal) {
    portal = await call('POST', '/billing_portal/configurations', [
      ['business_profile[headline]', 'Warden Sentinel'], ['metadata[app]', 'sentinel'],
      ['features[payment_method_update][enabled]', 'true'], ['features[invoice_history][enabled]', 'true'],
      ['features[subscription_cancel][enabled]', 'true'], ['features[subscription_cancel][mode]', 'at_period_end'],
    ]);
  }

  let webhook = null;
  if (opts.webhookUrl) {
    const hooks = await call('GET', '/webhook_endpoints', [['limit', '100']]);
    const have = (hooks.data ?? []).find((h) => h.url === opts.webhookUrl && h.status === 'enabled');
    if (have) webhook = { id: have.id, secret: null }; // Stripe shows the secret only when the webhook is made
    else {
      const made = await call('POST', '/webhook_endpoints', [['url', opts.webhookUrl], ['description', 'Warden Sentinel subscriptions'], ...EVENTS.map((e) => ['enabled_events[]', e])]);
      webhook = { id: made.id, secret: made.secret ?? null };
    }
  }
  return { priceFull, priceHolder, portalConfiguration: portal.id, webhook };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const webhookUrl = arg('--webhook'), secretOut = arg('--secret-out');
  if (!/^(sk|rk)_(test|live)_/.test(key)) { console.error('Set STRIPE_SECRET_KEY to a Stripe secret key.'); process.exit(1); }
  if (webhookUrl && !secretOut) { console.error('With --webhook, name a file for the signing secret with --secret-out: Stripe shows it once.'); process.exit(1); }
  console.error(`Stripe ${key.includes('_live_') ? 'LIVE' : 'test'} mode.`);
  try {
    const r = await setup(stripeCaller(key), { webhookUrl });
    console.log(`SENTINEL_STRIPE_PRICE_FULL=${r.priceFull}`);
    console.log(`SENTINEL_STRIPE_PRICE_HOLDER=${r.priceHolder}`);
    console.log(`SENTINEL_STRIPE_PORTAL_CONFIG=${r.portalConfiguration}`);
    if (r.webhook?.secret) { writeFileSync(secretOut, r.webhook.secret, { mode: 0o600 }); console.error(`Webhook ${r.webhook.id} made. Its signing secret is in ${secretOut}: put it in SENTINEL_STRIPE_WEBHOOK_SECRET.`); }
    else if (r.webhook) console.error(`Webhook ${r.webhook.id} was already there. Its secret is in the Stripe dashboard, under that webhook.`);
  } catch (e) { console.error(String(e.message ?? e)); process.exit(1); }
}
