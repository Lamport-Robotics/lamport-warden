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
import { PROGRAM, TOKEN, TOKEN_2022, configAddress, delegateAddress } from "../src/program.js";
import { CHANGE_SECONDS, LAMPORT_VAULT_PROGRAM, NOT_ON_CHAIN, Rescue } from "../src/rescue.js";
import type { RescueResult } from "../src/rescuer.js";
import type { Rpc } from "../src/rpc.js";
import { RateLimiter, api, type ApiRequest } from "../src/server.js";
import { assessTokenAccount, type WatchContext } from "../src/signals.js";
import { signInText } from "../src/signin-text.js";
import { NonceBook } from "../src/signin.js";
import { Baseline } from "../src/baseline.js";
import { MemoryStore, disarmingNow, rescueDelegateOf } from "../src/store.js";
import { parseAnyMessage } from "../../../pincer1/daemon/src/tx/parse.js";
import { readSentinel } from "../../../src/sentinel.js";

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
  tokens = new Map<string, { pubkey: string; mint: string; amount: string; decimals: number; delegate?: string; delegated?: string; frozen?: boolean; program?: string }[]>();
  calls: string[] = [];
  down = false;
  private view(address: string) {
    if ((address === PROGRAM.toBase58() || address === LAMPORT_VAULT_PROGRAM) && this.programs) return { owner: "BPFLoaderUpgradeab1e11111111111111111111111", data: ["", "base64"], executable: true };
    const a = this.accounts.get(address);
    return a ? { owner: a.owner, data: [a.data.toString("base64"), "base64"], executable: false } : null;
  }
  async call(method: string, params: any[]): Promise<any> {
    this.calls.push(method);
    if (this.down) throw new Error("the RPC is down");
    if (method === "getMultipleAccounts") return { value: (params[0] as string[]).map((a) => this.view(a)) };
    if (method === "getAccountInfo") return { value: this.view(params[0]) };
    if (method === "getGenesisHash") return this.genesis;
    if (method === "getLatestBlockhash") return { value: { blockhash: PublicKey.default.toBase58() } };
    if (method === "getBalance") return { value: 1 };
    if (method === "getTokenAccountsByOwner") return { value: (this.tokens.get(params[0]) ?? []).filter((t) => (t.program ?? TOKEN.toBase58()) === params[1].programId).map((t) => ({ pubkey: t.pubkey, account: { data: { parsed: { info: { mint: t.mint, state: t.frozen ? "frozen" : "initialized", tokenAmount: { amount: t.amount, decimals: t.decimals }, ...(t.delegate ? { delegate: t.delegate, delegatedAmount: { amount: t.delegated ?? "18446744073709551615" } } : {}) } } } } })) };
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
  const rescued: string[] = [];
  let next: RescueResult | Error = { ok: true, vault: VAULT.address, steps: [{ accounts: [tokenAccount(1), tokenAccount(2)], signature: "sig1", ok: true }, { accounts: [tokenAccount(3)], signature: null, ok: false, why: "refused" }] };
  const rescuer = { address: alice.address, rescue: async (owner: string): Promise<RescueResult> => { rescued.push(owner); if (next instanceof Error) throw next; return next; } };
  const rescue = new Rescue(chain, o.rescuer === false ? null : rescuer, accounts, store, { now: () => now, notify: async (w, s) => { told.push([w, s]); return { delivered: 1, failed: 0 }; }, notice: async (p, s) => { noticed.push([p, s]); } });
  const nonces = new NonceBook();
  const handle = api({ accounts, store, watcher: { ownerSigned: async () => undefined, confirmOwn: async () => true }, nonces, origin: ORIGIN, now: () => now, limiter: new RateLimiter(), notice: async (p, s) => { noticed.push([p, s]); }, ...(o.rescue === false ? {} : { rescue }) });
  const call = (method: string, path: string, body?: unknown, bearer: string | null = null) => handle({ method, path, body, bearer, ip: "10.0.0.1" } satisfies ApiRequest);
  const signIn = async (w: ReturnType<typeof walletOf>, session?: string) => {
    const n = await call("POST", "/v1/nonce", session ? { purpose: "link" } : {}, session ?? null);
    const message = new TextEncoder().encode(signInText({ host: HOST, address: w.address, nonce: (n.body as any).nonce, purpose: session ? "link" : "signin", issuedAt: new Date(now * 1000).toISOString() }));
    return (await call("POST", "/v1/signin", { address: w.address, message: b64(message), signature: b64(w.sign(message)) }, session ?? null)).body as any;
  };
  return { store, accounts, chain, rescue, call, signIn, noticed, told, rescued, tick: (s: number) => { now += s; }, now: () => now, answers: (r: RescueResult | Error) => { next = r; } };
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
    for (const [method, path, body] of [["GET", "", undefined], ["POST", "/arm", { vault: VAULT.address }], ["POST", "/disarm", undefined], ["POST", "/now", undefined]] as const) {
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

  it("a service that was given no key shows and builds, and moves nothing", async () => {
    const s = service({ rescuer: false });
    const a = await s.signIn(alice);
    s.accounts.setTier(a.profile.id, "pro");
    expect((await s.call("GET", "/v1/rescue", undefined, a.session)).body).toEqual({ available: true, on: false, plan: true, auto: false, chain: "solana:devnet" });
    s.chain.tokens.set(alice.address, [{ pubkey: tokenAccount(1), mint: mint(1), amount: "5", decimals: 0 }]);
    expect((await s.call("POST", `/v1/wallets/${alice.address}/rescue/arm`, { vault: VAULT.address }, a.session)).status).toBe(200);
    expect(await s.call("POST", `/v1/wallets/${alice.address}/rescue/now`, undefined, a.session)).toEqual({ status: 501, body: { error: "rescue is not switched on here." } });
    expect(await s.call("POST", "/v1/rescue/auto", { on: true }, a.session)).toEqual({ status: 501, body: { error: NOT_ON_CHAIN } });
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
    expect((await s.call("GET", `/v1/wallets/${alice.address}/rescue`, undefined, a.session)).body).toEqual({ armed: false, vault: null, rescuers: null, covered: [], uncovered: [] });
    expect(await s.call("POST", `/v1/wallets/${alice.address}/rescue/arm`, { vault: VAULT.address }, a.session)).toEqual({ status: 403, body: { error: "rescue comes with Pro." } });
    expect(await s.call("POST", `/v1/wallets/${alice.address}/rescue/now`, undefined, a.session)).toEqual({ status: 403, body: { error: "rescue comes with Pro." } });
    expect(await s.call("POST", "/v1/rescue/auto", { on: true }, a.session)).toEqual({ status: 403, body: { error: "rescue comes with Pro." } });
    expect(await s.call("POST", `/v1/wallets/${alice.address}/rescue/disarm`, undefined, a.session)).toEqual({ status: 409, body: { error: "this wallet is not set up for rescue." } });
    // somebody else's wallet is not there to be asked about, whatever the plan
    s.accounts.setTier(b.profile.id, "pro");
    for (const [method, path] of [["GET", ""], ["POST", "/arm"], ["POST", "/disarm"], ["POST", "/now"]] as const) {
      expect(await s.call(method, `/v1/wallets/${alice.address}/rescue${path}`, { vault: VAULT.address }, b.session), path).toEqual({ status: 404, body: { error: "that wallet is not in this profile." } });
    }
    expect((await s.call("POST", `/v1/wallets/${alice.address}/rescue/else`, undefined, a.session)).status).toBe(404);
    expect(s.rescued).toEqual([]);
  });

  it("builds a setup nobody has signed, tells the watcher what was asked for, and believes only the chain about whether it happened", async () => {
    const s = service();
    const a = await s.signIn(alice);
    s.accounts.setTier(a.profile.id, "pro");
    s.chain.tokens.set(alice.address, [
      { pubkey: tokenAccount(1), mint: mint(1), amount: "5000000", decimals: 6 },
      { pubkey: tokenAccount(2), mint: mint(2), amount: "900", decimals: 0, program: TOKEN_2022.toBase58() },
      { pubkey: tokenAccount(3), mint: mint(3), amount: "0", decimals: 6 },
      { pubkey: tokenAccount(4), mint: mint(4), amount: "7", decimals: 0, frozen: true },
    ]);
    const built = (await s.call("POST", `/v1/wallets/${alice.address}/rescue/arm`, { vault: VAULT.address }, a.session)).body as any;
    const delegate = delegateAddress(alice.key, new PublicKey(VAULT.address)).toBase58();
    expect(built).toMatchObject({ ok: true, accounts: 2, vault: VAULT.address, delegate });
    // one transaction, paid by the owner, signed by nobody: the config, and an approval for each account that holds something and can move
    const tx = Transaction.from(Buffer.from(built.transactions[0], "base64"));
    expect(built.transactions).toHaveLength(1);
    expect(tx.feePayer!.toBase58()).toBe(alice.address);
    expect(tx.signatures.every((sig) => sig.signature === null)).toBe(true);
    expect(tx.instructions.map((ix) => ix.programId.toBase58())).toEqual([PROGRAM.toBase58(), TOKEN_2022.toBase58(), TOKEN.toBase58()]); // the biggest holding first
    for (const ix of tx.instructions.slice(1)) {
      expect(ix.data[0]).toBe(13); // ApproveChecked, and to the one address the rescue program signs for
      expect(ix.keys[2]!.pubkey.toBase58()).toBe(delegate);
      expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([alice.address]);
    }
    // nothing is armed because it was asked for: the page still shows the wallet as it is on the chain
    expect(((await s.call("GET", "/v1/me", undefined, a.session)).body as any).wallets[0].armed).toBe(false);
    expect(s.noticed).toEqual([]);
    // for half an hour the watcher takes approvals to that address for this setup, and after that it does not
    const w = s.store.wallets()[0]!;
    expect(rescueDelegateOf(w, s.now())).toBe(delegate);
    expect(rescueDelegateOf(w, s.now() + CHANGE_SECONDS)).toBeUndefined();
    expect(disarmingNow(w, s.now())).toBe(false);

    // the owner signs; the chain has the setup; a look finds it, the record follows, and the channels hear of it once
    s.chain.arm(alice.key, VAULT.address);
    s.chain.tokens.get(alice.address)![0]!.delegate = delegate;
    s.chain.tokens.get(alice.address)![1]!.delegate = delegate;
    const look = (await s.call("GET", `/v1/wallets/${alice.address}/rescue`, undefined, a.session)).body as any;
    expect(look).toMatchObject({ armed: true, vault: VAULT.address, rescuers: "lamport" });
    expect(look.covered.map((c: any) => c.account).sort()).toEqual([tokenAccount(1), tokenAccount(2)].sort());
    expect(look.uncovered).toEqual([{ account: tokenAccount(4), mint: mint(4), amount: "7", decimals: 0, why: "frozen" }]);
    expect(((await s.call("GET", "/v1/me", undefined, a.session)).body as any).wallets[0].armed).toBe(true);
    expect(s.noticed).toEqual([[a.profile.id, `The wallet ${alice.address.slice(0, 4)}..${alice.address.slice(-4)} is set up for rescue into the Lamport Vault ${VAULT.address.slice(0, 4)}..${VAULT.address.slice(-4)}. If that was not you, or that is not your vault, someone else has the key to that wallet.`]]);
    await s.call("GET", `/v1/wallets/${alice.address}/rescue`, undefined, a.session);
    expect(s.noticed).toHaveLength(1);
    // set up for one vault, it is not pointed at another from here, and there is nothing left to sign for the first
    expect((await s.call("POST", `/v1/wallets/${alice.address}/rescue/arm`, { vault: OTHER_VAULT.address }, a.session)).status).toBe(409);
    expect((await s.call("POST", `/v1/wallets/${alice.address}/rescue/arm`, { vault: VAULT.address }, a.session)).body).toMatchObject({ transactions: [], accounts: 0 });
    // what is not a vault is refused before anything is built
    for (const bad of [alice.address, bob.address, "nonsense", 5, undefined, PROGRAM.toBase58()]) expect((await s.call("POST", `/v1/wallets/${alice.address}/rescue/arm`, { vault: bad }, a.session)).status, String(bad)).toBe(400);
    // a chain that cannot be read is said as that, not as a wallet with nothing in it
    s.chain.down = true;
    expect(await s.call("GET", `/v1/wallets/${alice.address}/rescue`, undefined, a.session)).toEqual({ status: 502, body: { error: "the chain could not be read just now. Try again in a minute." } });
    expect((await s.call("POST", `/v1/wallets/${alice.address}/rescue/arm`, { vault: VAULT.address }, a.session)).status).toBe(502);
  });

  it("rescues when asked: on the wallet, or as the answer to an alert; puts it on record and tells the owner; not twice in a minute", async () => {
    const s = service();
    const a = await s.signIn(alice);
    s.accounts.setTier(a.profile.id, "pro");
    s.chain.arm(alice.key, VAULT.address);
    const r = await s.call("POST", `/v1/wallets/${alice.address}/rescue/now`, undefined, a.session);
    expect(r).toEqual({ status: 200, body: { ok: true, vault: VAULT.address, moved: 2, failed: 1, signatures: ["sig1"] } });
    expect(s.rescued).toEqual([alice.address]);
    const sentence = `Sentinel moved 2 of this wallet's token accounts into your Lamport Vault (${VAULT.address.slice(0, 4)}..${VAULT.address.slice(-4)}). 1 could not be moved and is still in the wallet. Only your vault's key can move what is there now. SOL is not moved by a rescue.`;
    expect(s.told).toEqual([[alice.address, sentence]]);
    const events = ((await s.call("GET", "/v1/events", undefined, a.session)).body as any).events;
    expect(events.map((e: any) => [e.signals, e.level, e.signature, e.sentence, e.canRescue])).toEqual([[["rescued"], "urgent", "sig1", sentence, false]]);
    expect(await s.call("POST", `/v1/wallets/${alice.address}/rescue/now`, undefined, a.session)).toMatchObject({ status: 429 });

    // an alert, answered with a rescue: the same rescue, and the alert shows how it was answered
    s.tick(61);
    s.store.addEvent({ wallet: alice.address, signature: "sigT", slot: 1, at: s.now(), level: "urgent", signals: ["taken_by_permission"], sentence: "x", rescueWorthy: true });
    const alert = s.store.events(alice.address).find((e) => e.signature === "sigT")!;
    s.answers({ ok: true, vault: VAULT.address, steps: [] });
    expect(await s.call("POST", `/v1/events/${alert.id}/answer`, { answer: "rescue" }, a.session)).toEqual({ status: 200, body: { ok: true, vault: VAULT.address, moved: 0, failed: 0, signatures: [] } });
    expect(s.store.events(alice.address).find((e) => e.signature === "sigT")!.answer).toBe("rescue");
    // nothing was there to move, so nothing more was said or recorded
    expect(s.told).toHaveLength(1);
    expect(s.store.events(alice.address).filter((e) => e.signals.includes("rescued"))).toHaveLength(1);

    // a rescue the chain refused, or could not be asked for, is said as that and the alert stays unanswered
    s.tick(61);
    s.store.addEvent({ wallet: alice.address, signature: "sigU", slot: 2, at: s.now(), level: "urgent", signals: ["taken_by_permission"], sentence: "y", rescueWorthy: true });
    const second = s.store.events(alice.address).find((e) => e.signature === "sigU")!;
    s.answers({ ok: false, why: "this wallet is not armed." });
    expect(await s.call("POST", `/v1/events/${second.id}/answer`, { answer: "rescue" }, a.session)).toEqual({ status: 409, body: { error: "this wallet is not armed." } });
    s.tick(61);
    s.answers(new Error("down"));
    expect(await s.call("POST", `/v1/events/${second.id}/answer`, { answer: "rescue" }, a.session)).toEqual({ status: 502, body: { error: "the chain could not be reached, so nothing was moved. Try again." } });
    expect(s.store.events(alice.address).find((e) => e.signature === "sigU")!.answer).toBeUndefined();
    // and it cannot be asked for without end
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await s.call("POST", `/v1/wallets/${alice.address}/rescue/now`, undefined, a.session)).status;
    expect(last).toBe(429);
    expect((await s.call("POST", `/v1/wallets/${alice.address}/rescue/now`, undefined, a.session)).body).toEqual({ error: "too many requests. Wait a minute and try again." });
  });

  it("rescues unasked only for an owner who switched that on, and the channels hear when the switch is turned", async () => {
    const s = service();
    const a = await s.signIn(alice);
    s.accounts.setTier(a.profile.id, "pro");
    const delegate = s.chain.arm(alice.key, VAULT.address);
    await s.rescue.sync([alice.address]);
    expect(s.store.wallets()[0]!.sentinelDelegate).toBe(delegate);
    s.noticed.length = 0;
    const alert = { wallet: alice.address, signature: "sigT", slot: 1, at: s.now(), level: "urgent" as const, signals: ["taken_by_permission" as const], sentence: "x", rescueWorthy: true };
    expect(await s.rescue.after(alert)).toBe(false);
    expect(await s.call("POST", "/v1/rescue/auto", { on: "yes" }, a.session)).toMatchObject({ status: 400 });
    expect(await s.call("POST", "/v1/rescue/auto", { on: true }, a.session)).toEqual({ status: 200, body: { auto: true } });
    expect(s.noticed).toEqual([[a.profile.id, `Rescue without asking was switched on for your Sentinel profile, by someone signed in with ${alice.address.slice(0, 4)}..${alice.address.slice(-4)}. From now on, when an alert is serious enough on its own, Sentinel moves the tokens of your armed wallets into your Lamport Vault at once and tells you afterwards. If that was not you, someone else has the key to ${alice.address.slice(0, 4)}..${alice.address.slice(-4)}.`]]);
    // said once, not every time the box is ticked again
    await s.call("POST", "/v1/rescue/auto", { on: true }, a.session);
    expect(s.noticed).toHaveLength(1);
    expect((await s.call("GET", "/v1/rescue", undefined, a.session)).body).toMatchObject({ auto: true });
    // an alert that is not reason enough: nothing. One that is: the rescue, and the sentence says what set it off
    expect(await s.rescue.after({ ...alert, rescueWorthy: false })).toBe(false);
    expect(s.rescued).toEqual([]);
    expect(await s.rescue.after(alert)).toBe(true);
    expect(s.rescued).toEqual([alice.address]);
    expect(s.told[0]![1]).toMatch(/^After the alert before this one, Sentinel moved 2 of this wallet's token accounts into your Lamport Vault/);
    // a wallet that is not known to be set up is not rescued, and the chain is not asked on its account
    const b = await s.signIn(bob);
    s.accounts.setTier(b.profile.id, "pro");
    s.accounts.setAutoRescue(b.profile.id, true);
    expect(await s.rescue.after({ ...alert, wallet: bob.address })).toBe(false);
    // a plan that ended takes rescue with it; the switch stays where the owner left it, and can always be turned off
    s.tick(61);
    s.accounts.setTier(a.profile.id, "watch");
    expect(await s.rescue.after(alert)).toBe(false);
    expect(await s.call("POST", "/v1/rescue/auto", { on: false }, a.session)).toEqual({ status: 200, body: { auto: false } });
    expect(s.noticed.at(-1)![1]).toMatch(/^Rescue without asking was switched off for your Sentinel profile/);
    expect(s.rescued).toEqual([alice.address]);
  });

  it("keeps the record in step with the chain: a setup made or taken away anywhere is noticed, and one that is another wallet's is not believed", async () => {
    const s = service();
    const a = await s.signIn(alice), b = await s.signIn(bob);
    await s.rescue.sync([alice.address, bob.address]);
    expect(s.noticed).toEqual([]);
    // made somewhere else than this page: the owner hears, because a setup they did not make is a theft being prepared
    const delegate = s.chain.arm(alice.key, OTHER_VAULT.address);
    // and at bob's address, a config that names alice as its owner: it says nothing about bob
    s.chain.accounts.set(configAddress(bob.key).toBase58(), { owner: PROGRAM.toBase58(), data: configData(alice.key, VAULT.address) });
    await s.rescue.sync([alice.address, bob.address]);
    expect(s.store.wallets().map((w) => w.sentinelDelegate)).toEqual([delegate, undefined]);
    expect(s.noticed.map((n) => n[0])).toEqual([a.profile.id]);
    expect(s.noticed[0]![1]).toContain(`is set up for rescue into the Lamport Vault ${OTHER_VAULT.address.slice(0, 4)}..`);
    // an account at the right address that the rescue program does not own is nothing
    s.chain.accounts.set(configAddress(bob.key).toBase58(), { owner: TOKEN.toBase58(), data: configData(bob.key, VAULT.address) });
    await s.rescue.sync([alice.address, bob.address]);
    expect(s.store.wallets()[1]!.sentinelDelegate).toBeUndefined();
    // taken away
    s.chain.accounts.delete(configAddress(alice.key).toBase58());
    await s.rescue.sync([alice.address, bob.address]);
    expect(s.store.wallets()[0]!.sentinelDelegate).toBeUndefined();
    expect(s.noticed.at(-1)).toEqual([a.profile.id, `The wallet ${alice.address.slice(0, 4)}..${alice.address.slice(-4)} is no longer set up for rescue. If that was not you, someone else has the key to that wallet.`]);
    expect(s.noticed).toHaveLength(2);
    expect(b.profile.id).not.toBe(a.profile.id);
  });

  it("taking a setup away is the owner's on any plan, and tells the watcher the permissions going is their doing", async () => {
    const s = service();
    const a = await s.signIn(alice);
    const delegate = s.chain.arm(alice.key, VAULT.address);
    s.chain.tokens.set(alice.address, [{ pubkey: tokenAccount(1), mint: mint(1), amount: "0", decimals: 6, delegate }, { pubkey: tokenAccount(2), mint: mint(2), amount: "4", decimals: 0, delegate: bob.address }]);
    const built = (await s.call("POST", `/v1/wallets/${alice.address}/rescue/disarm`, undefined, a.session)).body as any;
    // The permission given for rescue is revoked, and a permission given to anyone else is not touched. Then the
    // setup is closed, in a transaction with nothing else in it: that is the only shape of a closing Warden lets through.
    const txs = (built.transactions as string[]).map((t) => Transaction.from(Buffer.from(t, "base64")));
    expect(txs.map((tx) => tx.instructions.map((ix) => [ix.programId.toBase58(), ix.keys[0]!.pubkey.toBase58()]))).toEqual([[[TOKEN.toBase58(), tokenAccount(1)]], [[PROGRAM.toBase58(), alice.address]]]);
    expect(txs[0]!.instructions[0]!.data).toEqual(Buffer.from([5])); // Revoke
    expect(txs.every((tx) => tx.feePayer!.toBase58() === alice.address && tx.signatures.every((sig) => sig.signature === null))).toBe(true);
    const w = s.store.wallets()[0]!;
    expect(disarmingNow(w, s.now())).toBe(true);
    expect(disarmingNow(w, s.now() + CHANGE_SECONDS)).toBe(false);

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
  const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

  it("the setup, the tokens that came later, and taking it away, each in a shape Warden knows", async () => {
    const s = service();
    const a = await s.signIn(alice);
    s.accounts.setTier(a.profile.id, "pro");
    // more token accounts than one transaction carries
    s.chain.tokens.set(alice.address, Array.from({ length: 8 }, (_, i) => ({ pubkey: tokenAccount(i + 1), mint: mint(i + 1), amount: String(100 - i), decimals: 0, ...(i % 2 ? { program: TOKEN_2022.toBase58() } : {}) })));
    const built = (await s.call("POST", `/v1/wallets/${alice.address}/rescue/arm`, { vault: VAULT.address }, a.session)).body as any;
    expect(built.transactions).toHaveLength(2);
    const first = wardenOn(built.transactions[0]);
    expect(first).toMatchObject({ kind: "verdict", after: { vault: VAULT.address }, verdict: { level: "confirm", confirm: { kind: "last4", expect: VAULT.address.slice(-4) }, sentence: `Sets up Warden Sentinel for this wallet. In a rescue, your tokens can go only to the Lamport Vault ${short(VAULT.address)}. It arms 6 token accounts. Changing that vault later takes 72 hours.` } });
    // the rest of the approvals, once this browser has seen the setup
    expect(wardenOn(built.transactions[1], { vault: VAULT.address })).toMatchObject({ kind: "verdict", verdict: { level: "explain", sentence: `Arms 2 token accounts for Warden Sentinel: it may move them into your Lamport Vault ${short(VAULT.address)}, and nowhere else.` } });

    // set up; a token arrives; covering it is approvals alone
    const delegate = s.chain.arm(alice.key, VAULT.address);
    for (const t of s.chain.tokens.get(alice.address)!) t.delegate = delegate;
    s.chain.tokens.get(alice.address)!.push({ pubkey: tokenAccount(20), mint: mint(20), amount: "3", decimals: 0 });
    const more = (await s.call("POST", `/v1/wallets/${alice.address}/rescue/arm`, { vault: VAULT.address }, a.session)).body as any;
    expect(more.transactions).toHaveLength(1);
    expect(wardenOn(more.transactions[0], { vault: VAULT.address })).toMatchObject({ verdict: { level: "explain", sentence: expect.stringContaining("Arms 1 token account for Warden Sentinel") } });

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
    const bad = configFrom({ ...base, SENTINEL_RESCUER_KEY: "hunter2-not-a-key" });
    expect(bad).toEqual({ ok: false, why: "SENTINEL_RESCUER_KEY has to be a keypair as solana-keygen writes it (a list of 64 numbers), or those 64 bytes in base64." });
    expect(JSON.stringify(bad)).not.toContain("hunter2");
  });
});
