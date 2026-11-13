/**
 * "This signature was mine": what the extension reads out of a wallet's answer, what it takes as proof, and
 * what it sends. Real signatures throughout: the proof is the point.
 */
import "../src/polyfill.js";
import { describe, it, expect } from "vitest";
import { createPrivateKey, sign } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { SENTINEL_API } from "../src/defaults.js";
import { fromBase58, signaturesInTransaction, signaturesOf, toBase58 } from "../src/intercept.js";
import { reportOwnSignature, type ReportDeps } from "../src/report.js";
import { fromSentinelPage, linkFrom, linkKey, readPageAsk } from "../src/sentinel-link.js";
import { DEFAULTS, settingsFrom } from "../src/settings.js";
import { splitTransaction } from "../pincer1/daemon/src/tx/parse.js";

const owner = Keypair.fromSeed(new Uint8Array(32).fill(7));
const sponsor = Keypair.fromSeed(new Uint8Array(32).fill(8));
const friend = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey;
const O = owner.publicKey.toBase58();
const BLOCKHASH = "9hH1wzXmQ6tFJVYxWmH1yh1MYTzF9HbVnR6JvQnfZz1x";
const TOKEN = "t".repeat(43);
/** An ed25519 signature by the key made from this seed byte. */
const signWith = (seed: number, message: Uint8Array) => new Uint8Array(sign(null, message, createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, seed)]), format: "der", type: "pkcs8" })));

/** A payment from the owner, signed as a wallet would sign it. */
function payment(opts: { feePayer?: Keypair; lamports?: number; sign?: Keypair[] } = {}) {
  const payer = opts.feePayer ?? owner;
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: BLOCKHASH }).add(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: friend, lamports: opts.lamports ?? 1_000_000 }));
  const unsigned = new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  tx.sign(...(opts.sign ?? (payer === owner ? [owner] : [payer, owner])));
  const signed = new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  const signers = payer === owner ? [O] : [payer.publicKey.toBase58(), O];
  return { tx, unsigned, signed, judged: { messageBytes: splitTransaction(unsigned).messageBytes, signers }, signatures: signaturesInTransaction(signed) };
}

function deps(over: Partial<ReportDeps> = {}) {
  const sent: { url: string; init: Parameters<ReportDeps["fetch"]>[1] }[] = [];
  const d: ReportDeps = {
    enabled: async () => true,
    link: async (w) => (w === O ? { token: TOKEN, linkedAt: 1 } : undefined),
    fetch: async (url, init) => { sent.push({ url, init }); return { ok: true, status: 202 }; },
    ...over,
  };
  return { d, sent };
}

describe("reading a wallet's answer", () => {
  it("base58 goes both ways", () => {
    const sig = payment().signatures[0]!;
    expect(fromBase58(toBase58(sig))).toEqual(sig);
    expect(toBase58(new Uint8Array([0, 0, 1]))).toBe("112");
    expect(toBase58(owner.publicKey.toBytes())).toBe(O);
    expect(toBase58(new Uint8Array(0))).toBe("");
  });

  it("finds the signatures in a signed transaction, legacy and versioned", () => {
    const p = payment();
    expect(p.signatures).toHaveLength(1);
    expect(p.signatures[0]).toEqual(new Uint8Array(p.tx.signature!));
    const two = payment({ feePayer: sponsor });
    expect(two.signatures.map((s) => toBase58(s))).toEqual(two.tx.signatures.map((s) => toBase58(new Uint8Array(s.signature!))));
    const v0 = new VersionedTransaction(new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: BLOCKHASH, instructions: [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: friend, lamports: 5 })] }).compileToV0Message());
    v0.sign([owner]);
    expect(signaturesInTransaction(v0.serialize())).toEqual([v0.signatures[0]]);
    // not a transaction
    expect(signaturesInTransaction(new Uint8Array(10))).toEqual([]);
    expect(signaturesInTransaction(new Uint8Array([200, ...new Uint8Array(100)]))).toEqual([]);
    expect(signaturesInTransaction(new Uint8Array([0, ...new Uint8Array(100)]))).toEqual([]);
  });

  it("reads every shape a wallet answers in", () => {
    const p = payment(), q = payment({ lamports: 2_000_000 });
    const sig = p.signatures[0]!, sigQ = q.signatures[0]!;
    // Wallet Standard: one output per input
    expect(signaturesOf([{ signedTransaction: p.signed }], 0, 1)).toEqual([sig]);
    expect(signaturesOf([{ signedTransaction: p.signed }, { signedTransaction: q.signed }], 1, 2)).toEqual([sigQ]);
    expect(signaturesOf([{ signature: sig }], 0, 1)).toEqual([sig]);
    // an injected provider: the transaction object back, or a base58 signature, or one object for many
    expect(signaturesOf(p.tx, 0, 1)).toEqual([sig]);
    expect(signaturesOf([p.tx, q.tx], 1, 2)).toEqual([sigQ]);
    expect(signaturesOf({ signature: toBase58(sig), publicKey: O }, 0, 1)).toEqual([sig]);
    expect(signaturesOf({ signatures: [toBase58(sig), toBase58(sigQ)], publicKey: O }, 1, 2)).toEqual([sigQ]);
    expect(signaturesOf(toBase58(sig), 0, 1)).toEqual([sig]);
    expect(signaturesOf(p.signed, 0, 1)).toEqual([sig]);
    // anything else proves nothing, and never throws
    for (const junk of [undefined, null, "ok", "sig", 7, {}, { signature: "sig" }, { signature: 5 }, [], [null], { signedTransaction: "x" }, { serialize: () => { throw new Error("no"); } }, { get signature() { throw new Error("trap"); } }]) expect(signaturesOf(junk, 0, 1)).toEqual([]);
    expect(signaturesOf({ signature: toBase58(sig) }, 1, 2)).toEqual([]); // one answer for two requests names neither
  });
});

describe("reporting", () => {
  it("sends the wallet and the transaction's signature, and nothing else, to the one fixed address", async () => {
    const p = payment();
    const { d, sent } = deps();
    expect(await reportOwnSignature(d, O, p.judged, p.signatures)).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${SENTINEL_API}/v1/report`);
    expect(sent[0]!.url).toBe("https://warden.lamportrobotics.com/sentinel/api/v1/report");
    expect(sent[0]!.init).toEqual({
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ wallet: O, signature: toBase58(p.signatures[0]!) }),
      credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", redirect: "error",
    });
  });

  it("sends nothing when it is off, or the wallet is not linked", async () => {
    const p = payment();
    const off = deps({ enabled: async () => false });
    expect(await reportOwnSignature(off.d, O, p.judged, p.signatures)).toBe("off");
    const other = deps({ link: async () => undefined });
    expect(await reportOwnSignature(other.d, O, p.judged, p.signatures)).toBe("unlinked");
    expect([...off.sent, ...other.sent]).toEqual([]);
    // off is the default, and stays off unless the stored value is exactly true
    expect(DEFAULTS.reportSigned).toBe(false);
    expect(settingsFrom({}).reportSigned).toBe(false);
    expect(settingsFrom({ reportSigned: "yes" }).reportSigned).toBe(false);
    expect(settingsFrom({ reportSigned: true }).reportSigned).toBe(true);
  });

  it("sends nothing it cannot prove", async () => {
    const p = payment(), other = payment({ lamports: 9_000_000_000 });
    const tries: [string, Parameters<typeof reportOwnSignature>[2], Uint8Array[]][] = [
      ["a signature over another transaction", p.judged, other.signatures],
      ["someone else's signature over this one", p.judged, [signWith(8, p.judged.messageBytes)]],
      ["an empty signature", p.judged, [new Uint8Array(64)]],
      ["no signature", p.judged, []],
      ["half a signature", p.judged, [p.signatures[0]!.slice(0, 32)]],
      ["a wallet that is not one of the signers", { messageBytes: p.judged.messageBytes, signers: [sponsor.publicKey.toBase58()] }, p.signatures],
      ["a transaction the wallet changed before signing", { ...p.judged, messageBytes: other.judged.messageBytes }, p.signatures],
    ];
    for (const [what, judged, signatures] of tries) {
      const { d, sent } = deps();
      expect(await reportOwnSignature(d, O, judged, signatures), what).toBe("unproven");
      expect(sent, what).toEqual([]);
    }
  });

  it("with a sponsor paying the fee, needs both signatures, and names the transaction by the first", async () => {
    const p = payment({ feePayer: sponsor });
    const { d, sent } = deps();
    expect(await reportOwnSignature(d, O, p.judged, p.signatures)).toBe("sent");
    expect(JSON.parse(sent[0]!.init.body)).toEqual({ wallet: O, signature: toBase58(p.signatures[0]!) });

    // the owner signed but the name is someone else's transaction: not sent
    const elsewhere = payment({ feePayer: sponsor, lamports: 5 });
    const forged = deps();
    expect(await reportOwnSignature(forged.d, O, p.judged, [elsewhere.signatures[0]!, p.signatures[1]!])).toBe("unproven");
    // the sponsor signed but the owner did not
    const half = payment({ feePayer: sponsor, sign: [sponsor] });
    expect(await reportOwnSignature(forged.d, O, half.judged, half.signatures)).toBe("unproven");
    // a lone signature (sign-and-send) cannot prove the owner's part when someone else pays
    expect(await reportOwnSignature(forged.d, O, p.judged, [p.signatures[0]!])).toBe("unproven");
    expect(forged.sent).toEqual([]);
  });

  it("Sentinel being away is never the owner's problem", async () => {
    const p = payment();
    expect(await reportOwnSignature(deps({ fetch: async () => ({ ok: false, status: 503 }) }).d, O, p.judged, p.signatures)).toBe("failed");
    expect(await reportOwnSignature(deps({ fetch: async () => { throw new TypeError("Failed to fetch"); } }).d, O, p.judged, p.signatures)).toBe("failed");
    // a browser without Ed25519 proves nothing
    expect(await reportOwnSignature(deps({ verify: async () => false }).d, O, p.judged, p.signatures)).toBe("unproven");
  });
});

describe("what the Sentinel page may ask", () => {
  it("three things, exactly", () => {
    expect(readPageAsk({ type: "hello" })).toEqual({ type: "hello" });
    expect(readPageAsk({ type: "link", wallet: O, token: TOKEN })).toEqual({ type: "link", wallet: O, token: TOKEN });
    expect(readPageAsk({ type: "unlink", wallet: O, token: "ignored" })).toEqual({ type: "unlink", wallet: O });
    for (const bad of [null, "hello", { type: "link", wallet: O }, { type: "link", wallet: O, token: "short" }, { type: "link", wallet: "not-an-address", token: TOKEN }, { type: "link", wallet: O, token: `${TOKEN}?x=1` }, { type: "report", wallet: O }, { type: "unlink" }, { type: "link", wallet: [O], token: TOKEN }]) expect(readPageAsk(bad), JSON.stringify(bad)).toBeNull();
  });

  it("and only from its own address, in the top frame", () => {
    const A = "https://warden.lamportrobotics.com";
    expect(fromSentinelPage(A, 0, A)).toBe(true);
    for (const [origin, frame] of [["https://warden.lamportrobotics.com.evil.example", 0], ["http://warden.lamportrobotics.com", 0], ["https://lamportrobotics.com", 0], ["", 0], [A, 1], [A, undefined], [`${A}/`, 0]] as const) expect(fromSentinelPage(origin, frame, A), `${origin} ${frame}`).toBe(false);
  });

  it("a stored link is read back only when it is whole", () => {
    expect(linkKey(O)).toBe(`sentinelLink:${O}`);
    expect(linkFrom({ token: TOKEN, linkedAt: 5 })).toEqual({ token: TOKEN, linkedAt: 5 });
    for (const bad of [undefined, null, {}, { token: TOKEN }, { token: "x", linkedAt: 5 }, "text"]) expect(linkFrom(bad)).toBeUndefined();
    expect(new PublicKey(O).toBase58()).toBe(O);
  });
});
