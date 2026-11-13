// Starts the built Sentinel service the way the server does and checks it stays up and answers.
//
//   node scripts/build-service.mjs && node scripts/smoke-service.mjs
//
// It exists because of a crash only the built file had: a bundled dependency's loader left
// Error.prepareStackTrace set to a function that throws inside an ES module, and on the server the next
// error anywhere took the process down. A probe loaded beside the service reads an error's stack after
// startup, which fails at once if that ever comes back, on any Node version.
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'sentinel-smoke-'));
const probe = join(dir, 'probe.mjs');
writeFileSync(probe, `setTimeout(() => { try { const e = new Error("probe"); Error.captureStackTrace(e); if (typeof e.stack !== "string") throw new Error("no stack"); console.error("probe: an error's stack can be read"); } catch (err) { console.error("probe: reading an error's stack throws: " + String(err && err.message)); process.exit(42); } }, 1500);\n`);

// an RPC that knows nothing: every wallet is empty, which is all a first read needs
let rpcDown = false;
const rpc = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (rpcDown) { res.statusCode = 503; res.end('{}'); return; }
    const { method } = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: method === 'getSignaturesForAddress' ? [] : { value: method === 'getAccountInfo' ? { owner: '11111111111111111111111111111111' } : [] } }));
  });
});
await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
const port = 18000 + Math.floor(Math.random() * 2000);
const child = spawn(process.execPath, ['--import', probe, join(root, 'sentinel', 'service', 'dist', 'sentinel.mjs')], {
  env: { PATH: process.env.PATH, SENTINEL_RPC_URL: `http://127.0.0.1:${rpc.address().port}`, SENTINEL_DATA_KEY: Buffer.alloc(32, 7).toString('base64'), SENTINEL_DATA_DIR: join(dir, 'data'), SENTINEL_ORIGIN: 'http://localhost:5173', SENTINEL_PORT: String(port), SENTINEL_POLL_SECONDS: '5' },
  stdio: ['ignore', 'inherit', 'pipe'],
});
let log = '';
child.stderr.on('data', (c) => { log += c; });
let exited = null;
child.on('exit', (code) => { exited = code; });
const fail = (why) => { console.error(`smoke: FAILED: ${why}\n--- service log\n${log}`); child.kill(); rpc.close(); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = `http://127.0.0.1:${port}/v1`;
const call = async (method, path, body, bearer) => { const r = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const alive = (when) => { if (exited !== null) fail(`the service exited with ${exited} ${when}`); };

for (let i = 0; i < 40 && !log.includes('API on'); i++) await sleep(250);
alive('while starting');
await sleep(2000);
alive('when an error\'s stack was read after startup');
if (!log.includes("probe: an error's stack can be read")) fail('the probe did not report');

// sign in with a throwaway wallet, as the page does
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (bytes) => { let n = BigInt('0x' + Buffer.from(bytes).toString('hex')); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b === 0) s = '1' + s; else break; } return s; };
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const address = b58(publicKey.export({ format: 'der', type: 'spki' }).subarray(12));
const n = await call('POST', '/nonce', {});
const message = Buffer.from([`${n.body.host} wants you to sign in with your Solana account:`, address, '', 'Sign in to Warden Sentinel.', '', `Nonce: ${n.body.nonce}`, `Issued At: ${new Date().toISOString()}`].join('\n'));
const signed = await call('POST', '/signin', { address, message: message.toString('base64'), signature: sign(null, message, privateKey).toString('base64') });
if (signed.status !== 200) fail(`sign-in answered ${signed.status}`);
const session = signed.body.session;

// a round reads the wallet
for (let i = 0; i < 40; i++) { await sleep(500); alive('during the first read'); if ((await call('GET', '/me', undefined, session)).body.wallets?.[0]?.lastReadAt) break; if (i === 39) fail('the wallet was never read'); }
// the RPC goes away: the service says it is blind and stays up
rpcDown = true;
for (let i = 0; i < 40; i++) { await sleep(500); alive('when the RPC failed'); if ((await call('GET', '/health')).body.blind === 1) break; if (i === 39) fail('an RPC failure was not reported as blind'); }
rpcDown = false;
const removed = await call('DELETE', `/wallets/${address}`, undefined, session);
if (removed.body.profileRemoved !== true) fail('the wallet could not be removed');
alive('at the end');
child.kill();
rpc.close();
console.log('smoke: the built service started, read a wallet, survived an RPC failure and removed the wallet');
