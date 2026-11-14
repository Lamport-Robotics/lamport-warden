/**
 * Lookup tables: a version 0 transaction names accounts by position in a table stored on chain. Warden reads
 * the table (its one network call) so it can say where the money goes, and says so when it could not.
 */
import "../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { judge, recordSigned, type Store } from "../src/judge.js";
import { TableReader, readAccount, tablesNeeded, type FetchLike } from "../src/rpc.js";
import { cleanOrigin, cleanRpcUrl, settingsFrom, DEFAULTS } from "../src/settings.js";
import { splitTransaction } from "../pincer1/daemon/src/tx/parse.js";
import type { MemoryState } from "../pincer1/daemon/src/warden/index.js";

const owner = Keypair.fromSeed(new Uint8Array(32).fill(7));
const friend = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey;
const OWNER = owner.publicKey.toBase58();
const TABLE = Keypair.fromSeed(new Uint8Array(32).fill(40)).publicKey;
const BLOCKHASH = "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x";
const RPC = "https://rpc.example";
const lookalike = (of: PublicKey) => new PublicKey(Buffer.from((BigInt("0x" + Buffer.from(of.toBytes()).toString("hex")) + 707281n * (1n << 80n)).toString(16).padStart(64, "0"), "hex"));

/** A payment whose destination is not in the transaction: it is entry `addresses.indexOf(to)` of the table. */
function payThroughTable(to: PublicKey, sol: number, addresses: PublicKey[]): Uint8Array {
  const table = new AddressLookupTableAccount({ key: TABLE, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, authority: undefined, addresses } });
  const message = new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: BLOCKHASH, instructions: [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: to, lamports: Math.round(sol * 1e9) })] }).compileToV0Message([table]);
  return new VersionedTransaction(message).serialize();
}

/** The account data of a lookup table as the chain stores it: 56 bytes of header, then the addresses. */
function tableAccount(addresses: PublicKey[]): string {
  const b = Buffer.alloc(56 + 32 * addresses.length);
  b.writeUInt32LE(1, 0);                       // account type: lookup table
  b.writeBigUInt64LE(2n ** 64n - 1n, 4);       // not deactivated
  b.writeBigUInt64LE(1n, 12);                  // last extended slot
  addresses.forEach((a, i) => b.set(a.toBytes(), 56 + 32 * i));
  return b.toString("base64");
}

/** An RPC that knows one table, and counts what it was asked. */
function rpc(addresses: PublicKey[] | null, opts: { owner?: string; fail?: boolean } = {}) {
  const calls: { url: string; keys: string[] }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, keys: body.params[0] });
    if (opts.fail) throw new Error("offline");
    return { ok: true, json: async () => ({ result: { value: body.params[0].map((k: string) => (k === TABLE.toBase58() && addresses ? { data: [tableAccount(addresses), "base64"], owner: opts.owner ?? "AddressLookupTab1e1111111111111111111111111" } : null)) } }) };
  };
  return { fetchImpl, calls };
}

function memoryStore() {
  const saved = new Map<string, MemoryState>();
  const store: Store = { load: async (o) => saved.get(o), save: async (o, s) => { saved.set(o, s); }, ringSites: async () => [] };
  return { store, saved };
}

describe("lookup tables", () => {
  const filler = [1, 2, 3].map((n) => Keypair.fromSeed(new Uint8Array(32).fill(60 + n)).publicKey);

  it("finds which tables a message reads, and how far into each", () => {
    const tx = payThroughTable(friend, 0.5, [...filler, friend]);
    const need = tablesNeeded(splitTransaction(tx).messageBytes);
    expect([...need]).toEqual([[TABLE.toBase58(), 3]]);
    expect(tablesNeeded(Uint8Array.of(1, 0, 1, 2, 3)).size).toBe(0); // a legacy message has none
  });

  it("says where the money goes once the table is read, and asks the RPC only once", async () => {
    const { store, saved } = memoryStore();
    const { fetchImpl, calls } = rpc([...filler, friend]);
    const reader = new TableReader(fetchImpl);
    const tables = (m: Uint8Array) => reader.forMessage(m, RPC);
    const first = await judge({ kind: "tx", bytes: payThroughTable(friend, 0.5, [...filler, friend]), owner: OWNER }, "https://shop.example", store, { tables });
    expect(first.verdict.sentence).toMatch(/Sends 0\.5 SOL to /);
    expect(first.verdict.sentence).toMatch(/You've never paid /);
    expect(first.verdict.sentence).not.toMatch(/could not read/);
    await recordSigned(first, store, 1_794_000_000);
    expect(saved.get(OWNER)!.counterparties[friend.toBase58()]!.timesPaid).toBe(1);
    await judge({ kind: "tx", bytes: payThroughTable(friend, 0.2, [...filler, friend]), owner: OWNER }, "https://shop.example", store, { tables });
    expect(calls).toEqual([{ url: RPC, keys: [TABLE.toBase58()] }]); // the second time, from what it already read
  });

  it("blocks a look-alike address hidden inside a table", async () => {
    const { store } = memoryStore();
    const fake = lookalike(friend);
    const good = new TableReader(rpc([...filler, friend]).fetchImpl);
    await recordSigned(await judge({ kind: "tx", bytes: payThroughTable(friend, 0.5, [...filler, friend]), owner: OWNER }, "https://shop.example", store, { tables: (m) => good.forMessage(m, RPC) }), store, 1_794_000_000);
    const bad = new TableReader(rpc([...filler, fake]).fetchImpl);
    const v = await judge({ kind: "tx", bytes: payThroughTable(fake, 0.5, [...filler, fake]), owner: OWNER }, "https://evil.example", store, { tables: (m) => bad.forMessage(m, RPC) });
    expect(v.verdict.level).toBe("block");
    expect(v.verdict.reasons.join(" ")).toMatch(/address poisoning/);
  });

  it.each([
    ["the RPC is unreachable", () => rpc(null, { fail: true }).fetchImpl, RPC],
    ["the table does not exist there", () => rpc(null).fetchImpl, RPC],
    ["the account is not owned by the lookup table program", () => rpc([...filler, friend], { owner: "11111111111111111111111111111111" }).fetchImpl, RPC],
    ["the owner turned the call off", () => rpc([...filler, friend]).fetchImpl, ""],
  ])("never waves a transaction through when %s", async (_why, makeFetch, url) => {
    const { store, saved } = memoryStore();
    const reader = new TableReader(makeFetch());
    const v = await judge({ kind: "tx", bytes: payThroughTable(friend, 0.5, [...filler, friend]), owner: OWNER }, "https://shop.example", store, { tables: (m) => reader.forMessage(m, url) });
    expect(v.verdict.level).not.toBe("allow");
    expect(v.verdict.sentence).toMatch(/I could not read all of the accounts it uses\.$/);
    expect(v.verdict.reasons.join(" ")).toMatch(/lookup table I could not read/);
    await recordSigned(v, store, 1_794_000_000);
    expect(saved.get(OWNER)?.counterparties[friend.toBase58()]).toBeUndefined(); // an address it never saw is not learned
  });

  it("makes no call at all when the owner turned it off", async () => {
    const { fetchImpl, calls } = rpc([...filler, friend]);
    await new TableReader(fetchImpl).forMessage(splitTransaction(payThroughTable(friend, 0.5, [...filler, friend])).messageBytes, "");
    expect(calls).toEqual([]);
  });

  it("reads a table again when a transaction points past what it knows", async () => {
    let addresses = [...filler];
    const calls: string[][] = [];
    const fetchImpl: FetchLike = async (_url, init) => { const keys = JSON.parse(init.body).params[0]; calls.push(keys); return { ok: true, json: async () => ({ result: { value: [{ data: [tableAccount(addresses), "base64"], owner: "AddressLookupTab1e1111111111111111111111111" }] } }) }; };
    const reader = new TableReader(fetchImpl);
    await reader.forMessage(splitTransaction(payThroughTable(filler[2]!, 0.1, addresses)).messageBytes, RPC);
    addresses = [...filler, friend]; // the table grew
    const t = await reader.forMessage(splitTransaction(payThroughTable(friend, 0.1, addresses)).messageBytes, RPC);
    expect(calls).toHaveLength(2);
    expect(t[TABLE.toBase58()]).toHaveLength(4);
  });
});

describe("a request in a form Warden does not read", () => {
  it("is never silent and never claims to know: the owner must acknowledge it", async () => {
    const v = await judge({ kind: "opaque", bytes: new Uint8Array(0), owner: OWNER }, "https://shop.example", memoryStore().store);
    expect(v.verdict).toMatchObject({ level: "confirm", confirm: { kind: "acknowledge" } });
    expect(v.verdict.sentence).toMatch(/in a form I can't read/);
  });
});

describe("settings", () => {
  it("accepts only https RPCs, or http on this machine, and empty to turn the call off", () => {
    expect(cleanRpcUrl(" https://mainnet.helius-rpc.com/?api-key=abc ")).toBe("https://mainnet.helius-rpc.com/?api-key=abc");
    expect(cleanRpcUrl("http://localhost:8899")).toBe("http://localhost:8899/");
    expect(cleanRpcUrl("")).toBe("");
    expect(cleanRpcUrl("http://rpc.example")).toBeNull();
    expect(cleanRpcUrl("javascript:alert(1)")).toBeNull();
    expect(cleanRpcUrl("not a url")).toBeNull();
  });
  it("reads stored settings, with defaults for what is missing or malformed", () => {
    expect(settingsFrom({})).toEqual(DEFAULTS);
    expect(settingsFrom({ rpcUrl: "", ringSites: ["https://a.example", 5] })).toEqual({ rpcUrl: "", ringSites: ["https://a.example"], simulate: false, reportSigned: false });
    expect(settingsFrom({ simulate: true }).simulate).toBe(true);
    expect(settingsFrom({ simulate: "yes" }).simulate).toBe(false); // on only when it was turned on
    expect(settingsFrom({ rpcUrl: "ftp://x" }).rpcUrl).toBe(DEFAULTS.rpcUrl);
  });
  it("turns what a person types into an origin", () => {
    expect(cleanOrigin("app.example.com")).toBe("https://app.example.com");
    expect(cleanOrigin("https://app.example.com/some/page?x=1")).toBe("https://app.example.com");
    expect(cleanOrigin("")).toBeNull();
  });

  it("reads one account for the Sentinel page: what is there, nothing, or that the RPC could not say", async () => {
    const asked: any[] = [];
    const answering = (result: unknown, ok = true): FetchLike => async (_url, init) => { asked.push(JSON.parse(init.body)); return { ok, json: async () => ({ result }) }; };
    const data = Buffer.from([1, 2, 3]).toString("base64");
    expect(await readAccount("Addr", RPC, answering({ value: { owner: "Prog", data: [data, "base64"] } }))).toEqual({ owner: "Prog", data: Uint8Array.from([1, 2, 3]) });
    expect(asked[0]).toMatchObject({ method: "getAccountInfo", params: ["Addr", { encoding: "base64", commitment: "confirmed" }] });
    // not on the chain is an answer; no answer is not
    expect(await readAccount("Addr", RPC, answering({ value: null }))).toBeNull();
    await expect(readAccount("Addr", RPC, answering(undefined))).rejects.toThrow();
    await expect(readAccount("Addr", RPC, answering({ value: null }, false))).rejects.toThrow();
    await expect(readAccount("Addr", RPC, async () => { throw new Error("offline"); })).rejects.toThrow();
  });
});
