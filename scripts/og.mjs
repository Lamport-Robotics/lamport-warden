// Draws site/og.png, the picture a link to warden.lamportrobotics.com shows where it is posted (1200 x 630),
// and store/promo-440x280.png, the small tile the Chrome Web Store shows beside the listing.
// It is the page's own first screen: the headline, and the prompt as the extension draws it. The fonts and the
// mark are the main site's, fetched from where the page itself gets them, so this needs the network.
//
//   node scripts/og.mjs
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = 'https://warden.lamportrobotics.com/site';
// fetched here and put into the page as data: a page with no address of its own may not load another site's fonts
const inline = async (path, type) => {
  const r = await fetch(`${site}/${path}`);
  if (!r.ok) throw new Error(`${site}/${path} answered ${r.status}: og.png was not written`);
  return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
};
const font = Object.fromEntries(await Promise.all([300, 400, 500].map(async (w) => [w, await inline(`fonts/switzer-${w}.woff2`, 'font/woff2')])));
const mark = await inline('mark.svg', 'image/svg+xml');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: Switzer; src: url(${font[300]}) format("woff2"); font-weight: 300; }
  @font-face { font-family: Switzer; src: url(${font[400]}) format("woff2"); font-weight: 400; }
  @font-face { font-family: Switzer; src: url(${font[500]}) format("woff2"); font-weight: 500; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { width: 1200px; height: 630px; background: #0b0b0a; color: #f2eee3; font: 400 22px/1.45 Switzer, system-ui, sans-serif; letter-spacing: -.01em; display: grid; grid-template-columns: 1.05fr 1fr; gap: 56px; align-items: center; padding: 64px 64px 64px 72px; -webkit-font-smoothing: antialiased; }
  .brand { display: flex; align-items: center; gap: 12px; font-weight: 500; font-size: 22px; letter-spacing: -.02em; color: rgba(242, 238, 227, .72); margin-bottom: 36px; }
  .brand img { width: 18px; height: 24px; }
  h1 { font-weight: 300; font-size: 76px; line-height: .98; letter-spacing: -.055em; }
  p.sub { color: rgba(242, 238, 227, .62); margin-top: 28px; font-size: 24px; max-width: 18em; }
  .stage { border: 1px solid rgba(242, 238, 227, .14); background: rgba(242, 238, 227, .04); border-radius: 26px; padding: 34px 28px; }
  .card { background: #f2eee3; color: #14130f; border-radius: 16px; padding: 24px 24px 20px; font: 19px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; letter-spacing: 0; box-shadow: 0 18px 60px rgba(0, 0, 0, .5); }
  .tag { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; margin-bottom: 12px; color: #a1260d; }
  .sentence { font-size: 20px; margin-bottom: 12px; }
  .from { font-size: 14px; color: #5c5a50; margin-bottom: 16px; }
  .row { display: flex; justify-content: flex-end; }
  .close { font-weight: 600; font-size: 16px; border-radius: 999px; padding: 9px 20px; border: 1px solid #14130f; }
</style></head><body>
  <div>
    <div class="brand"><img src="${mark}" alt=""><span>Lamport Warden</span></div>
    <h1>It reads the request before you sign it.</h1>
    <p class="sub">A browser extension in front of the Solana wallet you already use.</p>
  </div>
  <div class="stage"><div class="card">
    <div class="tag">Lamport Warden · Blocked</div>
    <p class="sentence">The destination 7xKX…q9Ab looks like an address you have paid 6 times, but it is a different address. This is address poisoning.</p>
    <p class="from">Asked by https://claim-rewards.example</p>
    <div class="row"><span class="close">Close</span></div>
  </div></div>
</body></html>`;

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
const fonts = await page.evaluate(async () => { await Promise.all([300, 400, 500].map((w) => document.fonts.load(`${w} 20px Switzer`))); await document.fonts.ready; return [...document.fonts].filter((f) => f.status === 'loaded').length; });
if (fonts < 2) { await browser.close(); throw new Error(`the site's fonts did not load (${fonts}): og.png was not written`); }
await page.screenshot({ path: join(root, 'site', 'og.png'), type: 'png' });
console.log('site/og.png');

// The Chrome Web Store's small promo tile (440 x 280): the name and the one line, large enough to read at the size the store shows it.
const tile = await browser.newPage({ viewport: { width: 440, height: 280 }, deviceScaleFactor: 1 });
await tile.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: Switzer; src: url(${font[300]}) format("woff2"); font-weight: 300; }
  @font-face { font-family: Switzer; src: url(${font[500]}) format("woff2"); font-weight: 500; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { width: 440px; height: 280px; background: #0b0b0a; color: #f2eee3; font-family: Switzer, system-ui, sans-serif; padding: 34px 36px; display: flex; flex-direction: column; justify-content: space-between; -webkit-font-smoothing: antialiased; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 500; font-size: 19px; letter-spacing: -.02em; color: rgba(242, 238, 227, .78); }
  .brand img { width: 15px; height: 20px; }
  h1 { font-weight: 300; font-size: 44px; line-height: 1; letter-spacing: -.05em; }
</style></head><body>
  <div class="brand"><img src="${mark}" alt=""><span>Lamport Warden</span></div>
  <h1>It reads the request before you sign it.</h1>
</body></html>`, { waitUntil: 'load' });
await tile.evaluate(async () => { await Promise.all([300, 500].map((w) => document.fonts.load(`${w} 20px Switzer`))); await document.fonts.ready; });
await tile.screenshot({ path: join(root, 'store', 'promo-440x280.png'), type: 'png' });
console.log('store/promo-440x280.png');
await browser.close();
