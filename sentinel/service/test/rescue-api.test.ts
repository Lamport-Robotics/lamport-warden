/**
 * Rescue through the API, against a chain that is stood in for: who may ask for what, what is refused before
 * anything is built, what is put on record and said, and the settings that switch it on.
 *
 * (The same code against a real validator, with the real watcher and the compiled program, is
 * rescue-service.validator.test.ts.)
 */
import "../../../src/polyfill.js";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createPrivateKey, sign as edSign } from "node:crypto";
import { Accounts } from "../src/accounts.js";
import { configFrom, rescuerKeyFrom } from "../src/main.js";
import { ASSOCIATED_TOKEN, PROGRAM, TOKEN, TOKEN_2022, configAddress, delegateAddress, vaultTokenAddress } from "../src/program.js";
import { CHANGE_SECONDS, LAMPORT_VAULT_PROGRAM, MOST_RESCUED_A_DAY, NOT_ON_CHAIN, RESCUER_NEEDS_LAMPORTS, Rescue, SPENT_TODAY } from "../src/rescue.js";
import type { RescueResult } from "../src/rescuer.js";
import type { Rpc } from "../src/rpc.js";
import { RateLimiter, api, type ApiRequest } from "../src/server.js";
import { assessTokenAccount, type WatchContext } from "../src/signals.js";
import { signInText } from "../src/signin-text.js";
import { NonceBook } from "../src/signin.js";
import { Baseline } from "../src/baseline.js";
import { MemoryStore, disarmingNow, rescueDelegateOf, rescueVaultOf } from "../src/store.js";
import { MOST_RESCUED_AT_ONCE } from "../src/rescuer.js";
import { parseAnyMessage } from "../../../pincer1/daemon/src/tx/parse.js";
import { readSentinel, vaultOfConfig } from "../../../src/sentinel.js";
import { judge } from "../../../src/judge.js";

const ORIGIN = "https://warden.lamportrobotics.com", HOST = "warden.lamportrobotics.com";
const T0 = 1_800_000_000;
const walletOf = (n: number) => {
  const seed = new Uint8Array(32).fill(n), kp = Keypair.fromSeed(seed);
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]), format: "der", type: "pkcs8" });
  return { address: kp.publicKey.toBase58(), key: kp.publicKey, sign: (m: Uint8Array) => new Uint8Array(edSign(null, m, key)) };
};
const alice = walletOf(1), bob = walletOf(2);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const vaultOf = (n: number) => {
  const id = new Uint8Array(32).fill(n);
  const [address, bump] = PublicKey.findProgramAddressSync([new TextEncoder().encode("vault"), id], new PublicKey(LAMPORT_VAULT_PROGRAM));
  return { address: address.toBase58(), data: Buffer.concat([Buffer.from([211, 8, 232, 43, 2, 152, 117, 119, 2, bump]), Buffer.from(id), Buffer.alloc(80, 7)]) };
};
const VAULT = vaultOf(1), OTHER_VAULT = vaultOf(2);
/** A rescue setup as the program stores one: the owner, the vault, nothing pending, Lamport's rescuers. */
const configData = (owner: PublicKey, vault: string) => Buffer.concat([Buffer.alloc(8, 3), Buffer.from([1, 255]), owner.toBuffer(), new PublicKey(vault).toBuffer(), Buffer.from([0]), Buffer.alloc(16), Buffer.from([0])]);
const mint = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(100 + n)).publicKey.toBase58();
const tokenAccount = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(150 + n)).publicKey.toBase58();

/** As much of a chain as rescue asks about. */
class Chain implements Rpc {
  programs = true;
  genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  accounts = new Map<string, { owner: string; data: Buffer; executable?: boolean }>([[VAULT.address, { owner: LAMPORT_VAULT_PROGRAM, data: VAULT.data }], [OTHER_VAULT.address, { owner: LAMPORT_VAULT_PROGRAM, data: OTHER_VAULT.data }]]);
  tokens = new Map<string, { pubkey: string; mint: string; amount: string; decimals: number; delegate?: string; delegated?: string; frozen?: boolean; program?: string; marks?: string[] }[]>();
  /** The token accounts a vault has, by address, and the token program each is under. */
  places = new Map<string, string>();
  calls: string[] = [];
  down = false;
  /** What the key that rescues holds, in lamports. */
  rescuerHolds = 1_000_000_000;
  /** Addresses the next answer to "these accounts, please" leaves out, once: an RPC that is wrong for a moment. */
  blink = new Set<string>();
  /** Gives the vault a token account for a mint: what an owner's setup makes. */
  place(vault: string, mintOf: string, program = TOKEN): void { this.places.set(vaultTokenAddress(new PublicKey(vault), new PublicKey(mintOf), program).toBase58(), program.toBase58()); }
  private view(address: string) {
    if ((address === PROGRAM.toBase58() || address === LAMPORT_VAULT_PROGRAM) && this.programs) return { owner: "BPFLoaderUpgradeab1e11111111111111111111111", data: ["", "base64"], executable: true };
    if (this.places.has(address)) return { owner: this.places.get(address)!, data: ["", "base64"], executable: false };
    const a = this.accounts.get(address);
    return a ? { owner: a.owner, data: [a.data.toString("base64"), "base64"], executable: false } : null;
  }
  async call(method: string, params: any[]): Promise<any> {
    this.calls.push(method);
    if (this.down) throw new Error("the RPC is down");
    if (method === "getMultipleAccounts") return { value: (params[0] as string[]).map((a) => (this.blink.delete(a) ? null : this.view(a))) };
    if (method === "getAccountInfo") return { value: this.view(params[0]) };
    if (method === "getGenesisHash") return this.genesis;
    if (method === "getLatestBlockhash") return { value: { blockhash: PublicKey.default.toBase58() } };
    if (method === "getBalance") return { value: this.rescuerHolds };
    if (method === "getTokenAccountsByOwner") return { value: (this.tokens.get(params[0]) ?? []).filter((t) => (t.program ?? TOKEN.toBase58()) === params[1].programId).map((t) => ({ pubkey: t.pubkey, account: { data: { parsed: { info: { mint: t.mint, state: t.frozen ? "frozen" : "initialized", tokenAmount: { amount: t.amount, decimals: t.decimals }, ...(t.marks ? { extensions: t.marks.map((extension) => ({ extension })) } : {}), ...(t.delegate ? { delegate: t.delegate, delegatedAmount: { amount: t.delegated ?? "18446744073709551615" } } : {}) } } } } })) };
    throw new Error(`not stood in for: ${method}`);
  }
  arm(owner: PublicKey, vault: string): string {
    this.accounts.set(configAddress(owner).toBase58(), { owner: PROGRAM.toBase58(), data: configData(owner, vault) });
    return delegateAddress(owner, new PublicKey(vault)).toBase58();
  }
}

function service(o: { rescuer?: boolean; rescue?: boolean } = {}) {
  const store = new MemoryStore();
  const accounts = new Accounts(store, Buffer.alloc(32, 7));
  const chain = new Chain();
  let now = T0;
  const noticed: [string, string][] = [], told: [string, string][] = [];
  const rescued: string[] = [], how: { perTransaction?: number; most?: number; vault?: string }[] = [], slept: number[] = [];
  /** What the rescuer answers, try after try; the last answer is given to every try after it. */
  let next: (RescueResult | Error)[] = [{ ok: true, vault: VAULT.address, steps: [{ accounts: [tokenAccount(1), tokenAccount(2)], signature: "sig1", ok: true }] }];
  /** Signatures the chain says landed. */
  const landed = new Set<string>();
  const rescuer = {
    address: bob.address,
    rescue: async (owner: string, opts: { perTransaction?: number; most?: number; vault?: string } = {}): Promise<RescueResult> => {
      // as the real one does (rescuer.ts; run for real in rescue-service.validator.test.ts): a setup that names another vault than the one meant is not acted on
      const config = chain.accounts.get(configAddress(new PublicKey(owner)).toBase58());
      if (opts.vault && config && new PublicKey(config.data.subarray(42, 74)).toBase58() !== opts.vault) return { ok: false, why: "this wallet's setup on the chain names another vault than the one asked for on the Sentinel page." };
      rescued.push(owner); how.push(opts);
      const r = next.length > 1 ? next.shift()! : next[0]!;
      if (r instanceof Error) throw r;
      return r;
    },
    landed: async (signature: string) => landed.has(signature),
  };
  const rescue = new Rescue(chain, o.rescuer === false ? null : rescuer, accounts, store, { now: () => now, notify: async (w, s) => { told.push([w, s]); return { delivered: 1, failed: 0 }; }, notice: async (p, s) => { noticed.push([p, s]); }, sleep: async (ms) => { slept.push(ms); } });
  const nonces = new NonceBook();
  const handle = api({ accounts, store, watcher: { ownerSigned: async () => undefined, confirmOwn: async () => true }, nonces, origin: ORIGIN, now: () => now, limiter: new RateLimiter(), notice: async (p, s) => { noticed.push([p, s]); }, ...(o.rescue === false ? {} : { rescue }) });
  const call = (method: string, path: string, body?: unknown, bearer: string | null = null) => handle({ method, path, body, bearer, ip: "10.0.0.1" } satisfies ApiRequest);
  const signIn = async (w: ReturnType<typeof walletOf>, session?: string) => {
    const n = await call("POST", "/v1/nonce", session ? { purpose: "link" } : {}, session ?? null);
    const message = new TextEncoder().encode(signInText({ host: HOST, address: w.address, nonce: (n.body as any).nonce, purpose: session ? "link" : "signin", issuedAt: new Date(now * 1000).toISOString() }));
    return (await call("POST", "/v1/signin", { address: w.address, message: b64(message), signature: b64(w.sign(message)) }, session ?? null)).body as any;
  };
  /** The page asking for a setup, with the terms agreed to. */
  const arm = (session: string, vault: unknown, accountsOnly?: unknown, wallet = alice.address) => call("POST", `/v1/wallets/${wallet}/rescue/arm`, { vault, agreed: true, ...(accountsOnly !== undefined ? { accounts: accountsOnly } : {}) }, session);
  return { store, accounts, chain, rescue, call, arm, signIn, noticed, told, rescued, how, landed, slept, tick: (s: number) => { now += s; }, now: () => now, answers: (...r: (RescueResult | Error)[]) => { next = r; } };
}
const short = (a: string) => `${a.slice(0, 4)}..${a.slice(-4)}`;
/** A Pro profile whose wallet is set up, on the chain, for the vault it asked for on the page: what Sentinel acts on. */
async function setUp() {
  const s = service();
  const a = await s.signIn(alice);
  s.accounts.setTier(a.profile.id, "pro");
  expect((await s.arm(a.session, VAULT.address)).status).toBe(200);
  const delegate = s.chain.arm(alice.key, VAULT.address);
  await s.rescue.sync([alice.address]);
  s.noticed.length = 0;
  return { s, session: a.session as string, profile: a.profile.id as string, delegate };
}

describe("rescue, where it is not", () => {
  it("a service without it says so, and so does one whose chain has not got the two programs", async () => {
    const none = service({ rescue: false });
    const a = await none.signIn(alice);
    expect((await none.call("GET", "/v1/rescue", undefined, a.session)).body).toEqual({ available: false, on: false, plan: false, auto: false, chain: null });
    expect(await none.call("GET", `/v1/wallets/${alice.address}/rescue`, undefined, a.session)).toEqual({ status: 501, body: { error: NOT_ON_CHAIN } });

    const s = service();
    s.chain.programs = false;
    const b = await s.signIn(alice);
    s.accounts.setTier(b.profile.id, "pro");
    expect((await s.call("GET", "/v1/rescue", undefined, b.session)).body).toEqual({ available: false, on: false, plan: true, auto: false, chain: null });
    for (const [method, path, body] of [["GET", "", undefined], ["POST", "/arm", { vault: VAULT.address, agreed: true }], ["POST", "/disarm", undefined], ["POST", "/now", undefined]] as const) {
      expect(await s.call(method, `/v1/wallets/${alice.address}/rescue${path}`, body, b.session), path).toEqual({ status: 501, body: { error: NOT_ON_CHAIN } });
    }
    // it cannot be switched on where it cannot work; switching it off is never refused
    expect(await s.call("POST", "/v1/rescue/auto", { on: true }, b.session)).toEqual({ status: 501, body: { error: NOT_ON_CHAIN } });
    expect(await s.call("POST", "/v1/rescue/auto", { on: false }, b.session)).toEqual({ status: 200, body: { auto: false } });
    expect(s.rescued).toEqual([]);
    // the chain is not asked again for ten minutes, and then it is: the day the programs are there, the page finds out
    const asked = () => s.chain.calls.filter((m) => m === "getMultipleAccounts").length;
    const before = asked();
    await s.call("GET", "/v1/rescue", undefined, b.session);
    expect(asked()).toBe(before);
    s.chain.programs = true;
    s.tick(601);
    expect((await s.call("GET", "/v1/rescue", undefined, b.session)).body).toMatchObject({ available: true, on: true, chain: "solana:devnet" });
  });

  it("a service that cannot carry a rescue out shows and builds, moves nothing, and says so: no key, a key that is not a rescuer, a key with nothing to pay with", async () => {
    const s = service({ rescuer: false });
    const a = await s.signIn(alice);
    s.accounts.setTier(a.profile.id, "pro");
    expect((await s.call("GET", "/v1/rescue", undefined, a.session)).body).toEqual({ available: true, on: false, plan: true, auto: false, chain: "solana:devnet" });
    s.chain.tokens.set(alice.address, [{ pubkey: tokenAccount(1), mint: mint(1), amount: "5", decimals: 0 }]);
    expect((await s.arm(a.session, VAULT.address)).status).toBe(200);
    expect(await s.call("POST", `/v1/wallets/${alice.address}/rescue/now`, undefined, a.session)).toEqual({ status: 501, body: { error: "rescue is not switched on here." } });
    expect(await s.call("POST", "/v1/rescue/auto", { on: true }, a.session)).toEqual({ status: 501, body: { error: "rescue is not switched on here." } });

    // With a key, the page is told the service can rescue only while the last look at the key says so.
    const k = service();
    const b = await k.signIn(alice);
    k.accounts.setTier(b.profile.id, "pro");
    const on = async () => ((await k.call("GET", "/v1/rescue", undefined, b.session)).body as any).on;
    expect(await on()).toBe(true);
    // the key is not among Lamport's rescuers (there is no rescuer set on this chain)
    expect(await k.rescue.keyStanding()).toEqual({ lamports: 1_000_000_000, amongRescuers: false });
    expect(await on()).toBe(false);
    expect(await k.call("POST", "/v1/rescue/auto", { on: true }, b.session)).toEqual({ status: 501, body: { error: "rescue is not switched on here." } });
    // it is, and holds too little to pay for a rescue
    const set = Buffer.concat([Buffer.alloc(8, 9), Buffer.from([1, 255]), alice.key.toBuffer(), Buffer.from([1, 0, 0, 0]), bob.key.toBuffer()]);
    k.chain.accounts.set(PublicKey.findProgramAddressSync([Buffer.from("rescuers")], PROGRAM)[0].toBase58(), { owner: PROGRAM.toBase58(), data: set });
    k.chain.rescuerHolds = RESCUER_NEEDS_LAMPORTS - 1;
    expect(await k.rescue.keyStanding()).toEqual({ lamports: RESCUER_NEEDS_LAMPORTS - 1, amongRescuers: true });
    expect(await on()).toBe(false);
    k.chain.rescuerHolds = RESCUER_NEEDS_LAMPORTS;
    await k.rescue.keyStanding();
    expect(await on()).toBe(true);
  });
});

describe("rescue through the API", () => {
  it("is Pro's, is asked for by whoever is signed in, and only for that profile's own wallets", async () => {
    const s = service();
    const a = await s.signIn(alice), b = await s.signIn(bob);
    expect((await s.call("GET", "/v1/rescue")).status).toBe(401);
    expect((await s.call("GET", "/v1/rescue", undefined, a.session)).body).toEqual({ available: true, on: true, plan: false, auto: false, chain: "solana:devnet" });
    expect((await s.call("GET", "/v1/me", undefined, a.session)).body).toMatchObject({ limits: { rescue: false } });
    // on the free plan a wallet can be looked at, and a setup can be taken away; nothing can be set up or moved
    expect((await s.call("GET", `/v1/wallets/${alice.address}/rescue`, undefined, a.session)).body).toEqual({ armed: false, ours: false, vault: null, rescuers: null, covered: [], uncovered: [] });
    expect(await s.arm(a.session, VAULT.address)).toEqual({ status: 403, body: { error: "rescue comes with Pro." } });
    expect(await s.call("POST", `/v1/wallets/${alice.address}/rescue/now`, undefined, a.session)).toEqual({ status: 403, body: { error: "rescue comes with Pro." } });
    expect(await s.call("POST", "/v1/rescue/auto", { on: true }, a.session)).toEqual({ status: 403, body: { error: "rescue comes with Pro." } });
    expect(await s.call("POST", `/v1/wallets/${alice.address}/rescue/disarm`, undefined, a.session)).toEqual({ status: 409, body: { error: "this wallet is not set up for rescue." } });
    // somebody else's wallet is not there to be asked about, whatever the plan
    s.accounts.setTier(b.profile.id, "pro");
    for (const [method, path] of [["GET", ""], ["POST", "/arm"], ["POST", "/disarm"], ["POST", "/now"]] as const) {
      expect(await s.call(method, `/v1/wallets/${alice.address}/rescue${path}`, { vault: VAULT.address, agreed: true }, b.session), path).toEqual({ status: 404, body: { error: "that wallet is not in this profile." } });
    }
    expect((await s.call("POST", `/v1/wallets/${alice.address}/rescue/else`, undefined, a.session)).status).toBe(404);
    expect(s.rescued).toEqual([]);
    expect(s.noticed).toEqual([]);
  });

  it("builds nothing before rescue's terms are agreed to, and keeps when they were", async () => {
    const s = service();
    const a = await s.signIn(alice);
    s.accounts.setTier(a.profile.id, "pro");
    for (const body of [{ vault: VAULT.address }, { vault: VAULT.address, agreed: "yes" }, { vault: VAULT.address, agreed: false }]) {
      expect(await s.call("POST", `/v1/wallets/${alice.address}/rescue/arm`, body, a.session)).toEqual({ status: 400, body: { error: "rescue's terms have to be agreed to first." } });
    }
    expect(s.accounts.profile(a.profile.id)!.rescueTermsAt).toBeUndefined();
    expect(s.store.wallets()[0]!.rescueWanted).toBeUndefined();
    expect((await s.arm(a.session, VAULT.address)).status).toBe(200);
    expect(s.accounts.profile(a.profile.id)!.rescueTermsAt).toBe(s.now());
    // the first time is the one that is kept
    s.tick(100);
    await s.arm(a.session, VAULT.address);
    expect(s.accounts.profile(a.profile.id)!.rescueTermsAt).toBe(s.now() - 100);
  });

  it("builds a setup nobody has signed, tells the owner it was asked for, and believes only the chain about whether it happened", async () => {
    const s = service();
    const a = await s.signIn(alice);
    s.accounts.setTier(a.profile.id, "pro");
    s.chain.tokens.set(alice.address, [
      { pubkey: tokenAccount(1), mint: mint(1), amount: "5000000", decimals: 6 },
      { pubkey: tokenAccount(2), mint: mint(2), amount: "900", decimals: 0, program: TOKEN_2022.toBase58() },
      { pubkey: tokenAccount(3), mint: mint(3), amount: "0", decimals: 6 },
      { pubkey: tokenAccount(4), mint: mint(4), amount: "7", decimals: 0, frozen: true },
      // a token that cannot be transferred at all, and one whose issuer's program runs on every transfer
      { pubkey: tokenAccount(5), mint: mint(5), amount: "1", decimals: 0, program: TOKEN_2022.toBase58(), marks: ["immutableOwner", "nonTransferableAccount"] },
      { pubkey: tokenAccount(6), mint: mint(6), amount: "40", decimals: 0, program: TOKEN_2022.toBase58(), marks: ["transferHookAccount"] },
    ]);
    const built = (await s.arm(a.session, VAULT.address)).body as any;
    const delegate = delegateAddress(alice.key, new PublicKey(VAULT.address)).toBase58();
    expect(built).toMatchObject({ ok: true, accounts: 2, makes: 2, vault: VAULT.address, delegate, asked: true });
    // Two transactions, paid by the owner, signed by nobody. First the vault's own token account for each
    // token, which the owner pays for, so that the key that rescues never pays for one.
    expect(built.transactions).toHaveLength(2);
    const makes = Transaction.from(Buffer.from(built.transactions[0], "base64"));
    expect(makes.instructions.map((ix) => [ix.programId.toBase58(), ix.data[0], ix.keys[0]!.pubkey.toBase58(), ix.keys[1]!.pubkey.toBase58(), ix.keys[2]!.pubkey.toBase58()])).toEqual([
      [ASSOCIATED_TOKEN.toBase58(), 1, alice.address, vaultTokenAddress(new PublicKey(VAULT.address), new PublicKey(mint(2)), TOKEN_2022).toBase58(), VAULT.address],
      [ASSOCIATED_TOKEN.toBase58(), 1, alice.address, vaultTokenAddress(new PublicKey(VAULT.address), new PublicKey(mint(1)), TOKEN).toBase58(), VAULT.address],
    ]);
    // Then the config, and an approval for each account that holds something and can be moved. The frozen
    // account and the two tokens a plain transfer cannot move are left out: one of those in a rescue would
    // fail every account sent beside it.
    const tx = Transaction.from(Buffer.from(built.transactions[1], "base64"));
    for (const t of [makes, tx]) { expect(t.feePayer!.toBase58()).toBe(alice.address); expect(t.signatures.every((sig) => sig.signature === null)).toBe(true); }
    expect(tx.instructions.map((ix) => ix.programId.toBase58())).toEqual([PROGRAM.toBase58(), TOKEN_2022.toBase58(), TOKEN.toBase58()]); // the biggest holding first
    for (const ix of tx.instructions.slice(1)) {
      expect(ix.data[0]).toBe(13); // ApproveChecked, and to the one address the rescue program signs for
      expect(ix.keys[2]!.pubkey.toBase58()).toBe(delegate);
      expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([alice.address]);
    }
    // nothing is armed because it was asked for: the page still shows the wallet as it is on the chain
    expect(((await s.call("GET", "/v1/me", undefined, a.session)).body as any).wallets[0].armed).toBe(false);
    // The owner's channels hear that it was asked for. From the asking on, the watcher takes that setup for
    // the owner's own, so whoever is signed in must not be able to ask without the owner knowing.
    expect(s.noticed).toEqual([[a.profile.id, `A rescue setup for ${short(alice.address)} into the Lamport Vault ${short(VAULT.address)} was asked for on the Sentinel page, by someone signed in with ${short(alice.address)}. Nothing changes until that wallet signs it. From now on a setup that names that vault is the one Sentinel uses. If that was not you, someone else has the key to ${short(alice.address)}.`]]);
    // for half an hour the watcher takes approvals to that address for this setup, and after that it does not
    const w = s.store.wallets()[0]!;
    expect(w.rescueWanted).toBe(VAULT.address);
    expect(rescueDelegateOf(w, s.now())).toBe(delegate);
    expect(rescueVaultOf(w, s.now())).toBe(VAULT.address);
    expect(rescueDelegateOf(w, s.now() + CHANGE_SECONDS)).toBeUndefined();
    expect(disarmingNow(w, s.now())).toBe(false);
    // asked again, it is not news, and the half hour does not start over: nobody keeps the watcher lenient by asking and asking
    s.tick(600);
    expect((await s.arm(a.session, VAULT.address)).body).toMatchObject({ asked: false });
    expect(s.noticed).toHaveLength(1);
    expect(s.store.wallets()[0]!.rescueChange!.until).toBe(s.now() - 600 + CHANGE_SECONDS);

    // the owner signs; the chain has the setup; a look finds it, the record follows, and the channels hear of it once
    s.chain.arm(alice.key, VAULT.address);
    s.chain.tokens.get(alice.address)![0]!.delegate = delegate;
    s.chain.tokens.get(alice.address)![1]!.delegate = delegate;
    s.chain.place(VAULT.address, mint(1));
    // approved, and the vault has nowhere to put it yet: a rescue would leave it, so it is not called covered
    const half = (await s.call("GET", `/v1/wallets/${alice.address}/rescue`, undefined, a.session)).body as any;
    expect(half).toMatchObject({ armed: true, ours: true });
    expect(half.covered.map((c: any) => c.account)).toEqual([tokenAccount(1)]);
    expect(half.uncovered.find((u: any) => u.account === tokenAccount(2))).toMatchObject({ why: "not set up" });
    // asked again, the setup is the one thing that is missing: the vault's account for that token, and no new approval
    const rest = (await s.arm(a.session, VAULT.address)).body as any;
    expect(rest).toMatchObject({ accounts: 1, makes: 1, asked: false });
    expect(rest.transactions.map((t: string) => Transaction.from(Buffer.from(t, "base64")).instructions.map((ix) => ix.programId.toBase58()))).toEqual([[ASSOCIATED_TOKEN.toBase58()]]);
    s.chain.place(VAULT.address, mint(2), TOKEN_2022);
    const look = (await s.call("GET", `/v1/wallets/${alice.address}/rescue`, undefined, a.session)).body as any;
    expect(look).toMatchObject({ armed: true, ours: true, vault: VAULT.address, rescuers: "lamport" });
    expect(look.covered.map((c: any) => c.account).sort()).toEqual([tokenAccount(1), tokenAccount(2)].sort());
    expect(look.uncovered.map((u: any) => [u.account, u.why])).toEqual([[tokenAccount(4), "frozen"], [tokenAccount(5), "cannot be moved"], [tokenAccount(6), "cannot be moved"]]);
    // the watcher is told the vault with the address: tokens that arrive there were rescued, and tokens that do not were taken
    expect(s.store.wallets()[0]).toMatchObject({ sentinelDelegate: delegate, sentinelVault: VAULT.address });
    expect(((await s.call("GET", "/v1/me", undefined, a.session)).body as any).wallets[0].armed).toBe(true);
    expect(s.noticed.at(-1)).toEqual([a.profile.id, `The wallet ${short(alice.address)} is set up for rescue into the Lamport Vault ${short(VAULT.address)}. If that was not you, or that is not your vault, someone else has the key to that wallet.`]);
    await s.call("GET", `/v1/wallets/${alice.address}/rescue`, undefined, a.session);
    expect(s.noticed).toHaveLength(2);
    // set up for one vault, it is not pointed at another from here, and there is nothing left to sign for the first
    expect((await s.arm(a.session, OTHER_VAULT.address)).status).toBe(409);
    expect(s.store.wallets()[0]!.rescueWanted).toBe(VAULT.address);
    expect((await s.arm(a.session, VAULT.address)).body).toMatchObject({ transactions: [], accounts: 0 });
    // what is not a vault is refused before anything is built
    for (const bad of [alice.address, bob.address, "nonsense", 5, undefined, PROGRAM.toBase58()]) expect((await s.arm(a.session, bad)).status, String(bad)).toBe(400);
    // a chain that cannot be read is said as that, not as a wallet with nothing in it
    s.chain.down = true;
    expect(await s.call("GET", `/v1/wallets/${alice.address}/rescue`, undefined, a.session)).toEqual({ status: 502, body: { error: "the chain could not be read just now. Try again in a minute." } });
    expect((await s.arm(a.session, VAULT.address)).status).toBe(502);
  });

  it("sets up the token accounts the owner chose and no others, and says when one has given somebody else a permission", async () => {
    const s = service();
    const a = await s.signIn(alice);
    s.accounts.setTier(a.profile.id, "pro");
    // what a wallet looks like: two things its owner holds, one of them listed for sale, and a pile of tokens nobody asked for
    s.chain.tokens.set(alice.address, [
      { pubkey: tokenAccount(1), mint: mint(1), amount: "5000000", decimals: 6 },
      { pubkey: tokenAccount(2), mint: mint(2), amount: "1", decimals: 0, delegate: bob.address, delegated: "1" },
      ...Array.from({ length: 45 }, (_, i) => ({ pubkey: tokenAccount(10 + i), mint: mint(10 + i), amount: String(1_000_000_000 + i), decimals: 0 })),
    ]);
    const look = (await s.call("GET", `/v1/wallets/${alice.address}/rescue`, undefined, a.session)).body as any;
    expect(look.uncovered).toHaveLength(47);
    // a permission somebody else holds on an account is shown: setting the account up would take it away
    expect(look.uncovered.find((u: any) => u.account === tokenAccount(2))).toEqual({ account: tokenAccount(2), mint: mint(2), amount: "1", decimals: 0, why: "not set up", other: bob.address });
    expect(look.uncovered.find((u: any) => u.account === tokenAccount(1)).other).toBeUndefined();
    // chosen: the one the owner wants. The junk, however much of it there is, costs them nothing and rides in no rescue.
    const built = (await s.arm(a.session, VAULT.address, [tokenAccount(1)])).body as any;
    expect(built).toMatchObject({ accounts: 1, makes: 1 });
    expect(built.transactions).toHaveLength(2);
    const approvals = Transaction.from(Buffer.from(built.transactions[1], "base64")).instructions.slice(1);
    expect(approvals.map((ix) => ix.keys[0]!.pubkey.toBase58())).toEqual([tokenAccount(1)]);
    // none chosen: the setup names the vault, and that is all
    const bare = (await s.arm(a.session, VAULT.address, [])).body as any;
    expect(bare).toMatchObject({ accounts: 0, makes: 0 });
    expect(bare.transactions.map((t: string) => Transaction.from(Buffer.from(t, "base64")).instructions.map((ix) => ix.programId.toBase58()))).toEqual([[PROGRAM.toBase58()]]);
    // an account of somebody else's in the list is nothing to this wallet
    expect((await s.arm(a.session, VAULT.address, [tokenAccount(99)])).body).toMatchObject({ accounts: 0 });
    for (const bad of ["all", [5], ["nonsense"], Array.from({ length: 41 }, (_, i) => tokenAccount(i))]) expect(await s.arm(a.session, VAULT.address, bad), JSON.stringify(bad).slice(0, 30)).toEqual({ status: 400, body: { error: "name the token accounts to set up, forty at most." } });
  });

  it("rescues when asked: on the wallet, or as the answer to an alert; puts it on record and tells the owner; not twice in a minute", async () => {
    const { s, session } = await setUp();
    const r = await s.call("POST", `/v1/wallets/${alice.address}/rescue/now`, undefined, session);
    expect(r).toEqual({ status: 200, body: { ok: true, vault: VAULT.address, moved: 2, failed: 0, gone: 0, signatures: ["sig1"] } });
    expect(s.rescued).toEqual([alice.address]);
    // into the vault that was asked for on the page, and no more accounts than one rescue carries
    expect(s.how).toEqual([{ vault: VAULT.address, most: MOST_RESCUED_AT_ONCE }]);
    const sentence = `Sentinel moved 2 of this wallet's token accounts into your Lamport Vault (${short(VAULT.address)}). Only your vault's key can move what is there now. SOL is not moved by a rescue.`;
    expect(s.told).toEqual([[alice.address, sentence]]);
    const events = ((await s.call("GET", "/v1/events", undefined, session)).body as any).events;
    expect(events.map((e: any) => [e.signals, e.level, e.signature, e.sentence, e.canRescue])).toEqual([[["rescued"], "urgent", "sig1", sentence, false]]);
    expect(await s.call("POST", `/v1/wallets/${alice.address}/rescue/now`, undefined, session)).toMatchObject({ status: 429 });

    // An alert, answered with a rescue. When nothing was there to move, nothing is said or recorded, and the
    // alert is as open as it was: it was not answered with a rescue, because there was none.
    s.tick(61);
    s.store.addEvent({ wallet: alice.address, signature: "sigT", slot: 1, at: s.now(), level: "urgent", signals: ["taken_by_permission"], sentence: "x", rescueWorthy: true });
    const alert = s.store.events(alice.address).find((e) => e.signature === "sigT")!;
    s.answers({ ok: true, vault: VAULT.address, steps: [] });
    expect(await s.call("POST", `/v1/events/${alert.id}/answer`, { answer: "rescue" }, session)).toEqual({ status: 200, body: { ok: true, vault: VAULT.address, moved: 0, failed: 0, gone: 0, signatures: [] } });
    expect(s.store.events(alice.address).find((e) => e.signature === "sigT")!.answer).toBeUndefined();
    expect(s.told).toHaveLength(1);
    expect(s.store.events(alice.address).filter((e) => e.signals.includes("rescued"))).toHaveLength(1);
    // when one happened, the alert shows how it was answered; a rescue of several transactions keeps them all
    s.answers({ ok: true, vault: VAULT.address, steps: [{ accounts: [tokenAccount(1)], signature: "sigA", ok: true }, { accounts: [tokenAccount(2)], signature: "sigB", ok: true }] });
    expect((await s.call("POST", `/v1/events/${alert.id}/answer`, { answer: "rescue" }, session)).body).toMatchObject({ moved: 2, signatures: ["sigA", "sigB"] });
    expect(s.store.events(alice.address).find((e) => e.signature === "sigT")!.answer).toBe("rescue");
    expect(s.store.events(alice.address).find((e) => e.signature === "sigA")).toMatchObject({ signals: ["rescued"], also: ["sigB"] });

    // A rescue the chain refused, or could not be asked for, is said as that and the alert stays unanswered.
    // And it can be asked for again at once: nobody is made to wait a minute for a rescue that did not happen.
    s.tick(61);
    s.store.addEvent({ wallet: alice.address, signature: "sigU", slot: 2, at: s.now(), level: "urgent", signals: ["taken_by_permission"], sentence: "y", rescueWorthy: true });
    const second = s.store.events(alice.address).find((e) => e.signature === "sigU")!;
    s.answers({ ok: false, why: "this wallet is not armed." });
    expect(await s.call("POST", `/v1/events/${second.id}/answer`, { answer: "rescue" }, session)).toEqual({ status: 409, body: { error: "this wallet is not armed." } });
    s.answers(new Error("down"));
    expect(await s.call("POST", `/v1/events/${second.id}/answer`, { answer: "rescue" }, session)).toEqual({ status: 502, body: { error: "the chain could not be reached, so nothing was moved. Try again." } });
    expect(s.store.events(alice.address).find((e) => e.signature === "sigU")!.answer).toBeUndefined();
    // and it cannot be asked for without end
    s.answers({ ok: true, vault: VAULT.address, steps: [] });
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await s.call("POST", `/v1/wallets/${alice.address}/rescue/now`, undefined, session)).status;
    expect(last).toBe(429);
    expect((await s.call("POST", `/v1/wallets/${alice.address}/rescue/now`, undefined, session)).body).toEqual({ error: "too many requests. Wait a minute and try again." });
  });

  it("says what a rescue did and nothing more: what moved, what is still there, and what somebody else emptied first", async () => {
    const ask = async (s: ReturnType<typeof service>, session: string) => (await s.call("POST", `/v1/wallets/${alice.address}/rescue/now`, undefined, session)).body as any;
    const holds = (s: ReturnType<typeof service>, ...n: number[]) => s.chain.tokens.set(alice.address, n.map((i) => ({ pubkey: tokenAccount(i), mint: mint(i), amount: "5", decimals: 0 })));

    // One account will not move (its token refuses), and it rode with two that would have. What the first
    // try leaves is sent again one account to a transaction, so the two go and only the one stays.
    {
      const { s, session } = await setUp();
      holds(s, 3);
      s.answers(
        { ok: true, vault: VAULT.address, steps: [{ accounts: [tokenAccount(1), tokenAccount(2), tokenAccount(3)], signature: "s0", ok: false, why: "refused" }] },
        { ok: true, vault: VAULT.address, steps: [{ accounts: [tokenAccount(1)], signature: "s1", ok: true }, { accounts: [tokenAccount(2)], signature: "s2", ok: true }, { accounts: [tokenAccount(3)], signature: "s3", ok: false, why: "refused" }] },
      );
      expect(await ask(s, session)).toEqual({ ok: true, vault: VAULT.address, moved: 2, failed: 1, gone: 0, signatures: ["s1", "s2"] });
      expect(s.how).toEqual([{ vault: VAULT.address, most: MOST_RESCUED_AT_ONCE }, { vault: VAULT.address, most: MOST_RESCUED_AT_ONCE, perTransaction: 1 }]);
      expect(s.told[0]![1]).toBe(`Sentinel moved 2 of this wallet's token accounts into your Lamport Vault (${short(VAULT.address)}). 1 could not be moved and is still in the wallet. Only your vault's key can move what is there now. SOL is not moved by a rescue.`);
      // something was left behind, so it can be asked for again at once
      s.answers({ ok: true, vault: VAULT.address, steps: [] });
      expect((await s.call("POST", `/v1/wallets/${alice.address}/rescue/now`, undefined, session)).status).toBe(200);
    }

    // A thief got there first: the transactions failed, the accounts are empty, and none of it is in the
    // vault. That is not a rescue, and it is not said as one.
    {
      const { s, session } = await setUp();
      holds(s);
      s.answers({ ok: true, vault: VAULT.address, steps: [{ accounts: [tokenAccount(1), tokenAccount(2), tokenAccount(3)], signature: "lost", ok: false, why: "the chain refused it" }] }, { ok: true, vault: VAULT.address, steps: [] });
      expect(await ask(s, session)).toEqual({ ok: true, vault: VAULT.address, moved: 0, failed: 0, gone: 3, signatures: [] });
      expect(s.told[0]![1]).toBe("Sentinel tried to rescue this wallet and moved nothing. 3 were emptied by something else before the rescue reached them: Sentinel did not move what was in them. SOL is not moved by a rescue.");
      expect(s.store.events(alice.address).map((e) => [e.signals, e.level, e.signature])).toEqual([[["rescued"], "urgent", ""]]);
    }

    // A transaction that was given up on and landed all the same: the chain is asked, and its word makes it moved.
    {
      const { s, session } = await setUp();
      holds(s);
      s.landed.add("slow");
      s.answers({ ok: true, vault: VAULT.address, steps: [{ accounts: [tokenAccount(1)], signature: "slow", ok: false, why: "not seen to land in time" }] }, { ok: true, vault: VAULT.address, steps: [] });
      expect(await ask(s, session)).toEqual({ ok: true, vault: VAULT.address, moved: 1, failed: 0, gone: 0, signatures: ["slow"] });
      expect(s.told[0]![1]).toBe(`Sentinel moved 1 of this wallet's token account into your Lamport Vault (${short(VAULT.address)}). Only your vault's key can move what is there now. SOL is not moved by a rescue.`);
    }

    // When the chain cannot be asked afterwards, what did not go through is said to be still there: the careful reading.
    {
      const { s, session } = await setUp();
      s.answers({ ok: true, vault: VAULT.address, steps: [{ accounts: [tokenAccount(1)], signature: "s1", ok: false, why: "refused" }] });
      const down = s.chain.call.bind(s.chain);
      s.chain.call = async (method, params) => { if (method === "getTokenAccountsByOwner") throw new Error("down"); return down(method, params); };
      expect(await ask(s, session)).toMatchObject({ moved: 0, failed: 1, gone: 0 });
      expect(s.told[0]![1]).toBe("Sentinel tried to rescue this wallet and moved nothing. 1 could not be moved and is still in the wallet. SOL is not moved by a rescue.");
    }
  });

  it("pays for so many accounts a day for one profile, and no more", async () => {
    // Whoever is signed in can ask for a rescue, and each one costs the key that sends it a fee per
    // transaction. Three full rescues a day is more than any theft needs and less than draining the key takes.
    const { s, session } = await setUp();
    const full = (n: number): RescueResult => ({ ok: true, vault: VAULT.address, steps: [{ accounts: Array.from({ length: n }, (_, i) => tokenAccount(i + 1)), signature: `s${n}-${s.now()}`, ok: true }] });
    const ask = async () => { s.tick(61); return s.call("POST", `/v1/wallets/${alice.address}/rescue/now`, undefined, session); };
    s.answers(full(MOST_RESCUED_AT_ONCE));
    for (let i = 0; i < MOST_RESCUED_A_DAY / MOST_RESCUED_AT_ONCE - 1; i++) expect((await ask()).status).toBe(200);
    // what is left of the day's count is what the next one may carry
    s.answers(full(30));
    expect((await ask()).status).toBe(200);
    s.answers(full(10));
    expect((await ask()).status).toBe(200);
    expect(s.how.map((h) => h.most)).toEqual([40, 40, 40, 10]);
    expect(await ask()).toEqual({ status: 429, body: { error: SPENT_TODAY } });
    expect(s.rescued).toHaveLength(4);
    // an alert that would have set one off says that it could not, at once
    s.accounts.setAutoRescue(s.accounts.profileOf(alice.address)!, true);
    s.tick(61);
    expect(await s.rescue.after({ wallet: alice.address, signature: "sigT", slot: 1, at: s.now(), level: "urgent", signals: ["taken_by_permission"], sentence: "x", rescueWorthy: true })).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.told.at(-1)![1]).toBe(`An alert about this wallet set off a rescue, and it could not be carried out: ${SPENT_TODAY} Press Rescue now on the Sentinel page, or move what is left yourself.`);
    // the next day it is as it was
    s.tick(86_400);
    s.answers(full(5));
    expect((await ask()).status).toBe(200);
    expect(s.how.at(-1)!.most).toBe(40);
  });

  it("rescues unasked only for an owner who switched that on, tries again when the chain cannot be reached, and says so when it could not", async () => {
    const { s, session, profile } = await setUp();
    const alert = { wallet: alice.address, signature: "sigT", slot: 1, at: s.now(), level: "urgent" as const, signals: ["taken_by_permission" as const], sentence: "x", rescueWorthy: true };
    expect(await s.rescue.after(alert)).toBe(false);
    expect(await s.call("POST", "/v1/rescue/auto", { on: "yes" }, session)).toMatchObject({ status: 400 });
    expect(await s.call("POST", "/v1/rescue/auto", { on: true }, session)).toEqual({ status: 200, body: { auto: true } });
    expect(s.noticed).toEqual([[profile, `Rescue without asking was switched on for your Sentinel profile, by someone signed in with ${short(alice.address)}. From now on, when an alert is serious enough on its own, Sentinel moves the tokens of your armed wallets into your Lamport Vault at once and tells you afterwards. If that was not you, someone else has the key to ${short(alice.address)}.`]]);
    // said once, not every time the box is ticked again
    await s.call("POST", "/v1/rescue/auto", { on: true }, session);
    expect(s.noticed).toHaveLength(1);
    expect((await s.call("GET", "/v1/rescue", undefined, session)).body).toMatchObject({ auto: true });
    // an alert that is not reason enough: nothing. One that is: the rescue, and the sentence says what set it off
    expect(await s.rescue.after({ ...alert, rescueWorthy: false })).toBe(false);
    expect(s.rescued).toEqual([]);
    expect(await s.rescue.after(alert)).toBe(true);
    expect(s.rescued).toEqual([alice.address]);
    expect(s.told[0]![1]).toBe(`An alert about this wallet set off a rescue. Sentinel moved 2 of this wallet's token accounts into your Lamport Vault (${short(VAULT.address)}). Only your vault's key can move what is there now. SOL is not moved by a rescue.`);
    // another alert a moment later needs no rescue of its own, and nothing is said of that
    expect(await s.rescue.after({ ...alert, signature: "sigV" })).toBe(false);
    expect(s.told).toHaveLength(1);

    // The chain cannot be reached: tried three times, a few seconds apart. Then it works.
    s.tick(61);
    s.answers(new Error("down"), new Error("down"), { ok: true, vault: VAULT.address, steps: [{ accounts: [tokenAccount(1)], signature: "late", ok: true }] });
    expect(await s.rescue.after(alert)).toBe(true);
    expect(s.slept).toEqual([2000, 5000]);
    expect(s.told).toHaveLength(2);
    // It never does: the owner, who is counting on this, is told at once that nothing happened.
    s.tick(61);
    s.slept.length = 0;
    s.answers(new Error("down"));
    expect(await s.rescue.after(alert)).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.slept).toEqual([2000, 5000]);
    const failed = "An alert about this wallet set off a rescue, and it could not be carried out: the chain could not be reached. Press Rescue now on the Sentinel page, or move what is left yourself.";
    expect(s.told.at(-1)).toEqual([alice.address, failed]);
    expect(s.store.events(alice.address).at(-1)).toMatchObject({ signals: ["rescue_failed"], level: "urgent", sentence: failed, rescueWorthy: false });
    // A refusal is not tried again: it would be refused again.
    s.slept.length = 0;
    s.answers({ ok: false, why: "this key is not one of the rescuer set." });
    expect(await s.rescue.after(alert)).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.slept).toEqual([]);
    expect(s.told.at(-1)![1]).toContain("could not be carried out: this key is not one of the rescuer set. Press Rescue now");

    // a wallet that is not known to be set up is not rescued, and the chain is not asked on its account
    const b = await s.signIn(bob);
    s.accounts.setTier(b.profile.id, "pro");
    s.accounts.setAutoRescue(b.profile.id, true);
    const before = s.rescued.length;
    expect(await s.rescue.after({ ...alert, wallet: bob.address })).toBe(false);
    // a plan that ended takes rescue with it; the switch stays where the owner left it, and can always be turned off
    s.accounts.setTier(profile, "watch");
    expect(await s.rescue.after(alert)).toBe(false);
    expect(await s.call("POST", "/v1/rescue/auto", { on: false }, session)).toEqual({ status: 200, body: { auto: false } });
    expect(s.noticed.at(-1)![1]).toMatch(/^Rescue without asking was switched off for your Sentinel profile/);
    expect(s.rescued).toHaveLength(before);
  });

  it("after a restart, acts on an alert that was reason for a rescue and had none", async () => {
    const { s, profile } = await setUp();
    s.accounts.setAutoRescue(profile, true);
    const alert = (signature: string, ago: number, rescueWorthy = true) => s.store.addEvent({ wallet: alice.address, signature, slot: 1, at: s.now() - ago, level: "urgent", signals: ["taken_by_permission"], sentence: "x", rescueWorthy });
    // nothing to pick up: an old one, and one that was no reason for a rescue
    alert("old", 3600);
    alert("mild", 30, false);
    expect(await s.rescue.resume()).toBe(0);
    // the service went down between raising this one and rescuing
    alert("fresh", 60);
    expect(await s.rescue.resume()).toBe(1);
    expect(s.rescued).toEqual([alice.address]);
    // and it is not done twice: the rescue is on record after the alert
    expect(await s.rescue.resume()).toBe(0);
    expect(s.rescued).toHaveLength(1);
    // one that was tried and could not be carried out was said; it is not tried again unasked
    s.tick(120);
    alert("another", 10);
    s.answers({ ok: false, why: "this key is not one of the rescuer set." });
    expect(await s.rescue.resume()).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.store.events(alice.address).at(-1)!.signals).toEqual(["rescue_failed"]);
    s.answers({ ok: true, vault: VAULT.address, steps: [{ accounts: [tokenAccount(1)], signature: "x", ok: true }] });
    expect(await s.rescue.resume()).toBe(0);
  });

  it("uses only a setup that names the vault asked for on the page: one made anywhere else is said loudly, shown, and not rescued into", async () => {
    const s = service();
    const a = await s.signIn(alice), b = await s.signIn(bob);
    s.accounts.setTier(a.profile.id, "pro");
    s.accounts.setAutoRescue(a.profile.id, true);
    await s.rescue.sync([alice.address, bob.address]);
    expect(s.noticed).toEqual([]);
    // One phished signature: a setup naming the thief's vault, and approvals for it. Only the wallet's key
    // can make one, and nobody asked for it here.
    const theirs = s.chain.arm(alice.key, OTHER_VAULT.address);
    s.chain.tokens.set(alice.address, [{ pubkey: tokenAccount(1), mint: mint(1), amount: "5", decimals: 0, delegate: theirs }]);
    s.chain.place(OTHER_VAULT.address, mint(1));
    // and at bob's address, a config that names alice as its owner: it says nothing about bob
    s.chain.accounts.set(configAddress(bob.key).toBase58(), { owner: PROGRAM.toBase58(), data: configData(alice.key, VAULT.address) });
    await s.rescue.sync([alice.address, bob.address]);
    await new Promise((r) => setTimeout(r, 0));
    const foreign = `This wallet has been set up for rescue into the Lamport Vault ${short(OTHER_VAULT.address)}, and not from the Sentinel page. Whoever had it sign that can have its tokens moved into that vault. If the vault is not yours, treat this wallet's key as stolen and move what is left to a new wallet. If it is yours, set the wallet up for it on the Sentinel page, and Sentinel will use it.`;
    expect(s.told).toEqual([[alice.address, foreign]]);
    expect(s.store.events(alice.address).map((e) => [e.signals, e.level, e.rescueWorthy])).toEqual([[["rescue_foreign"], "urgent", false]]);
    // said once, however often the chain is read
    await s.rescue.sync([alice.address, bob.address]);
    expect(s.told).toHaveLength(1);
    // Nothing is excused on its account: the watcher is not told that address is rescue's, so an approval to it
    // is an alert and tokens that leave under it are a taking.
    expect(s.store.wallets().map((w) => [w.sentinelDelegate, w.sentinelVault, w.rescueForeign])).toEqual([[undefined, undefined, OTHER_VAULT.address], [undefined, undefined, undefined]]);
    // The page shows it for what it is, and Sentinel moves nothing into it: not when asked, and not on an alert.
    expect((await s.call("GET", `/v1/wallets/${alice.address}/rescue`, undefined, a.session)).body).toMatchObject({ armed: true, ours: false, vault: OTHER_VAULT.address });
    expect(((await s.call("GET", "/v1/me", undefined, a.session)).body as any).wallets[0].armed).toBe(false);
    expect(await s.call("POST", `/v1/wallets/${alice.address}/rescue/now`, undefined, a.session)).toEqual({ status: 409, body: { error: "this wallet was not set up for rescue on the Sentinel page. Set it up here first: Sentinel rescues only into a vault that was named here." } });
    expect(await s.rescue.after({ wallet: alice.address, signature: "sigT", slot: 1, at: s.now(), level: "urgent", signals: ["taken_by_permission"], sentence: "x", rescueWorthy: true })).toBe(false);
    expect(s.rescued).toEqual([]);
    // it can be taken away from the page, like any setup
    expect((await s.call("POST", `/v1/wallets/${alice.address}/rescue/disarm`, undefined, a.session)).status).toBe(200);

    // It was the owner's after all (set up from somewhere else): saying so on the page, for that vault, makes it Sentinel's.
    const confirmed = (await s.arm(a.session, OTHER_VAULT.address)).body as any;
    expect(confirmed).toMatchObject({ transactions: [], asked: true });
    expect(s.store.wallets()[0]).toMatchObject({ sentinelDelegate: theirs, sentinelVault: OTHER_VAULT.address, rescueWanted: OTHER_VAULT.address });
    expect(s.store.wallets()[0]!.rescueForeign).toBeUndefined();
    expect((await s.call("GET", `/v1/wallets/${alice.address}/rescue`, undefined, a.session)).body).toMatchObject({ armed: true, ours: true });
    s.answers({ ok: true, vault: OTHER_VAULT.address, steps: [{ accounts: [tokenAccount(1)], signature: "ok", ok: true }] });
    expect((await s.call("POST", `/v1/wallets/${alice.address}/rescue/now`, undefined, a.session)).body).toMatchObject({ moved: 1 });
    // the rescuer is told which vault is meant, and acts on no other
    expect(s.how.at(-1)).toMatchObject({ vault: OTHER_VAULT.address });

    // Set up here for one vault, and then the chain names another: closed and made again by whoever has the key.
    s.chain.arm(alice.key, VAULT.address);
    await s.rescue.sync([alice.address]);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.told.at(-1)![1]).toContain(`set up for rescue into the Lamport Vault ${short(VAULT.address)}, and not from the Sentinel page`);
    expect(s.store.wallets()[0]!.sentinelDelegate).toBeUndefined();
    s.tick(61);
    const before = s.rescued.length;
    expect(await s.call("POST", `/v1/wallets/${alice.address}/rescue/now`, undefined, a.session)).toEqual({ status: 409, body: { error: "this wallet's setup on the chain names another vault than the one asked for on the Sentinel page." } });
    expect(s.rescued).toHaveLength(before);
    expect(b.profile.id).not.toBe(a.profile.id);
  });

  it("keeps the record in step with the chain: a setup closed from elsewhere is an alert, one wrong answer from the RPC is not, and a pause forgets nothing", async () => {
    const { s, session, profile, delegate } = await setUp();
    expect(s.store.wallets()[0]).toMatchObject({ sentinelDelegate: delegate, sentinelVault: VAULT.address });
    // an account at the right address that the rescue program does not own is nothing
    s.chain.accounts.set(configAddress(bob.key).toBase58(), { owner: TOKEN.toBase58(), data: configData(bob.key, VAULT.address) });
    // The RPC leaves the setup out of one answer. It is asked again, for that wallet alone, before anyone is told anything.
    s.chain.blink.add(configAddress(alice.key).toBase58());
    await s.rescue.sync([alice.address]);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.store.wallets()[0]!.sentinelDelegate).toBe(delegate);
    expect([s.told, s.noticed]).toEqual([[], []]);
    // and when it cannot be asked again, nothing is concluded
    s.chain.blink.add(configAddress(alice.key).toBase58());
    const really = s.chain.call.bind(s.chain);
    s.chain.call = async (method, params) => { if (method === "getAccountInfo") throw new Error("down"); return really(method, params); };
    await s.rescue.sync([alice.address]);
    expect(s.store.wallets()[0]!.sentinelDelegate).toBe(delegate);
    s.chain.call = really;

    // The wallet's plan lapses and it is not read for a while; then it is read again. What was known of its
    // setup is as it was: nobody is told "set up" a second time, and a rescue in between is not taken for a theft.
    s.store.unwatch(alice.address);
    expect(s.store.wallets()).toEqual([]);
    s.store.watch({ address: alice.address });
    expect(s.store.wallets()[0]).toEqual({ address: alice.address, sentinelDelegate: delegate, sentinelVault: VAULT.address, rescueWanted: VAULT.address });
    await s.rescue.sync([alice.address]);
    expect(s.noticed).toEqual([]);

    // Closed, and not from the Sentinel page. Only the wallet's key can do that, and it is what a thief does
    // first: an Urgent alert, on record, and no mere notice.
    s.chain.accounts.delete(configAddress(alice.key).toBase58());
    await s.rescue.sync([alice.address]);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.store.wallets()[0]).toEqual({ address: alice.address, rescueWanted: VAULT.address });
    expect(s.noticed).toEqual([]);
    const closed = "This wallet's rescue setup was closed, and not from the Sentinel page. Nothing can rescue it now. If that was not you, someone else has this wallet's key: move what is left to a new wallet.";
    expect(s.told).toEqual([[alice.address, closed]]);
    expect(s.store.events(alice.address).map((e) => [e.signals, e.level, e.sentence, e.rescueWorthy])).toEqual([[["rescue_closed"], "urgent", closed, false]]);

    // Taken away on the page, it is the owner's doing: the channels hear that it was asked, and then that it is gone. No alert.
    s.chain.arm(alice.key, VAULT.address);
    await s.rescue.sync([alice.address]);
    s.noticed.length = 0;
    expect((await s.call("POST", `/v1/wallets/${alice.address}/rescue/disarm`, undefined, session)).body).toMatchObject({ asked: true });
    expect(s.noticed).toEqual([[profile, `Taking the rescue setup away from ${short(alice.address)} was asked for on the Sentinel page, by someone signed in with ${short(alice.address)}. Nothing changes until that wallet signs it. For the next half hour Sentinel takes its rescue permissions being removed for your doing. If that was not you, someone else has the key to ${short(alice.address)}.`]]);
    s.chain.accounts.delete(configAddress(alice.key).toBase58());
    await s.rescue.sync([alice.address]);
    expect(s.noticed.at(-1)).toEqual([profile, `The wallet ${short(alice.address)} is no longer set up for rescue. If that was not you, someone else has the key to that wallet.`]);
    expect(s.told).toHaveLength(1);
    // and with the setup gone at the owner's asking, the vault is no longer one Sentinel was asked to use
    expect(s.store.wallets()[0]!.rescueWanted).toBeUndefined();
  });

  it("taking a setup away is the owner's on any plan, leaves what cannot be revoked, and tells the watcher the permissions going is their doing", async () => {
    const s = service();
    const a = await s.signIn(alice);
    const delegate = s.chain.arm(alice.key, VAULT.address);
    s.chain.tokens.set(alice.address, [
      { pubkey: tokenAccount(1), mint: mint(1), amount: "0", decimals: 6, delegate },
      { pubkey: tokenAccount(2), mint: mint(2), amount: "4", decimals: 0, delegate: bob.address },
      // frozen: nobody can revoke on it, and a revoke for it would fail everything sent beside it
      { pubkey: tokenAccount(3), mint: mint(3), amount: "9", decimals: 0, delegate, frozen: true },
    ]);
    const built = (await s.call("POST", `/v1/wallets/${alice.address}/rescue/disarm`, undefined, a.session)).body as any;
    expect(built).toMatchObject({ frozen: 1, asked: true });
    // The permission given for rescue is revoked, and a permission given to anyone else is not touched. Then the
    // setup is closed, in a transaction with nothing else in it: that is the only shape of a closing Warden lets through.
    const txs = (built.transactions as string[]).map((t) => Transaction.from(Buffer.from(t, "base64")));
    expect(txs.map((tx) => tx.instructions.map((ix) => [ix.programId.toBase58(), ix.keys[0]!.pubkey.toBase58()]))).toEqual([[[TOKEN.toBase58(), tokenAccount(1)]], [[PROGRAM.toBase58(), alice.address]]]);
    expect(txs[0]!.instructions[0]!.data).toEqual(Buffer.from([5])); // Revoke
    expect(txs.every((tx) => tx.feePayer!.toBase58() === alice.address && tx.signatures.every((sig) => sig.signature === null))).toBe(true);
    const w = s.store.wallets()[0]!;
    expect(disarmingNow(w, s.now())).toBe(true);
    expect(disarmingNow(w, s.now() + CHANGE_SECONDS)).toBe(false);
    // asked again while that stands: not news, and it does not stand any longer for it
    s.tick(900);
    expect((await s.call("POST", `/v1/wallets/${alice.address}/rescue/disarm`, undefined, a.session)).body).toMatchObject({ asked: false });
    expect(s.store.wallets()[0]!.rescueChange!.until).toBe(s.now() - 900 + CHANGE_SECONDS);
    expect(s.noticed.filter((n) => n[1].startsWith("Taking the rescue setup away"))).toHaveLength(1);

    // what the watcher makes of Sentinel's permission going from an account: the owner's doing while that is so, and an alarm otherwise
    const ctx = (disarming: boolean): WatchContext => ({ wallet: alice.address, baseline: Baseline.from(null), sentinelDelegate: delegate, drainers: new Set(), disarming });
    const before = { address: tokenAccount(1), owner: alice.address, mint: mint(1), delegate, closeAuthority: null }, after = { address: tokenAccount(1), owner: alice.address, mint: mint(1), delegate: null, closeAuthority: null };
    expect(assessTokenAccount(before, after, ctx(true))).toMatchObject({ level: "info", rescueWorthy: false, sentence: expect.stringMatching(/was removed, as asked for on the Sentinel page\.$/) });
    expect(assessTokenAccount(before, after, ctx(false))).toMatchObject({ level: "urgent", rescueWorthy: true });
    // moved to somebody else is an alarm even then: taking a setup away never hands the permission on
    expect(assessTokenAccount(before, { ...after, delegate: bob.address }, ctx(true))).toMatchObject({ level: "urgent", rescueWorthy: true });
  });
});

describe("what the service builds, Warden lets through", () => {
  // Warden reads Sentinel's requests by their exact shape and refuses whatever is not in one of them
  // (src/sentinel.ts). An owner with Warden in their browser signs these through it, so each transaction the
  // service builds is put to Warden's own reader here.
  const wardenOn = (transaction: string, state?: { vault: string }) => readSentinel(parseAnyMessage(Transaction.from(Buffer.from(transaction, "base64")).serializeMessage(), { owner: alice.address, lookupTables: {} }), alice.address, ORIGIN, state);
  const dots = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
  const memory = (state?: { vault: string }) => ({ load: async () => undefined, save: async () => undefined, sentinel: async () => state }) as any;
  const bytes = (transaction: string) => Uint8Array.from(Buffer.from(transaction, "base64"));

  it("the setup, the tokens that came later, and taking it away, each in a shape Warden knows", async () => {
    const s = service();
    const a = await s.signIn(alice);
    s.accounts.setTier(a.profile.id, "pro");
    // more token accounts than one transaction carries
    s.chain.tokens.set(alice.address, Array.from({ length: 8 }, (_, i) => ({ pubkey: tokenAccount(i + 1), mint: mint(i + 1), amount: String(100 - i), decimals: 0, ...(i % 2 ? { program: TOKEN_2022.toBase58() } : {}) })));
    const built = (await s.arm(a.session, VAULT.address)).body as any;
    expect(built).toMatchObject({ accounts: 8, makes: 8 });
    expect(built.transactions).toHaveLength(3);
    // First the vault's token accounts, eight to a transaction. Nothing of Sentinel's is in it, so it is left
    // to Warden's engine like any transaction, and the engine lets it through: no token leaves the wallet.
    expect(wardenOn(built.transactions[0])).toEqual({ kind: "none" });
    expect((await judge({ kind: "tx", bytes: bytes(built.transactions[0]), owner: alice.address }, ORIGIN, memory())).verdict.level).toBe("allow");
    const first = wardenOn(built.transactions[1]);
    expect(first).toMatchObject({ kind: "verdict", after: { vault: VAULT.address }, verdict: { level: "confirm", confirm: { kind: "last4", expect: VAULT.address.slice(-4) }, sentence: `Sets up Warden Sentinel for this wallet. In a rescue, your tokens can go only to the Lamport Vault ${dots(VAULT.address)}. It arms 6 token accounts. Changing that vault later takes 72 hours, or closing this setup and making another.` } });
    // the rest of the approvals, once this browser has seen the setup
    expect(wardenOn(built.transactions[2], { vault: VAULT.address })).toMatchObject({ kind: "verdict", verdict: { level: "explain", sentence: `Arms 2 token accounts for Warden Sentinel: it may move them into your Lamport Vault ${dots(VAULT.address)}, and nowhere else.` } });

    // set up; a token arrives; covering it is a place for it in the vault, and then an approval alone
    const delegate = s.chain.arm(alice.key, VAULT.address);
    for (const t of s.chain.tokens.get(alice.address)!) { t.delegate = delegate; s.chain.place(VAULT.address, t.mint, new PublicKey(t.program ?? TOKEN.toBase58())); }
    s.chain.tokens.get(alice.address)!.push({ pubkey: tokenAccount(20), mint: mint(20), amount: "3", decimals: 0 });
    const more = (await s.arm(a.session, VAULT.address)).body as any;
    expect(more).toMatchObject({ accounts: 1, makes: 1 });
    expect(more.transactions).toHaveLength(2);
    expect(wardenOn(more.transactions[0], { vault: VAULT.address })).toEqual({ kind: "none" });
    expect(wardenOn(more.transactions[1], { vault: VAULT.address })).toMatchObject({ verdict: { level: "explain", sentence: expect.stringContaining("Arms 1 token account for Warden Sentinel") } });

    // Taking it away: the revokes are ordinary transactions, left to Warden's engine like any other; the
    // closing stands alone, and Warden asks for a typed "I understand" before it passes it on.
    s.chain.tokens.get(alice.address)!.at(-1)!.delegate = delegate;
    const away = (await s.call("POST", `/v1/wallets/${alice.address}/rescue/disarm`, undefined, a.session)).body as any;
    expect(away.transactions).toHaveLength(3); // nine revokes, six to a transaction, and the closing
    expect(wardenOn(away.transactions[0], { vault: VAULT.address })).toEqual({ kind: "none" });
    expect(wardenOn(away.transactions[1], { vault: VAULT.address })).toEqual({ kind: "none" });
    expect(wardenOn(away.transactions[2], { vault: VAULT.address })).toMatchObject({ kind: "verdict", after: null, verdict: { level: "confirm", confirm: { kind: "acknowledge", expect: "I understand" }, sentence: expect.stringMatching(/^Turns Warden Sentinel off for this wallet\./) } });
    // nothing the service builds is refused
    for (const t of [...built.transactions, ...more.transactions, ...away.transactions]) expect((wardenOn(t, { vault: VAULT.address }) as any).verdict?.level).not.toBe("block");
  });

  it("in a browser that never saw the setup, Warden reads it from the chain and has the owner check the vault there too", async () => {
    const s = service();
    const a = await s.signIn(alice);
    s.accounts.setTier(a.profile.id, "pro");
    const delegate = s.chain.arm(alice.key, VAULT.address);
    s.chain.tokens.set(alice.address, [{ pubkey: tokenAccount(1), mint: mint(1), amount: "3", decimals: 0 }]);
    s.chain.place(VAULT.address, mint(1));
    const more = (await s.arm(a.session, VAULT.address)).body as any;
    expect(more.transactions).toHaveLength(1);
    const req = { kind: "tx" as const, bytes: bytes(more.transactions[0]), owner: alice.address };
    // With nothing remembered and nothing to ask, an unlimited permission is what the engine exists to stop.
    expect((await judge(req, ORIGIN, memory())).verdict.level).toBe("block");
    // Asked of the chain, the setup names the vault this approval is for: the same check as at setup, in this browser now.
    const asked: string[] = [];
    const onChain = { sentinelVault: async (owner: string) => { asked.push(owner); return vaultOfConfig({ owner: PROGRAM.toBase58(), data: configData(alice.key, VAULT.address) }, owner); } };
    const seen = await judge(req, ORIGIN, memory(), onChain);
    expect(seen.verdict).toMatchObject({ level: "confirm", confirm: { kind: "last4", expect: VAULT.address.slice(-4) }, sentence: `Arms 1 token account for Warden Sentinel: it may move them into the Lamport Vault ${dots(VAULT.address)}, and nowhere else. That is the vault this wallet's Sentinel setup names; this browser has not shown it to you before.` });
    // once let through, this browser remembers, and the next one is explained without being asked again
    expect(seen.sentinelAfter).toEqual({ vault: VAULT.address });
    expect(asked).toEqual([alice.address]);
    expect((await judge(req, ORIGIN, memory({ vault: VAULT.address }), onChain)).verdict.level).toBe("explain");
    expect(asked).toHaveLength(1);
    // The chain is asked only for approvals from the Sentinel page. Anywhere else, and for anything else, it is not, and nothing is softened.
    expect((await judge(req, "https://evil.example", memory(), onChain)).verdict.level).toBe("block");
    expect(asked).toHaveLength(1);
    // a setup for another vault does not excuse an approval to this one's address
    const other = { sentinelVault: async (owner: string) => vaultOfConfig({ owner: PROGRAM.toBase58(), data: configData(alice.key, OTHER_VAULT.address) }, owner) };
    expect((await judge(req, ORIGIN, memory(), other)).verdict.level).toBe("block");
    // and what is at the config's address has to be the Sentinel program's, and this owner's
    expect(vaultOfConfig({ owner: TOKEN.toBase58(), data: configData(alice.key, VAULT.address) }, alice.address)).toBeNull();
    expect(vaultOfConfig({ owner: PROGRAM.toBase58(), data: configData(bob.key, VAULT.address) }, alice.address)).toBeNull();
    expect(vaultOfConfig({ owner: PROGRAM.toBase58(), data: Buffer.alloc(40) }, alice.address)).toBeNull();
    expect(vaultOfConfig(null, alice.address)).toBeNull();
    // an RPC that cannot be reached leaves it as it was: blocked
    expect((await judge(req, ORIGIN, memory(), { sentinelVault: async () => { throw new Error("offline"); } })).verdict.level).toBe("block");
    expect(delegate).toBe(delegateAddress(alice.key, new PublicKey(VAULT.address)).toBase58());
  });
});

describe("the key a service rescues with", () => {
  const kp = Keypair.fromSeed(new Uint8Array(32).fill(44));
  const base = { SENTINEL_RPC_URL: "https://rpc.example", SENTINEL_DATA_KEY: Buffer.alloc(32, 1).toString("base64") };
  it("is read as solana-keygen writes it or as base64, and anything else stops the service from starting without being repeated", () => {
    expect(rescuerKeyFrom(undefined)).toBeNull();
    expect(rescuerKeyFrom("  ")).toBeNull();
    expect(Buffer.from(rescuerKeyFrom(JSON.stringify([...kp.secretKey]))!)).toEqual(Buffer.from(kp.secretKey));
    expect(Buffer.from(rescuerKeyFrom(Buffer.from(kp.secretKey).toString("base64"))!)).toEqual(Buffer.from(kp.secretKey));
    const mismatched = Uint8Array.from([...kp.secretKey.slice(0, 32), ...Keypair.generate().publicKey.toBytes()]);
    for (const bad of ["not a key", "[1,2,3]", JSON.stringify([...kp.secretKey.slice(0, 32)]), Buffer.from(kp.secretKey.slice(0, 40)).toString("base64"), JSON.stringify([...mismatched]), "[1,2,\"x\"]", "[300]"]) expect(rescuerKeyFrom(bad), bad).toBeUndefined();
    const ok = configFrom({ ...base, SENTINEL_RESCUER_KEY: JSON.stringify([...kp.secretKey]) });
    expect(ok.ok && ok.config.rescuerKey && Keypair.fromSecretKey(ok.config.rescuerKey).publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    const none = configFrom(base);
    expect(none.ok && none.config.rescuerKey).toBeNull();
    expect(none.ok && none.config.rescueRpcUrl).toBeNull();
    const bad = configFrom({ ...base, SENTINEL_RESCUER_KEY: "hunter2-not-a-key" });
    expect(bad).toEqual({ ok: false, why: "SENTINEL_RESCUER_KEY has to be a keypair as solana-keygen writes it (a list of 64 numbers), or those 64 bytes in base64." });
    expect(JSON.stringify(bad)).not.toContain("hunter2");
    // an RPC of its own for rescues, when there is to be one
    const own = configFrom({ ...base, SENTINEL_RESCUE_RPC_URL: "https://fast.example/x" });
    expect(own.ok && own.config.rescueRpcUrl).toBe("https://fast.example/x");
    expect(configFrom({ ...base, SENTINEL_RESCUE_RPC_URL: "ftp://nope" })).toEqual({ ok: false, why: "SENTINEL_RESCUE_RPC_URL has to be the address of a Solana RPC." });
  });
});
